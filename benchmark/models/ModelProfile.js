const mongoose = require('mongoose');

const ArtifactIdentitySchema = new mongoose.Schema({
  model: { type: String, required: true },
  hostId: { type: String, required: true },
  hostUrl: { type: String, required: true },
  digest: { type: String, required: true },
  runtimeFingerprint: { type: String, required: true },
  registryId: { type: String, default: null },
  registryDigest: { type: String, default: null },
  registryQualified: { type: Boolean, default: false }
}, { _id: false });

const AuthorityReceiptSchema = new mongoose.Schema({
  version: { type: Number, required: true },
  source: { type: String, enum: ['profiler_pipeline'], required: true },
  evidenceId: { type: String, default: null },
  digest: { type: String, required: true },
  issuedAt: { type: Date, required: true }
}, { _id: false });

const ReadinessSchema = new mongoose.Schema({
  stage: {
    type: String,
    enum: ['available', 'profiled', 'benchmarked'],
    default: 'available'
  },
  profiledAt: Date,
  profileDepth: { type: String, enum: ['quick', 'standard', 'full', null], default: null },
  benchmarkQualified: { type: Boolean, default: false },
  qualificationReason: { type: String, default: null },
  measurementReliability: {
    type: String,
    enum: ['unknown', 'low', 'medium', 'high', null],
    default: 'unknown'
  },
  benchmarkedAt: Date,
  stale: { type: Boolean, default: false },
  staleReason: { type: String, default: null },
  evidenceId: { type: mongoose.Schema.Types.ObjectId, default: null },
  authorityReceipt: { type: AuthorityReceiptSchema, default: null },
  artifact: { type: ArtifactIdentitySchema, default: null }
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
