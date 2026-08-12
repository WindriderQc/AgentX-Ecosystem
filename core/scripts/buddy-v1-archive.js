#!/usr/bin/env node

// Snapshot the highest-totalReactions Buddy doc into the singleton's v1Origin
// field for sentimental continuity. Idempotent: re-runs are no-ops unless
// --force is passed. Does not delete any existing docs.
//
// Usage:
//   node scripts/buddy-v1-archive.js          # idempotent run
//   node scripts/buddy-v1-archive.js --force  # overwrite existing v1Origin

require('dotenv').config();
const mongoose = require('mongoose');
const Buddy = require('../models/Buddy');

const SINGLETON_SEED = 'global';
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://mongo:27017/agentx';

async function main() {
  const force = process.argv.includes('--force');

  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('Connected.');

  try {
    const existing = await Buddy.findOne({ seed: SINGLETON_SEED });
    if (existing && existing.v1Origin && !force) {
      console.log('Singleton already has v1Origin populated. Skipping (pass --force to overwrite).');
      console.log('  singleton _id:', existing._id.toString());
      console.log('  v1Origin.name:', existing.v1Origin.name);
      console.log('  v1Origin.originalSeed:', existing.v1Origin.originalSeed);
      return;
    }

    const source = await Buddy.findOne({ seed: { $ne: SINGLETON_SEED } })
      .sort({ totalReactions: -1, totalPets: -1 })
      .lean();

    if (!source) {
      console.log('No source buddy docs found. Nothing to archive.');
      return;
    }

    const snapshot = {
      name: source.name || '',
      species: source.species || '',
      rarity: source.rarity || 'common',
      soul: source.soul || '',
      milestones: source.milestones || [],
      stats: source.stats || {},
      totalReactions: source.totalReactions || 0,
      totalPets: source.totalPets || 0,
      snapshotAt: new Date(),
      originalSeed: source.seed,
    };

    const updated = await Buddy.findOneAndUpdate(
      { seed: SINGLETON_SEED },
      {
        $set: { v1Origin: snapshot, version: 2 },
        $setOnInsert: { mood: 'neutral' },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    console.log('--- v1 Archive Summary ---');
    console.log('  source seed:        ', snapshot.originalSeed);
    console.log('  source name:        ', snapshot.name);
    console.log('  totalReactions:     ', snapshot.totalReactions);
    console.log('  totalPets:          ', snapshot.totalPets);
    console.log('  milestones:         ', (snapshot.milestones || []).length);
    console.log('  singleton _id:      ', updated._id.toString());
    console.log('  singleton version:  ', updated.version);
    console.log('  forced overwrite:   ', force ? 'yes' : 'no');
  } finally {
    await mongoose.disconnect();
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
