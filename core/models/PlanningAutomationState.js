const mongoose = require('mongoose');

const PlanningAutomationStateSchema = new mongoose.Schema({
  collector: { type: String, required: true, unique: true, index: true, maxlength: 120 },
  cursor: { type: mongoose.Schema.Types.Mixed, default: null },
  lease: {
    owner: { type: String, default: '', maxlength: 160 },
    expiresAt: { type: Date, default: null, index: true }
  },
  lastRunAt: { type: Date, default: null },
  lastSuccessAt: { type: Date, default: null },
  status: {
    type: String,
    enum: ['idle', 'running', 'ok', 'degraded', 'error'],
    default: 'idle',
    index: true
  },
  error: { type: String, default: '', maxlength: 500 },
  statistics: {
    scanned: { type: Number, default: 0 },
    updated: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 }
  }
}, { timestamps: true });

module.exports = mongoose.models.PlanningAutomationState
  || mongoose.model('PlanningAutomationState', PlanningAutomationStateSchema);
