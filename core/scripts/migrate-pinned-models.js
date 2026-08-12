/**
 * Task 0151 migration: unify `defaultModels` + `pinnedModel` into
 * a single `pinnedModels: [{ model, keepAlive, contextSize, autoRestore }]`
 * array on every HostPreference document.
 *
 * Idempotent: safe to re-run. If `pinnedModels` already has entries, the
 * script still ensures legacy fields get folded in (never overwrites an
 * existing pinnedModels entry).
 *
 * Non-destructive by default: leaves the legacy top-level fields
 * (`defaultModels`, `pinnedModel`, `keepAlive`, `contextSize`,
 * `autoRestore`) in place so a binary deployed mid-migration can still
 * read them through the service's `getPinnedEntries` fallback. Pass
 * `--drop-legacy` in a follow-up pass once all nodes are on the new
 * binary to $unset them.
 *
 * Usage:
 *   node scripts/migrate-pinned-models.js              # migrate, keep legacy fields
 *   node scripts/migrate-pinned-models.js --dry-run    # preview only
 *   node scripts/migrate-pinned-models.js --drop-legacy  # also $unset legacy fields
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');

async function migrate({ dryRun, dropLegacy }) {
  await connectDB();
  console.log(`\n=== Migration 0151: pinnedModels unification ${dryRun ? '(DRY RUN)' : ''}${dropLegacy ? ' [drop-legacy]' : ''} ===\n`);

  const db = mongoose.connection.db;
  const coll = db.collection('hostpreferences');
  const docs = await coll.find({}).toArray();
  console.log(`Found ${docs.length} hostpreferences doc(s)`);

  let updated = 0;
  let skipped = 0;
  let legacyDropped = 0;

  for (const doc of docs) {
    const displayName = doc.displayName || doc.hostUrl;
    const existing = Array.isArray(doc.pinnedModels) ? doc.pinnedModels : [];
    const existingNames = new Set(existing.map(e => e && e.model).filter(Boolean));

    const fallbackKeepAlive = Number.isFinite(doc.keepAlive) ? doc.keepAlive : -1;
    const fallbackContext = Number.isFinite(doc.contextSize) ? doc.contextSize : 0;
    const fallbackAutoRestore = doc.autoRestore !== false; // default true

    const merged = [...existing.map(e => ({
      model: e.model,
      keepAlive: e.keepAlive ?? fallbackKeepAlive,
      contextSize: e.contextSize ?? fallbackContext,
      autoRestore: e.autoRestore ?? fallbackAutoRestore
    }))];

    // Absorb legacy singleton `pinnedModel` (keep-alive semantics: -1)
    if (doc.pinnedModel && !existingNames.has(doc.pinnedModel)) {
      merged.push({
        model: doc.pinnedModel,
        keepAlive: -1,
        contextSize: fallbackContext,
        autoRestore: fallbackAutoRestore
      });
      existingNames.add(doc.pinnedModel);
    }

    // Absorb legacy `defaultModels` array
    if (Array.isArray(doc.defaultModels)) {
      for (const m of doc.defaultModels) {
        if (!m || existingNames.has(m)) continue;
        merged.push({
          model: m,
          keepAlive: fallbackKeepAlive,
          contextSize: fallbackContext,
          autoRestore: fallbackAutoRestore
        });
        existingNames.add(m);
      }
    }

    const before = {
      pinnedModel: doc.pinnedModel || null,
      defaultModels: Array.isArray(doc.defaultModels) ? doc.defaultModels : [],
      pinnedModels: existing,
      keepAlive: doc.keepAlive,
      contextSize: doc.contextSize,
      autoRestore: doc.autoRestore
    };

    const needsUpdate = (
      JSON.stringify(before.pinnedModels) !== JSON.stringify(merged) ||
      (dropLegacy && (doc.pinnedModel !== undefined || doc.defaultModels !== undefined ||
                      doc.keepAlive !== undefined || doc.contextSize !== undefined ||
                      doc.autoRestore !== undefined))
    );

    console.log(`\n  → ${displayName} (${doc.hostUrl}):`);
    console.log(`    before: defaultModels=[${(before.defaultModels || []).join(', ')}], pinnedModel=${before.pinnedModel ?? 'null'}, pinnedModels=${before.pinnedModels.length} entr${before.pinnedModels.length === 1 ? 'y' : 'ies'}`);
    console.log(`    after : pinnedModels=[${merged.map(m => `${m.model} (keepAlive=${m.keepAlive}, autoRestore=${m.autoRestore})`).join(' | ')}]`);

    if (!needsUpdate) {
      console.log('    (no changes needed)');
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log('    (dry run — not written)');
      continue;
    }

    const setOp = { pinnedModels: merged };
    const updateDoc = { $set: setOp };
    if (dropLegacy) {
      updateDoc.$unset = {
        pinnedModel: '',
        defaultModels: '',
        keepAlive: '',
        contextSize: '',
        autoRestore: ''
      };
      legacyDropped++;
    }

    await coll.updateOne({ _id: doc._id }, updateDoc);
    updated++;
  }

  console.log(`\nSummary: updated=${updated}, skipped=${skipped}, legacyDropped=${legacyDropped}${dryRun ? ' (dry run)' : ''}`);
  await mongoose.connection.close();
}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const dropLegacy = argv.includes('--drop-legacy');

migrate({ dryRun, dropLegacy }).catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
