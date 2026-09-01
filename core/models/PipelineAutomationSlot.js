const mongoose = require('mongoose');

// Version 1 deliberately exposes a single autonomous coding slot. Keeping the
// slot in its own Mongo document makes admission atomic across different task
// ids; task-local claim compare-and-set alone cannot prevent two dispatchers
// from claiming two separate cards at the same instant.
const PipelineAutomationSlotSchema = new mongoose.Schema({
  _id: { type: String, default: 'coding-dispatcher-v1' },
  leaseId: { type: String, default: null, index: true },
  pipelineId: { type: String, default: null },
  assignee: { type: String, default: null },
  lockKeys: { type: [String], default: [] },
  acquiredAt: { type: Date, default: null },
  heartbeatAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null, index: true },
}, { timestamps: true });

module.exports = mongoose.model('PipelineAutomationSlot', PipelineAutomationSlotSchema);
