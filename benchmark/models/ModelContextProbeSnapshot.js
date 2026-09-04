/**
 * ModelContextProbeSnapshot Model
 *
 * Stores benchmark-owned empirical context probe runs for a model on a host.
 * This replaces the need for benchmark to write context-test state back into
 * core-owned modelregistries documents.
 */

const mongoose = require('mongoose');

const ProbeSampleSchema = new mongoose.Schema({
  requestSucceeded: Boolean,
  tokensPerSec: Number,
  promptTokens: Number,
  estimatedPromptTokens: Number,
  promptCoveragePct: Number,
  completionTokens: Number,
  latencyMs: Number,
  vramUsedMiB: Number,
  vramTotalMiB: Number,
  gpuPercent: Number,
  gpuSizeTotal: Number,
  gpuSizeVram: Number,
  ollamaContextLength: Number,
  passed: Boolean,
  reason: String
}, { _id: false });

const ProbeStepSchema = new mongoose.Schema({
  numCtx: Number,
  requestSucceeded: Boolean,
  tokensPerSec: Number,
  promptTokens: Number,
  estimatedPromptTokens: Number,
  promptCoveragePct: Number,
  minimumPromptCoveragePct: Number,
  repetitionCount: Number,
  tokensPerSecMin: Number,
  tokensPerSecMax: Number,
  tokensPerSecStdDev: Number,
  tokensPerSecCvPct: Number,
  throughputStatistics: { type: mongoose.Schema.Types.Mixed, default: null },
  samples: { type: [ProbeSampleSchema], default: [] },
  completionTokens: Number,
  vramUsedMiB: Number,
  vramTotalMiB: Number,
  gpuPercent: Number,
  gpuSizeTotal: Number,
  gpuSizeVram: Number,
  ollamaContextLength: Number,
  latencyMs: Number,
  promptFillPct: Number,
  requestedCompletionTokens: Number,
  minCompletionTokens: Number,
  passed: Boolean,
  degradationPct: Number,
  reason: String
}, { _id: false });

const ModelContextProbeSnapshotSchema = new mongoose.Schema({
  modelName:              { type: String, required: true, index: true },
  hostUrl:                { type: String, required: true, index: true },
  hostId:                 { type: String, required: true, index: true },
  artifactDigest:         { type: String, required: true, index: true },
  runtimeFingerprint:     { type: String, required: true },
  profileDepth:           { type: String, enum: ['quick', 'standard', 'full'], default: 'standard' },
  candidateRepeats:       { type: Number, default: 2 },
  testedNumCtx:           Number,
  baselineTokensPerSec:   Number,
  atLimitTokensPerSec:    Number,
  degradationPct:         Number,
  degradationThreshold:   Number,
  interactiveDegradationThreshold: Number,
  documentDegradationThreshold: Number,
  performanceKneeDegradationThreshold: Number,
  recommendedInteractiveContext: Number,
  recommendedDocumentContext: Number,
  performanceKneeContext: Number,
  qualityVerifiedContext: { type: Number, default: null },
  qualityContextStatus: { type: String, enum: ['verified', 'unknown'], default: 'unknown' },
  promptFillPct:          Number,
  vramAtLimitMiB:         Number,
  gpuPercentAtLimit:      Number,
  modelTheoreticalMax:    Number,
  resolutionSeedNumCtx:   Number,
  resolutionSeedSource:   String,
  testDurationMs:         Number,
  testedAt: {
    type:    Date,
    default: Date.now,
    index:   true
  },
  status: {
    type:    String,
    enum:    ['running', 'completed', 'failed'],
    default: 'completed'
  },
  error: String,
  authorityStatus: {
    type: String,
    enum: ['pending', 'committed', 'rejected'],
    default: 'pending'
  },
  authorityError: { type: String, default: null },
  authorityWriteId: { type: String, default: null, index: true },
  authorityReconciliationId: { type: String, default: null },
  steps: {
    type:    [ProbeStepSchema],
    default: []
  }
}, {
  collection: 'modelcontextprobesnapshots'
});

ModelContextProbeSnapshotSchema.index(
  { modelName: 1, hostUrl: 1, artifactDigest: 1, testedAt: -1 },
  { name: 'model_context_probe_latest' }
);

module.exports = mongoose.model('ModelContextProbeSnapshot', ModelContextProbeSnapshotSchema);
