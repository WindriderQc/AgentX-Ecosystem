#!/usr/bin/env node
/**
 * 0124 — Drop dead workspaceId-leading indexes on `conversations`.
 *
 * Workspace middleware was removed in 0112, so no live query passes
 * workspaceId as a filter. These indexes only incur write amplification.
 *
 * STAGED: drops one index at a time with a pause between each so an
 * operator can watch impact on the live service. If anything looks wrong,
 * cancel with Ctrl+C between stages — each drop is independent.
 *
 * After dropping, creates the replacement index `{ userId: 1, updatedAt: -1 }`
 * in background mode (this is the shape used by routes/history.js).
 *
 * Usage:
 *   node scripts/drop-workspace-indexes-0124.js              # dry run (default)
 *   node scripts/drop-workspace-indexes-0124.js --apply      # actually drop
 *   node scripts/drop-workspace-indexes-0124.js --apply --pause-ms=2000
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://mongo:27017/agentx';

// Index names we expect from the legacy schema declarations. Mongo auto-names
// them from their key pattern, e.g. `{workspaceId:1, createdAt:-1}` -> `workspaceId_1_createdAt_-1`.
const DEAD_INDEXES = [
  { name: 'workspaceId_1', key: { workspaceId: 1 } },                                         // single-field
  { name: 'workspaceId_1_createdAt_-1', key: { workspaceId: 1, createdAt: -1 } },
  { name: 'workspaceId_1_userId_1_createdAt_-1', key: { workspaceId: 1, userId: 1, createdAt: -1 } },
  { name: 'workspaceId_1_userId_1_tags_1', key: { workspaceId: 1, userId: 1, tags: 1 } },
  { name: 'workspaceId_1_userId_1_model_1_createdAt_-1', key: { workspaceId: 1, userId: 1, model: 1, createdAt: -1 } },
  { name: 'workspaceId_1_userId_1_ragUsed_1_createdAt_-1', key: { workspaceId: 1, userId: 1, ragUsed: 1, createdAt: -1 } },
  { name: 'workspaceId_1_userId_1_messages.feedback.rating_1', key: { workspaceId: 1, userId: 1, 'messages.feedback.rating': 1 } }
];

const REPLACEMENT_INDEX = {
  key: { userId: 1, updatedAt: -1 },
  options: { name: 'userId_updatedAt', background: true }
};

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const pauseArg = args.find(a => a.startsWith('--pause-ms='));
  const pauseMs = pauseArg ? parseInt(pauseArg.split('=')[1], 10) : 1500;
  return { apply, pauseMs };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function indexSignature(keyDoc) {
  return Object.entries(keyDoc).map(([k, v]) => `${k}:${v}`).join(', ');
}

function keysEqual(a, b) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    if (a[ak[i]] !== b[bk[i]]) return false;
  }
  return true;
}

async function main() {
  const { apply, pauseMs } = parseArgs();

  console.log(`Connecting to ${MONGODB_URI}...`);
  await mongoose.connect(MONGODB_URI);
  const coll = mongoose.connection.db.collection('conversations');

  const before = await coll.indexes();
  console.log(`\nIndexes BEFORE (${before.length}):`);
  for (const idx of before) {
    console.log(`  - ${idx.name}: {${indexSignature(idx.key)}}`);
  }

  if (!apply) {
    console.log('\nDRY RUN (pass --apply to actually drop).');
    console.log('\nWould drop (if present):');
    for (const target of DEAD_INDEXES) {
      const present = before.find(i => i.name === target.name || keysEqual(i.key, target.key));
      console.log(`  ${present ? '[x]' : '[ ]'} ${target.name}  {${indexSignature(target.key)}}${present ? ` (actual: ${present.name})` : ''}`);
    }
    console.log(`\nWould then create replacement: ${REPLACEMENT_INDEX.options.name} {${indexSignature(REPLACEMENT_INDEX.key)}} background:true`);
    await mongoose.connection.close();
    return;
  }

  console.log(`\nAPPLYING. Pause between stages: ${pauseMs}ms\n`);

  const dropped = [];
  const skipped = [];
  const failed = [];

  for (let i = 0; i < DEAD_INDEXES.length; i++) {
    const target = DEAD_INDEXES[i];
    const all = await coll.indexes();
    // Match by key shape (name can drift between Mongo versions).
    const actual = all.find(idx => keysEqual(idx.key, target.key));
    if (!actual) {
      console.log(`[${i + 1}/${DEAD_INDEXES.length}] SKIP ${target.name} (not present)`);
      skipped.push(target.name);
      continue;
    }
    console.log(`[${i + 1}/${DEAD_INDEXES.length}] DROP ${actual.name}  {${indexSignature(actual.key)}}`);
    try {
      await coll.dropIndex(actual.name);
      dropped.push(actual.name);
      console.log(`            OK`);
    } catch (err) {
      failed.push({ name: actual.name, error: err.message });
      console.error(`            FAIL: ${err.message}`);
      console.error('            Aborting further drops. Investigate before re-running.');
      break;
    }
    if (i < DEAD_INDEXES.length - 1) {
      await sleep(pauseMs);
    }
  }

  // Create replacement if not already there.
  const afterDrops = await coll.indexes();
  const existingReplacement = afterDrops.find(idx => keysEqual(idx.key, REPLACEMENT_INDEX.key));
  if (existingReplacement) {
    console.log(`\nReplacement index already present as "${existingReplacement.name}".`);
  } else {
    console.log(`\nCreating replacement index: ${REPLACEMENT_INDEX.options.name} {${indexSignature(REPLACEMENT_INDEX.key)}} background:true`);
    await coll.createIndex(REPLACEMENT_INDEX.key, REPLACEMENT_INDEX.options);
    console.log('  OK');
  }

  const after = await coll.indexes();
  console.log(`\nIndexes AFTER (${after.length}):`);
  for (const idx of after) {
    console.log(`  - ${idx.name}: {${indexSignature(idx.key)}}`);
  }

  console.log('\nSummary:');
  console.log(`  dropped: ${dropped.length}  -> ${JSON.stringify(dropped)}`);
  console.log(`  skipped: ${skipped.length}  -> ${JSON.stringify(skipped)}`);
  console.log(`  failed:  ${failed.length}   -> ${JSON.stringify(failed)}`);

  await mongoose.connection.close();
  if (failed.length > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
