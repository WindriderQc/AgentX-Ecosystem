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

  verifiedMaxContext: { type: Number, default: null },
  verifiedInputTokens: { type: Number, default: null },
  // Compatibility alias for older consumers. New writes keep this equal to
  // verifiedMaxContext; it is not a separately capped recommendation.
  recommendedContext: { type: Number, default: null },
  modelTheoreticalMax: { type: Number, default: null },
  source: { type: String, default: 'context_probe' },
  stale: { type: Boolean, default: false },
  staleReason: { type: String, default: null },
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
