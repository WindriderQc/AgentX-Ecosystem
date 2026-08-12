const mongoose = require('mongoose');

const ReadinessSchema = new mongoose.Schema({
  stage: {
    type: String,
    enum: ['available', 'profiled', 'adapted', 'benchmarked'],
    default: 'available'
  },
  profiledAt: Date,
  adaptedAt: Date,
  benchmarkedAt: Date,
  stale: { type: Boolean, default: false }
}, { _id: false });

const HostAvailabilitySchema = new mongoose.Schema({
  available: { type: Boolean, default: false },
  lastSeen: Date
}, { _id: false });

const BenchmarkStatsSchema = new mongoose.Schema({
  bestCategory: { type: String, default: null },
  worstCategory: { type: String, default: null },
  avgCompositeScore: { type: Number, default: null },
  avgQualityScore: { type: Number, default: null },
  totalTests: { type: Number, default: 0 },
  lastBenchmarked: { type: Date, default: null }
}, { _id: false });

const ThinkingCapabilitySchema = new mongoose.Schema({
  profileVersion: Number,
  profiledAt: Date,
  hostId: String,
  probeCount: Number,
  probeAttempts: Number,
  retryProbeCount: Number,
  maxProbeNumPredict: Number,
  defaultProbeNumPredict: Number,
  supported: { type: Boolean, default: false },
  supportSignals: [String],
  channel: {
    type: String,
    enum: ['hidden', 'visible_tags', 'mixed', 'none', 'unknown', 'error'],
    default: 'unknown'
  },
  visibleFinalAnswerOk: { type: Boolean, default: false },
  finalAnswerContractOk: { type: Boolean, default: false },
  thinkingOnlyResponse: { type: Boolean, default: false },
  runawayRisk: { type: Boolean, default: false },
  contractSensitive: { type: Boolean, default: false },
  contractlessVisibleAnswerOk: { type: Boolean, default: false },
  stressVisibleAnswerOk: { type: Boolean, default: false },
  tokenMultiplier: Number,
  latencyMultiplier: Number,
  recommendedPolicy: {
    type: String,
    enum: ['off', 'metered', 'on', 'disallowed', 'unknown'],
    default: 'unknown'
  },
  recommendationReason: String
}, { _id: false });

const ModelProfileSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, index: true },
  displayName: String,
  provider: String,
  family: String,
  parameters: String,
  quantization: String,
  capabilities: {
    maxContext: Number,
    vision: { type: Boolean, default: false },
    tools: { type: Boolean, default: false },
    thinking: { type: Boolean, default: false },
    thinkingPolicy: {
      type: String,
      enum: ['off', 'metered', 'on', 'disallowed', 'unknown'],
      default: 'unknown'
    }
  },
  thinkingProfiles: { type: Map, of: ThinkingCapabilitySchema, default: () => new Map() },
  hosts: { type: Map, of: HostAvailabilitySchema, default: () => new Map() },
  readiness: { type: Map, of: ReadinessSchema, default: () => new Map() },
  tags: { type: [String], default: [] },
  categories: { type: [String], default: [] },
  benchmarkStats: { type: BenchmarkStatsSchema, default: () => ({}) }
}, { collection: 'modelprofiles', timestamps: true });

module.exports = mongoose.model('ModelProfile', ModelProfileSchema);
