const mongoose = require('mongoose');

// Product-owned task queue. External boards consume the bounded HTTP API.
const FeedbackSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  by: String,
  text: String,
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

module.exports = mongoose.model('PipelineTask', PipelineTaskSchema);
