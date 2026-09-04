/**
 * HostPerformanceSnapshot Model
 *
 * Stores point-in-time performance measurements for a model on a specific
 * Ollama host. Owned by the benchmark service — never writes to modelregistries.
 *
 * Collection: hostperformancesnapshots
 */

const mongoose = require('mongoose');

const HostPerformanceSnapshotSchema = new mongoose.Schema({
  authorityState: {
    type: String,
    enum: ['authoritative', 'authority_invalidated', 'pending_reconciliation'],
    default: 'authoritative',
    index: true
  },
  authorityReconciliationReason: { type: String, default: null },
  authorityWriteId: { type: String, default: null },
  authorityReconciliationId: { type: String, default: null },
  modelName:                { type: String, required: true, index: true },
  hostUrl:                  { type: String, required: true },
  hostId:                   String,
  tokensPerSec:             Number,
  promptEvalTokensPerSec:   Number,
  promptEvalDurationMs:     Number,
  latencyMs:                Number,
  timeToFirstTokenMs:       Number,
  ttftMeasurement:          { type: String, enum: ['streamed_wall_clock'], default: undefined },
  promptTokens:             Number,
  requestedPromptTokens:    Number,
  promptWorkloadMode:       String,
  completionTokens:         Number,
  vramUsedMiB:              Number,
  vramTotalMiB:             Number,
  numCtx:                   Number,
  observedNumCtx:           Number,
  numCtxSource:             String,
  source:                   { type: String, default: 'benchmark_host_test' },
  testedAt: {
    type:    Date,
    default: Date.now,
    index:   true
  },
  status: {
    type:    String,
    enum:    ['pass', 'fail', 'timeout', 'error'],
    default: 'pass'
  },
  error: String
});

HostPerformanceSnapshotSchema.index(
  { modelName: 1, hostUrl: 1, testedAt: -1 },
  { name: 'model_host_tested' }
);

module.exports = mongoose.model('HostPerformanceSnapshot', HostPerformanceSnapshotSchema);
