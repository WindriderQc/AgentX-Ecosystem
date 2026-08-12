#!/usr/bin/env node
/**
 * 0292 - Normalize PromptConfig duplicate versions and enforce the canonical
 * { name, version } unique index.
 *
 * The auth/workspace strip leaves PromptConfig as the persona authority. Live
 * data may still contain duplicate historical rows that prevent MongoDB from
 * creating the schema's unique name/version index.
 *
 * Usage:
 *   node scripts/normalize-promptconfig-unique-index-0292.js
 *   node scripts/normalize-promptconfig-unique-index-0292.js --apply
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://mongo:27017/agentx';
const PROMPT_COLLECTION = 'promptconfigs';
const ARCHIVE_COLLECTION = 'promptconfig_dedup_archives';
const UNIQUE_INDEX_NAME = 'name_version_unique';
const UNIQUE_KEY = { name: 1, version: 1 };

function indexSignature(keyDoc) {
  return Object.entries(keyDoc).map(([key, value]) => `${key}:${value}`).join(', ');
}

function keysEqual(a, b) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((key, index) => key === bk[index] && a[key] === b[key]);
}

function getTime(value) {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : 0;
}

function idString(doc) {
  return String(doc._id);
}

function chooseKeeper(docs) {
  return docs.slice().sort((a, b) => {
    const activeDelta = Number(Boolean(b.isActive)) - Number(Boolean(a.isActive));
    if (activeDelta !== 0) return activeDelta;

    const updatedDelta = getTime(b.updatedAt) - getTime(a.updatedAt);
    if (updatedDelta !== 0) return updatedDelta;

    const createdDelta = getTime(b.createdAt) - getTime(a.createdAt);
    if (createdDelta !== 0) return createdDelta;

    return idString(b).localeCompare(idString(a));
  })[0];
}

async function findDuplicateGroups(coll) {
  return coll.aggregate([
    {
      $group: {
        _id: { name: '$name', version: '$version' },
        count: { $sum: 1 },
        activeCount: { $sum: { $cond: ['$isActive', 1, 0] } },
        ids: { $push: '$_id' }
      }
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1, '_id.name': 1, '_id.version': 1 } }
  ]).toArray();
}

async function loadGroupDocs(coll, group) {
  return coll.find({
    name: group._id.name,
    version: group._id.version
  }).sort({ isActive: -1, updatedAt: -1, createdAt: -1, _id: -1 }).toArray();
}

async function archiveAndDeleteDuplicate({ archiveColl, promptColl, duplicate, keeper, key }) {
  const normalizedAt = new Date();
  await archiveColl.updateOne(
    { sourceCollection: PROMPT_COLLECTION, sourceId: duplicate._id },
    {
      $setOnInsert: {
        sourceCollection: PROMPT_COLLECTION,
        sourceId: duplicate._id,
        duplicateKey: key,
        keeperId: keeper._id,
        archivedDocument: duplicate,
        normalizedBy: 'normalize-promptconfig-unique-index-0292',
        normalizedAt
      }
    },
    { upsert: true }
  );

  return promptColl.deleteOne({ _id: duplicate._id });
}

async function ensureUniqueIndex(coll, apply, summary) {
  const indexes = await coll.indexes();
  const matchingKeyIndex = indexes.find((idx) => keysEqual(idx.key, UNIQUE_KEY));

  if (matchingKeyIndex?.unique) {
    console.log(`Unique index already present: ${matchingKeyIndex.name}`);
    summary.index = { status: 'already_present', name: matchingKeyIndex.name };
    return;
  }

  if (matchingKeyIndex && !matchingKeyIndex.unique) {
    if (!apply) {
      console.log(`WOULD REPLACE non-unique index ${matchingKeyIndex.name} with ${UNIQUE_INDEX_NAME}`);
      summary.index = { status: 'would_replace_non_unique', name: matchingKeyIndex.name };
      return;
    }

    console.log(`Dropping non-unique index ${matchingKeyIndex.name}`);
    await coll.dropIndex(matchingKeyIndex.name);
  }

  if (!apply) {
    console.log(`WOULD CREATE unique index ${UNIQUE_INDEX_NAME}: {${indexSignature(UNIQUE_KEY)}}`);
    summary.index = { status: 'would_create', name: UNIQUE_INDEX_NAME };
    return;
  }

  console.log(`Creating unique index ${UNIQUE_INDEX_NAME}: {${indexSignature(UNIQUE_KEY)}}`);
  const createdName = await coll.createIndex(UNIQUE_KEY, {
    name: UNIQUE_INDEX_NAME,
    unique: true,
    background: true
  });
  summary.index = { status: 'created', name: createdName };
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`Connecting to ${MONGODB_URI}...`);
  await mongoose.connect(MONGODB_URI);

  const promptColl = mongoose.connection.db.collection(PROMPT_COLLECTION);
  const archiveColl = mongoose.connection.db.collection(ARCHIVE_COLLECTION);

  const summary = {
    apply,
    duplicateGroups: 0,
    archivedAndDeleted: [],
    kept: [],
    index: null
  };

  const beforeIndexes = await promptColl.indexes();
  console.log(`\n${PROMPT_COLLECTION} indexes BEFORE (${beforeIndexes.length}):`);
  beforeIndexes.forEach((idx) => {
    const unique = idx.unique ? ' UNIQUE' : '';
    console.log(`  - ${idx.name}: {${indexSignature(idx.key)}}${unique}`);
  });

  const groups = await findDuplicateGroups(promptColl);
  summary.duplicateGroups = groups.length;

  if (groups.length === 0) {
    console.log('\nNo duplicate PromptConfig {name, version} groups found.');
  } else {
    console.log(`\nDuplicate PromptConfig groups (${groups.length}):`);
  }

  if (apply && groups.length > 0) {
    await archiveColl.createIndex(
      { sourceCollection: 1, sourceId: 1 },
      { name: 'source_collection_source_id_unique', unique: true, background: true }
    );
  }

  for (const group of groups) {
    const docs = await loadGroupDocs(promptColl, group);
    const keeper = chooseKeeper(docs);
    const duplicates = docs.filter((doc) => idString(doc) !== idString(keeper));
    const key = { name: group._id.name, version: group._id.version };

    console.log(`  - ${key.name} v${key.version}: count=${docs.length}, active=${group.activeCount}`);
    console.log(`    KEEP ${keeper._id} active=${Boolean(keeper.isActive)} updatedAt=${keeper.updatedAt || 'n/a'}`);
    summary.kept.push({ key, id: keeper._id, active: Boolean(keeper.isActive) });

    for (const duplicate of duplicates) {
      console.log(`    ${apply ? 'ARCHIVE+DELETE' : 'WOULD ARCHIVE+DELETE'} ${duplicate._id} active=${Boolean(duplicate.isActive)} updatedAt=${duplicate.updatedAt || 'n/a'}`);

      if (!apply) continue;

      const result = await archiveAndDeleteDuplicate({
        archiveColl,
        promptColl,
        duplicate,
        keeper,
        key
      });

      if (result.deletedCount !== 1) {
        throw new Error(`Expected to delete duplicate ${duplicate._id}, deleted ${result.deletedCount}`);
      }

      summary.archivedAndDeleted.push({ key, id: duplicate._id });
    }
  }

  const remainingGroups = apply ? await findDuplicateGroups(promptColl) : groups;
  if (apply && remainingGroups.length > 0) {
    console.error('\nDuplicate groups remain after normalization:');
    console.error(JSON.stringify(remainingGroups, null, 2));
    process.exitCode = 1;
  } else if (!apply && groups.length > 0) {
    console.log('\nDRY RUN: duplicate groups remain in live data until --apply is used.');
    await ensureUniqueIndex(promptColl, apply, summary);
  } else {
    console.log('\nNo duplicate PromptConfig {name, version} groups remain.');
    await ensureUniqueIndex(promptColl, apply, summary);
  }

  if (!apply) {
    console.log('\nDRY RUN (pass --apply to archive/delete duplicates and create the index).');
  }

  const afterIndexes = await promptColl.indexes();
  console.log(`\n${PROMPT_COLLECTION} indexes AFTER (${afterIndexes.length}):`);
  afterIndexes.forEach((idx) => {
    const unique = idx.unique ? ' UNIQUE' : '';
    console.log(`  - ${idx.name}: {${indexSignature(idx.key)}}${unique}`);
  });

  console.log('\nSummary:');
  console.log(JSON.stringify(summary, null, 2));
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error('Fatal:', err);
  try {
    await mongoose.connection.close();
  } catch (_) {
    // ignore close errors during failure handling
  }
  process.exit(1);
});
