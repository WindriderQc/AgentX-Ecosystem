/**
 * One-time migration: GpuSovereigntyConfig + HostVramOverride → HostPreference
 *
 * Usage: node scripts/migrate-sovereignty-to-preferences.js [--dry-run]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');

const HostPreference = require('../models/HostPreference');

// Map known IPs to host metadata (from SEED_SOVEREIGNTY_CONFIG)
const HOST_METADATA = {
  'http://192.0.2.99:11434': { hostKey: 'primary', displayName: 'Host Gamma', gpu: { model: '2x RTX 3090' }, vramTotalMiB: 49152 },
  'http://192.0.2.12:11434': { hostKey: 'secondary', displayName: 'Host Beta', gpu: { model: 'RTX 5070 Ti' }, vramTotalMiB: 16384 },
  'http://192.0.2.66:11434': { hostKey: 'tertiary', displayName: 'Host Delta', gpu: { model: 'RTX 3080 Ti (pending rebuild)' }, vramTotalMiB: 12288 }
};

function extractIp(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

async function migrate(dryRun) {
  await connectDB();
  console.log(`\n=== Migration: Sovereignty → Host Preferences ${dryRun ? '(DRY RUN)' : ''} ===\n`);

  // 1. Read old sovereignty configs directly from collection (models deleted)
  const db = mongoose.connection.db;
  const sovereignConfigs = await db.collection('gpusovereigntyconfigs').find().toArray();
  console.log(`Found ${sovereignConfigs.length} gpusovereigntyconfigs doc(s)`);

  // 2. Read old VRAM overrides directly from collection
  const vramOverrides = await db.collection('hostvramoverrides').find().toArray();
  const vramByIp = new Map(vramOverrides.map(v => [v.hostIp, v.vramMiB]));
  console.log(`Found ${vramOverrides.length} hostvramoverrides doc(s)`);

  // 3. Build HostPreference documents
  const preferences = [];
  for (const cfg of sovereignConfigs) {
    const meta = HOST_METADATA[cfg.hostUrl] || {};
    const ip = extractIp(cfg.hostUrl);
    const vramOverride = vramByIp.get(ip);

    preferences.push({
      hostUrl: cfg.hostUrl,
      hostKey: meta.hostKey || 'primary',
      displayName: meta.displayName || cfg.hostUrl,
      defaultModels: cfg.pinnedModels || [],
      maxConcurrentModels: cfg.maxLoadedModels || 1,
      keepAlive: -1,
      vramTotalMiB: vramOverride || meta.vramTotalMiB || 0,
      gpu: meta.gpu || {},
      tags: []
    });
  }

  // 4. Also create entries for hosts in HOST_METADATA that weren't in sovereignty
  for (const [url, meta] of Object.entries(HOST_METADATA)) {
    if (!preferences.find(p => p.hostUrl === url)) {
      const ip = extractIp(url);
      preferences.push({
        hostUrl: url,
        hostKey: meta.hostKey,
        displayName: meta.displayName,
        defaultModels: [],
        maxConcurrentModels: 1,
        keepAlive: -1,
        vramTotalMiB: vramByIp.get(ip) || meta.vramTotalMiB || 0,
        gpu: meta.gpu || {},
        tags: []
      });
    }
  }

  // 5. Print what we'd do
  for (const p of preferences) {
    console.log(`  → ${p.displayName} (${p.hostUrl}): defaults=[${p.defaultModels.join(', ')}], slots=${p.maxConcurrentModels}, vram=${p.vramTotalMiB} MiB`);
  }

  // 6. Upsert
  if (!dryRun) {
    for (const p of preferences) {
      await HostPreference.findOneAndUpdate(
        { hostUrl: p.hostUrl },
        { $set: p },
        { upsert: true, new: true }
      );
    }
    console.log(`\n✓ Migrated ${preferences.length} host preference(s)`);
  } else {
    console.log(`\n(dry run — no changes written)`);
  }

  await mongoose.connection.close();
}

const dryRun = process.argv.includes('--dry-run');
migrate(dryRun).catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
