'use strict';
const mongoose = require('mongoose');

/**
 * PinnedModelEntry — one "keep this model loaded" declaration on a host.
 * Replaces the old dual representation of `defaultModels`/`pinnedModel`
 * + top-level `keepAlive` / `contextSize` / `autoRestore`.
 *
 * The schema is strict; obsolete field names written by unsupported clients
 * are ignored.
 */
const PinnedModelEntrySchema = new mongoose.Schema({
  model: {
    type: String,
    required: true,
    trim: true
  },
  keepAlive: {
    type: Number,
    default: -1
  },
  contextSize: {
    type: Number,
    default: 0,
    min: 0
  },
  autoRestore: {
    type: Boolean,
    default: true
  }
}, { _id: false });

const HostPreferenceSchema = new mongoose.Schema({
  hostUrl: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },
  hostKey: {
    type: String,
    required: true,
    enum: ['primary', 'secondary', 'tertiary']
  },
  displayName: {
    type: String,
    default: ''
  },
  /**
   * pinnedModels — array of models to keep loaded on this host.
   * Supersedes legacy `defaultModels` + `pinnedModel`. See task 0151.
   */
  pinnedModels: {
    type: [PinnedModelEntrySchema],
    default: []
  },
  maxConcurrentModels: {
    type: Number,
    default: 1,
    min: 1
  },
  vramTotalMiB: {
    type: Number,
    default: 0,
    min: 0
  },
  vramReservedMiB: {
    type: Number,
    default: 0,
    min: 0
  },
  gpu: {
    model: { type: String, default: '' },
    computeCapability: { type: String, default: '' },
    driver: { type: String, default: '' }
  },
  tags: {
    type: [String],
    default: []
  },
  // Primary-loaded model hint, kept for back-compat with callers that only
  // care about "one model per host". New code should read loadedModels[] —
  // on multi-model hosts (for example, an inference + embedding model pair)
  // this scalar drops everything after the first running model.
  loadedModel: {
    type: String,
    default: null
  },
  loadedModels: {
    type: [String],
    default: []
  },
  status: {
    type: String,
    enum: ['ready', 'swapping', 'restoring', 'offline', 'idle', 'benchmarking'],
    default: 'idle'
  },
  // ── Benchmark coordination ─────────────────────────────────
  // When a benchmark batch claims a host, we stash the previous status
  // here so we can restore it when the batch finishes.
  benchmarkClaim: {
    batchId: { type: String, default: null },
    prevStatus: { type: String, default: null },
    claimedAt: { type: Date, default: null },
    estimatedDurationMs: { type: Number, default: null },
    source: { type: String, default: null },
    owner: { type: String, default: null },
    note: { type: String, default: null },
    heartbeatAt: { type: Date, default: null },
    heartbeatTtlMs: { type: Number, default: null }
  },
  // ── Pin auto-restore grace period (task 0176) ─────────────
  // Timestamp of the first reconciler tick that observed the pinned
  // model(s) displaced on this host. The reconciler sets this on the tick
  // that first sees a displacement and clears it once the pin is back
  // (either because someone reloaded it or because we restored it after
  // the grace period elapsed). The grace itself is `PIN_RESTORE_GRACE_MS`
  // (env-driven, default 120_000ms / 2 minutes); the reconciler waits for
  // `now - pinFirstDisplacedAt >= PIN_RESTORE_GRACE_MS` before warming the
  // pin again. This protects active chat / profiler / unrelated callers
  // that legitimately swapped the pin out — the 0175 claim check fires
  // first for benchmark batches, the grace then catches everyone else.
  pinFirstDisplacedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true,
  collection: 'hostpreferences'
});

module.exports = mongoose.model('HostPreference', HostPreferenceSchema);
