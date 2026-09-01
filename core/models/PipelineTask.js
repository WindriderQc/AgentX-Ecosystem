const mongoose = require('mongoose');

// Product-owned task queue. External boards consume the bounded HTTP API.
const FeedbackSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  by: String,
  text: String,
}, { _id: false });

const AutomationBudgetSchema = new mongoose.Schema({
  maxDurationMs: { type: Number, required: true, min: 1 },
  maxAttempts: { type: Number, required: true, min: 1, max: 10 },
  maxCostNanodollars: { type: Number, required: true, min: 0 },
}, { _id: false });

const AutomationIntentSchema = new mongoose.Schema({
  schema: { type: String, required: true },
  mode: { type: String, enum: ['manual', 'review_only'], required: true },
  policyRef: { type: String, default: null },
  dataClassification: {
    type: String,
    enum: ['public', 'internal', 'confidential', 'restricted'],
    default: null,
  },
  operations: { type: [String], default: undefined },
  scope: { type: [String], default: undefined },
  lockKeys: { type: [String], default: undefined },
  executionProfile: { type: String, default: null },
  verificationProfile: { type: String, default: null },
  budgets: { type: AutomationBudgetSchema, default: undefined },
  humanGates: { type: [String], default: undefined },
  fingerprint: { type: String, required: true },
}, { _id: false });

const AutomationLeaseSchema = new mongoose.Schema({
  leaseId: { type: String, required: true },
  assignee: { type: String, required: true },
  acquiredAt: { type: Date, required: true },
  heartbeatAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  durationMs: { type: Number, required: true, min: 1 },
  attempt: { type: Number, required: true, min: 1 },
}, { _id: false });

const AutomationAttemptEvidenceSchema = new mongoose.Schema({
  schema: { type: String, required: true },
  verification: {
    status: { type: String, enum: ['passed', 'failed', 'unknown'], required: true },
    durationMs: { type: Number, min: 0, default: null },
    testsPassed: { type: Number, min: 0, default: null },
    testsFailed: { type: Number, min: 0, default: null },
  },
  changes: {
    filesChanged: { type: Number, min: 0, default: null },
    bytesChanged: { type: Number, min: 0, default: null },
  },
  usage: {
    durationMs: { type: Number, min: 0, default: null },
    costNanodollars: { type: Number, min: 0, default: null },
    costSource: { type: String, default: null },
    costEvidenceFingerprint: { type: String, default: null },
  },
  // This subdocument must retain the public field named `schema`. Mongoose's
  // primitive-array caster collides with that field name while validating an
  // explicit `failureCodes: []`, so preserve the already-normalized contract
  // value as Mixed and validate its exact safe shape here.
  failureCodes: {
    type: mongoose.Schema.Types.Mixed,
    default: () => [],
    validate: {
      validator: (value) => Array.isArray(value)
        && value.every((code) => typeof code === 'string'),
      message: 'failureCodes must be an array of strings',
    },
  },
  workerReceiptFingerprint: { type: String, default: null },
  source: { type: String, default: null },
}, { _id: false });

const AutomationAttemptSchema = new mongoose.Schema({
  leaseId: { type: String, required: true },
  assignee: { type: String, required: true },
  attempt: { type: Number, required: true, min: 1 },
  acquiredAt: { type: Date, required: true },
  heartbeatAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  completedAt: { type: Date, default: null },
  finalState: {
    type: String,
    enum: ['active', 'review', 'blocked', 'done', 'partial', 'released', 'expired'],
    default: 'active',
  },
  evidence: { type: AutomationAttemptEvidenceSchema, default: undefined },
  reviewedAt: { type: Date, default: null },
  reviewOutcome: {
    type: String,
    enum: ['pending', 'accepted', 'requeued', 'rejected'],
    default: 'pending',
  },
}, { _id: false });

const PipelineTaskSchema = new mongoose.Schema({
  pipelineId: { type: String, required: true, unique: true, index: true }, // e.g. "0307"
  title: { type: String, required: true },
  spec: { type: String, default: '' },                 // full markdown body (optional)
  service: { type: String, default: '' },
  status: {
    type: String,
    enum: ['queued', 'in_progress', 'review', 'blocked', 'done'],
    default: 'queued',
    index: true,
  },
  assignee: { type: String, default: null, index: true },
  heartbeatAt: { type: Date, default: null },
  epic: { type: String, default: '' },                 // ROADMAP section heading
  priority: { type: Number, min: 1, max: 5, default: 3, index: true },
  dependsOn: { type: [String], default: [] },          // pipelineIds
  notBefore: { type: Date, default: null, index: true },
  dueAt: { type: Date, default: null, index: true },
  risk: {
    type: String,
    enum: ['', 'low', 'medium', 'high', 'critical'],
    default: '',
  },
  automation: { type: AutomationIntentSchema, default: undefined },
  automationAttemptCount: { type: Number, min: 0, default: 0 },
  automationLease: { type: AutomationLeaseSchema, default: undefined },
  automationAttempts: { type: [AutomationAttemptSchema], default: [] },
  planningItemIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PlanningItem',
    index: true,
  }],
  scheduleEntryIds: { type: [String], default: [] },   // ClusterScheduleEntry.sourceId
  feedback: { type: [FeedbackSchema], default: [] },
  source: { type: String, default: 'api' },
  // Optional caller-owned idempotency key. The compound partial index lets a
  // reviewed memory candidate safely retry task creation after a lost reply.
  sourceKey: { type: String, default: null, maxlength: 200 },
}, { timestamps: true });

PipelineTaskSchema.index(
  { source: 1, sourceKey: 1 },
  { unique: true, partialFilterExpression: { sourceKey: { $type: 'string' } } }
);
PipelineTaskSchema.index({ 'automation.mode': 1, status: 1, priority: 1 });
PipelineTaskSchema.index({ 'automationLease.expiresAt': 1 });
PipelineTaskSchema.index({ 'automationAttempts.acquiredAt': 1 });

module.exports = mongoose.model('PipelineTask', PipelineTaskSchema);
