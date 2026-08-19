/**
 * ModelContextProbeSnapshot Model
 *
 * Stores benchmark-owned empirical context probe runs for a model on a host.
 * This replaces the need for benchmark to write context-test state back into
 * core-owned modelregistries documents.
 */

const mongoose = require('mongoose');

const ProbeStepSchema = new mongoose.Schema({
  numCtx: Number,
  tokensPerSec: Number,
  promptTokens: Number,
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
  reason: String
}, { _id: false });

const ModelContextProbeSnapshotSchema = new mongoose.Schema({
  modelName:              { type: String, required: true, index: true },
  hostUrl:                { type: String, required: true, index: true },
  hostId:                 { type: String, required: true, index: true },
  artifactDigest:         { type: String, required: true, index: true },
  runtimeFingerprint:     { type: String, required: true },
  testedNumCtx:           Number,
  baselineTokensPerSec:   Number,
  atLimitTokensPerSec:    Number,
  degradationPct:         Number,
  degradationThreshold:   Number,
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
