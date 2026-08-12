'use strict';
const mongoose = require('mongoose');

const VALID_TYPES = [
  'ollama.pull', 'ollama.delete', 'ollama.restart',
  'ollama.setEnv', 'ollama.unloadAll',
  'nvidia.smi', 'diag.ping'
];

const HostTaskSchema = new mongoose.Schema({
  hostId: { type: String, required: true, index: true },
  type: { type: String, required: true, enum: VALID_TYPES },
  params: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: {
    type: String,
    enum: ['pending', 'dispatched', 'completed', 'failed'],
    default: 'pending',
    index: true
  },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  dispatchedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null }
}, {
  timestamps: true,
  collection: 'hosttasks'
});

// Auto-delete completed tasks after 7 days
HostTaskSchema.index({ completedAt: 1 }, { expireAfterSeconds: 604800, partialFilterExpression: { completedAt: { $ne: null } } });

HostTaskSchema.statics.VALID_TYPES = VALID_TYPES;

const HostTask = mongoose.model('HostTask', HostTaskSchema);
HostTask.VALID_TYPES = VALID_TYPES;

module.exports = HostTask;
