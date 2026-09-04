const mongoose = require('mongoose');

const LatestEvidenceSchema = new mongoose.Schema({
  snapshotId: String,
  testedNumCtx: Number,
  promptFillPct: Number,
  promptTokens: Number,
  tokensPerSec: Number,
  vramUsedMiB: Number,
  gpuPercent: Number,
  degradationPct: Number,
  completionTokens: Number,
  requestedCompletionTokens: Number,
  minCompletionTokens: Number,
  testDurationMs: Number,
  testedAt: Date,
  source: String
}, { _id: false });

const ModelContextProfileSchema = new mongoose.Schema({
  modelName: { type: String, required: true, index: true },
  hostUrl: { type: String, required: true, index: true },
  hostId: { type: String, default: null, index: true },
  artifactDigest: { type: String, required: true, index: true },
  runtimeFingerprint: { type: String, required: true },

  maxVerifiedContext: { type: Number, default: null },
  // Backward-compatible alias for readers deployed before maxVerifiedContext.
  verifiedMaxContext: { type: Number, default: null },
  historicalMaxVerifiedContext: { type: Number, default: null },
  verifiedInputTokens: { type: Number, default: null },
  recommendedInteractiveContext: { type: Number, default: null },
  recommendedDocumentContext: { type: Number, default: null },
  // Highest measured context whose throughput degradation remains within the
  // explicitly persisted knee threshold. This is performance evidence, not a
  // model quality claim.
  performanceKneeContext: { type: Number, default: null },
  performanceKneeDegradationPct: { type: Number, default: 15 },
  // Only a separately qualified long-context Benchmark campaign may write
  // this field. Profiler probes deliberately persist null/unknown.
  qualityVerifiedContext: { type: Number, default: null },
  qualityContextStatus: {
    type: String,
    enum: ['verified', 'unknown'],
    default: 'unknown'
  },
  recommendationStatus: {
    type: String,
    enum: ['verified', 'unknown'],
    default: 'unknown'
  },
  recommendationEvidenceVersion: { type: String, default: null },
  revalidationRequired: { type: Boolean, default: true },
  recommendationThresholds: {
    interactiveDegradationPct: { type: Number, default: 15 },
    documentDegradationPct: { type: Number, default: 30 },
    performanceKneeDegradationPct: { type: Number, default: 15 }
  },
  // Compatibility alias: maps to the current document recommendation.
  recommendedContext: { type: Number, default: null },
  modelTheoreticalMax: { type: Number, default: null },
  source: { type: String, default: 'context_probe' },
  stale: { type: Boolean, default: false },
  staleReason: { type: String, default: null },
  // Durable tombstones for probe writes whose acknowledgement raced lease
  // loss. The guarded upsert refuses to publish any rejected snapshot later.
  rejectedEvidenceIds: { type: [String], default: [] },
  lastValidatedAt: { type: Date, default: null, index: true },
  latestEvidence: { type: LatestEvidenceSchema, default: () => ({}) }
}, {
  collection: 'modelcontextprofiles',
  timestamps: true
});

ModelContextProfileSchema.index(
  { modelName: 1, hostUrl: 1, artifactDigest: 1, runtimeFingerprint: 1 },
  { unique: true, name: 'exact_model_context_profile_unique' }
);

module.exports = mongoose.model('ModelContextProfile', ModelContextProfileSchema);
