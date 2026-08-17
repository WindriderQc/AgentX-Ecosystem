const mongoose = require('mongoose');

const buddySchema = new mongoose.Schema({
  seed: { type: String, required: true, unique: true, index: true },
  version: { type: Number, default: 2 },
  v1Origin: { type: mongoose.Schema.Types.Mixed, default: null },
  name: { type: String, default: '' },
  species: { type: String, default: '' },
  rarity: { type: String, default: 'common' },
  eyes: { type: String, default: '' },
  hat: { type: String, default: '' },
  pickedSpriteId: { type: String, default: '' },
  soul: { type: String, default: '' },
  stats: {
    DEBUGGING: { type: Number, default: 0 },
    PATIENCE: { type: Number, default: 0 },
    CHAOS: { type: Number, default: 0 },
    WISDOM: { type: Number, default: 0 },
    SNARK: { type: Number, default: 0 },
  },
  baseStats: { type: mongoose.Schema.Types.Mixed, default: {} },
  mood: { type: String, default: 'neutral' },
  moodHistory: [{
    type: { type: String },
    timestamp: { type: Date, default: Date.now },
  }],
  milestones: [{
    id: String,
    name: String,
    unlockedAt: { type: Date, default: Date.now },
  }],
  totalReactions: { type: Number, default: 0 },
  totalPets: { type: Number, default: 0 },
  modelsUsed: [String],
  // Phase 6f — Linkage
  personality: {
    source: { type: String, enum: ['standalone', 'agentx'], default: 'standalone' },
    agentId: { type: String, default: '' },
  },
  memory: {
    sources: { type: [String], default: [] },
    k: { type: Number, default: 5 },
  },
  model: {
    host: { type: String, default: '' },
    model: { type: String, default: '' },
  },
  // Phase 6g — per-task model config. Defaults are the fallback;
  // perTask entries override per route. Empty string = inherit defaults.
  brain: {
    defaults: {
      host:  { type: String, default: '' },
      model: { type: String, default: '' },
    },
    perTask: {
      chat:      { host: { type: String, default: '' }, model: { type: String, default: '' } },
      react:     { host: { type: String, default: '' }, model: { type: String, default: '' } },
      summarize: { host: { type: String, default: '' }, model: { type: String, default: '' } },
    },
  },
  // Phase 6g — explicit user-supplied facts injected into every system prompt.
  facts: {
    type: [{
      text:    { type: String, maxlength: 500 },
      addedAt: { type: Date, default: Date.now },
      weight:  { type: Number, default: 1.0, min: 0, max: 1 },
    }],
    default: [],
  },
}, { timestamps: true });

module.exports = mongoose.model('Buddy', buddySchema);
