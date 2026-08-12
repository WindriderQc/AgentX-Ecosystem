#!/usr/bin/env node
/**
 * 0292 - Drop dead prompt workspaceId indexes.
 *
 * Core workspaces/auth were stripped, and PromptConfig/PromptTemplate no
 * longer carry workspaceId in the schema. These legacy indexes only add write
 * cost and can mislead future maintainers.
 *
 * Usage:
 *   node scripts/drop-prompt-workspace-indexes-0292.js
 *   node scripts/drop-prompt-workspace-indexes-0292.js --apply
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://mongo:27017/agentx';

const DEAD_INDEXES = [
  { collection: 'promptconfigs', name: 'workspaceId_1', key: { workspaceId: 1 } },
  { collection: 'promptconfigs', name: 'workspaceId_1_name_1_isActive_1', key: { workspaceId: 1, name: 1, isActive: 1 } },
  { collection: 'prompttemplates', name: 'workspaceId_1', key: { workspaceId: 1 } },
  { collection: 'prompttemplates', name: 'workspaceId_1_category_1', key: { workspaceId: 1, category: 1 } }
];

function keysEqual(a, b) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((key, index) => key === bk[index] && a[key] === b[key]);
}

function indexSignature(keyDoc) {
  return Object.entries(keyDoc).map(([key, value]) => `${key}:${value}`).join(', ');
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`Connecting to ${MONGODB_URI}...`);
  await mongoose.connect(MONGODB_URI);

  const grouped = new Map();
  for (const target of DEAD_INDEXES) {
    if (!grouped.has(target.collection)) grouped.set(target.collection, []);
    grouped.get(target.collection).push(target);
  }

  const summary = { dropped: [], skipped: [], failed: [] };

  for (const [collectionName, targets] of grouped.entries()) {
    const coll = mongoose.connection.db.collection(collectionName);
    const before = await coll.indexes();
    console.log(`\n${collectionName} indexes BEFORE (${before.length}):`);
    before.forEach((idx) => console.log(`  - ${idx.name}: {${indexSignature(idx.key)}}`));

    for (const target of targets) {
      const actual = before.find((idx) => idx.name === target.name || keysEqual(idx.key, target.key));
      if (!actual) {
        console.log(`  SKIP ${target.name} (not present)`);
        summary.skipped.push(`${collectionName}.${target.name}`);
        continue;
      }

      if (!apply) {
        console.log(`  WOULD DROP ${actual.name}`);
        continue;
      }

      try {
        await coll.dropIndex(actual.name);
        console.log(`  DROPPED ${actual.name}`);
        summary.dropped.push(`${collectionName}.${actual.name}`);
      } catch (err) {
        console.error(`  FAILED ${actual.name}: ${err.message}`);
        summary.failed.push({ collection: collectionName, name: actual.name, error: err.message });
      }
    }
  }

  if (!apply) {
    console.log('\nDRY RUN (pass --apply to actually drop).');
  }

  console.log('\nSummary:');
  console.log(JSON.stringify(summary, null, 2));
  await mongoose.connection.close();
  if (summary.failed.length) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
