const mongoose = require('mongoose');

const PLANNING_TYPES = ['workstream', 'outcome', 'milestone', 'idea', 'decision'];
const PLANNING_STATUSES = [
  'inbox',
  'draft',
  'triaged',
  'planned',
  'active',
  'at_risk',
  'blocked',
  'completed',
  'promoted',
  'parked',
  'rejected',
  'proposed',
  'accepted',
  'superseded',
  'archived'
];
const PLANNING_STATUS_BY_TYPE = {
  workstream: ['draft', 'planned', 'active', 'at_risk', 'blocked', 'completed', 'archived'],
  outcome: ['draft', 'planned', 'active', 'at_risk', 'blocked', 'completed', 'archived'],
  milestone: ['draft', 'planned', 'active', 'at_risk', 'blocked', 'completed', 'archived'],
  idea: ['inbox', 'triaged', 'promoted', 'parked', 'rejected', 'archived'],
  decision: ['draft', 'proposed', 'accepted', 'superseded', 'archived']
};
const PLANNING_PRIORITIES = ['critical', 'high', 'normal', 'low', 'someday'];
const PROGRESS_MODES = ['tasks', 'metric', 'manual', 'children'];

const EvidenceSchema = new mongoose.Schema({
  kind: {
    type: String,
    enum: ['artifact', 'commit', 'task_feedback', 'benchmark', 'alert', 'document', 'url', 'note', 'schedule_run'],
    default: 'note'
  },
  label: { type: String, required: true, maxlength: 200 },
  ref: { type: String, default: '', maxlength: 500 },
  url: { type: String, default: '', maxlength: 2000 },
  note: { type: String, default: '', maxlength: 4000 },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  externalKey: { type: String, default: '', maxlength: 300 },
  source: {
    type: String,
    enum: ['manual', 'pipeline', 'alerts', 'schedule', 'benchmark', 'git'],
    default: 'manual'
  },
  occurredAt: { type: Date, default: null },
  addedAt: { type: Date, default: Date.now },
  addedBy: { type: String, default: 'operator', maxlength: 120 }
});

const EvidenceBindingSchema = new mongoose.Schema({
  source: {
    type: String,
    enum: ['pipeline', 'alerts', 'schedule', 'benchmark', 'git'],
    required: true
  },
  enabled: { type: Boolean, default: true },
  params: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { _id: false });

const ScheduleRefSchema = new mongoose.Schema({
  source: { type: String, default: '' },
  sourceId: { type: String, required: true },
  label: { type: String, default: '' }
}, { _id: false });

const HistorySchema = new mongoose.Schema({
  action: { type: String, required: true },
  at: { type: Date, default: Date.now },
  by: { type: String, default: 'operator' },
  note: { type: String, default: '' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { _id: false });

const PlanningItemSchema = new mongoose.Schema({
  key: { type: String, default: undefined, maxlength: 160 },
  type: { type: String, enum: PLANNING_TYPES, required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  summary: { type: String, default: '', maxlength: 8000 },
  status: {
    type: String,
    enum: PLANNING_STATUSES,
    default() { return this.type === 'idea' ? 'inbox' : 'draft'; },
    index: true
  },
  priority: { type: String, enum: PLANNING_PRIORITIES, default: 'normal', index: true },
  owner: { type: String, default: '', maxlength: 120, index: true },
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlanningItem', default: null, index: true },
  workstreamId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlanningItem', default: null, index: true },
  tags: { type: [String], default: [] },
  dates: {
    startAt: { type: Date, default: null },
    targetAt: { type: Date, default: null, index: true },
    completedAt: { type: Date, default: null }
  },
  progress: {
    mode: { type: String, enum: PROGRESS_MODES, default: 'tasks' },
    manual: { type: Number, min: 0, max: 100, default: 0 },
    metric: {
      label: { type: String, default: '', maxlength: 200 },
      unit: { type: String, default: '', maxlength: 40 },
      baseline: { type: Number, default: null },
      current: { type: Number, default: null },
      target: { type: Number, default: null },
      direction: { type: String, enum: ['increase', 'decrease'], default: 'increase' },
      sourceRef: { type: String, default: '', maxlength: 500 },
      adapter: { type: String, default: '', maxlength: 80 },
      params: { type: mongoose.Schema.Types.Mixed, default: {} },
      refreshEveryMs: { type: Number, min: 60000, max: 604800000, default: 3600000 },
      staleAfterMs: { type: Number, min: 60000, max: 2592000000, default: 21600000 },
      observation: {
        value: { type: Number, default: null },
        observedAt: { type: Date, default: null },
        status: {
          type: String,
          enum: ['unconfigured', 'fresh', 'stale', 'degraded', 'unavailable'],
          default: 'unconfigured'
        },
        error: { type: String, default: '', maxlength: 500 }
      }
    }
  },
  decision: {
    context: { type: String, default: '', maxlength: 8000 },
    choice: { type: String, default: '', maxlength: 8000 },
    rationale: { type: String, default: '', maxlength: 8000 },
    alternatives: { type: [String], default: [] },
    decidedAt: { type: Date, default: null }
  },
  evidence: { type: [EvidenceSchema], default: [] },
  automation: {
    evidenceBindings: { type: [EvidenceBindingSchema], default: [] }
  },
  scheduleRefs: { type: [ScheduleRefSchema], default: [] },
  promotedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'PlanningItem', default: null },
  archivedAt: { type: Date, default: null },
  history: { type: [HistorySchema], default: [] }
}, { timestamps: true });

PlanningItemSchema.index({ type: 1, status: 1, priority: 1 });
PlanningItemSchema.index({ workstreamId: 1, type: 1, status: 1 });
PlanningItemSchema.index({ tags: 1 });
PlanningItemSchema.index(
  { key: 1 },
  { unique: true, partialFilterExpression: { key: { $exists: true } } }
);

PlanningItemSchema.set('toJSON', {
  virtuals: true,
  transform(_doc, ret) {
    ret.id = String(ret._id);
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.models.PlanningItem || mongoose.model('PlanningItem', PlanningItemSchema);
module.exports.PLANNING_TYPES = PLANNING_TYPES;
module.exports.PLANNING_STATUSES = PLANNING_STATUSES;
module.exports.PLANNING_STATUS_BY_TYPE = PLANNING_STATUS_BY_TYPE;
module.exports.PLANNING_PRIORITIES = PLANNING_PRIORITIES;
module.exports.PROGRESS_MODES = PROGRESS_MODES;
