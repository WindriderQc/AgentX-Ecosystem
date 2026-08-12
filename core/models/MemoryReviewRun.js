// MemoryReviewRun — one ecosystem memory-review run with embedded sanitized
// observations, synthesized candidates, and a full audit trail.
//
// Core-owned collection `memoryreviewruns` (see parent CLAUDE.md ownership
// table). Structured review state lives HERE, not in RAG: fuzzy recall is
// never the store of approval state. Raw transcripts never enter this model —
// observation text is a bounded, locally extracted durable claim.

const mongoose = require('mongoose');

const ObservationSchema = new mongoose.Schema({
  observationId: { type: String, required: true },   // obs-<contentHash[:16]>
  runtime: { type: String, required: true },
  host: { type: String, default: 'unknown-host' },
  agentOrProfile: { type: String, default: null },
  project: { type: String, default: null },
  sessionId: { type: String, default: '' },
  eventId: { type: String, default: '' },
  observedAt: { type: String, default: '' },
  trust: { type: String, required: true },
  taints: { type: [String], default: [] },
  text: { type: String, required: true, maxlength: 1300 },
  sourceRef: { type: String, default: '' },
  contentHash: { type: String, required: true },
  recurrence: {
    observationCount: { type: Number, default: 1 },
    sessions: { type: [String], default: [] },
    runtimes: { type: [String], default: [] },
  },
}, { _id: false });

const EvidenceSchema = new mongoose.Schema({
  observationId: { type: String, required: true },
  runtime: String,
  host: String,
  agentOrProfile: String,
  project: String,
  sessionId: String,
  eventId: String,
  observedAt: String,
  trust: String,
  sourceRef: String,
  contentHash: String,
  redactedExcerpt: { type: String, maxlength: 300 },
}, { _id: false });

const ConflictSchema = new mongoose.Schema({
  authority: { type: String, default: 'prior_review' },  // runtime|git|rag|local_memory|prior_review
  sourceRef: { type: String, default: '' },
  summary: { type: String, default: '', maxlength: 320 },
}, { _id: false });

const CandidateSchema = new mongoose.Schema({
  candidateId: { type: String, required: true },
  type: { type: String, required: true },
  statement: { type: String, required: true, maxlength: 520 },
  rationale: { type: String, default: '', maxlength: 520 },
  target: {
    kind: { type: String, required: true },
    runtime: { type: String, default: null },
    topic: { type: String, default: null },
  },
  evidence: { type: [EvidenceSchema], default: [] },
  recurrence: {
    observationCount: { type: Number, default: 0 },
    independentSessions: { type: Number, default: 0 },
    independentRuntimes: { type: Number, default: 0 },
  },
  confidence: { type: Number, default: 0 },
  score: { type: Number, default: 0 },
  conflicts: { type: [ConflictSchema], default: [] },
  risk: {
    secret: { type: Boolean, default: false },
    privacy: { type: String, default: 'none' },
    promptInjection: { type: Boolean, default: false },
    governance: { type: String, default: 'none' },
    staleness: { type: String, default: 'none' },
  },
  status: {
    type: String,
    enum: ['proposed', 'approved', 'rejected', 'edited', 'deferred', 'applying', 'applied', 'apply_failed'],
    default: 'proposed',
  },
  review: {
    by: { type: String, default: null },
    at: { type: Date, default: null },
    note: { type: String, default: null, maxlength: 1000 },
    editedStatement: { type: String, default: null, maxlength: 520 },
    editedTarget: {
      kind: { type: String, default: null },
      runtime: { type: String, default: null },
      topic: { type: String, default: null },
    },
  },
  apply: {
    adapter: { type: String, default: null },
    attemptId: { type: String, default: null },
    by: { type: String, default: null },
    startedAt: { type: Date, default: null },
    leaseUntil: { type: Date, default: null },
    attemptedAt: { type: Date, default: null },
    result: { type: String, default: null, maxlength: 2000 },
    rollbackRef: { type: String, default: null, maxlength: 400 },
  },
}, { _id: false });

const CollectorSchema = new mongoose.Schema({
  runtime: { type: String, required: true },
  host: { type: String, default: 'unknown-host' },
  agentOrProfile: { type: String, default: null },
  project: { type: String, default: null },
  watermarkBefore: { type: String, default: '' },
  watermarkAfter: { type: String, default: '' },
  sourceFilesSeen: { type: Number, default: 0 },
  sourceEventsSeen: { type: Number, default: 0 },
  eligibleObservations: { type: Number, default: 0 },
  rejectedObservations: { type: Number, default: 0 },
  rejectionCounts: { type: mongoose.Schema.Types.Mixed, default: {} },
  errors: { type: [String], default: [] },
  drift: { type: [String], default: [] },
  localDedupContext: { type: [String], default: [] },
  submittedBy: { type: String, default: null },
  submittedAt: { type: Date, default: null },
}, { _id: false, suppressReservedKeysWarning: true });

const AuditSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  event: { type: String, required: true },
  by: { type: String, default: 'system' },
  level: { type: String, enum: ['info', 'warn', 'error'], default: 'info' },
  candidateId: { type: String, default: null },
  detail: { type: String, default: '', maxlength: 1000 },
}, { _id: false });

const MemoryReviewRunSchema = new mongoose.Schema({
  runId: { type: String, required: true, unique: true },
  runKey: { type: String, required: true, index: true },
  schemaVersion: { type: Number, default: 1 },
  mode: { type: String, enum: ['shadow', 'review', 'apply'], default: 'shadow' },
  applyAuthorization: {
    by: { type: String, default: null },
    at: { type: Date, default: null },
  },
  status: {
    type: String,
    enum: ['collecting', 'synthesizing', 'ready_for_review', 'partially_reviewed', 'completed', 'failed'],
    default: 'collecting',
    index: true,
  },
  window: {
    from: { type: String, default: null },
    to: { type: String, default: null },
    timezone: { type: String, default: 'America/Toronto' },
  },
  completedAt: { type: Date, default: null },
  collectorVersion: { type: String, default: '' },
  promptVersion: { type: String, default: '' },
  model: {
    provider: { type: String, default: 'agentx-hermes-proxy' },
    model: { type: String, default: '' },
    temperature: { type: Number, default: 0 },
  },
  collectors: { type: [CollectorSchema], default: [] },
  observations: { type: [ObservationSchema], default: [] },
  candidates: { type: [CandidateSchema], default: [] },
  candidateCounts: { type: mongoose.Schema.Types.Mixed, default: {} },
  dedupContext: {
    ragMatches: { type: [mongoose.Schema.Types.Mixed], default: [] },
    priorCandidates: { type: [mongoose.Schema.Types.Mixed], default: [] },
    degraded: { type: Boolean, default: false },
    degradedReason: { type: String, default: null },
  },
  summary: { type: mongoose.Schema.Types.Mixed, default: {} },
  failure: {
    stage: { type: String, default: null },
    reason: { type: String, default: null, maxlength: 600 },
    retryable: { type: Boolean, default: true },
  },
  audit: { type: [AuditSchema], default: [] },
}, { timestamps: true });

MemoryReviewRunSchema.index({ createdAt: -1 });

MemoryReviewRunSchema.statics.getRecent = function getRecent(limit = 20) {
  return this.find({}, {
    runId: 1, runKey: 1, mode: 1, status: 1, window: 1, createdAt: 1,
    completedAt: 1, candidateCounts: 1, summary: 1, 'failure.stage': 1,
  }).sort({ createdAt: -1 }).limit(limit);
};

module.exports = mongoose.model('MemoryReviewRun', MemoryReviewRunSchema);
