const mongoose = require('mongoose');

const ClusterScheduleEntrySchema = new mongoose.Schema({
  source: {
    type: String,
    required: true,
    // `openclaw` is retained only to read schedules created before the adapter
    // extraction; new product schedules use an AgentX-owned source.
    enum: ['agentx', 'agentx-system', 'ollama-persistent', 'openclaw'],
    index: true
  },
  sourceId: { type: String, required: true },
  name: { type: String, required: true },
  taskType: {
    type: String,
    required: true,
    enum: ['benchmark', 'sync', 'cleanup', 'monitoring', 'inference', 'maintenance', 'ingestion', 'backup', 'scanning', 'diagnostics'],
    index: true
  },
  host: { type: String, default: null, index: true },
  model: { type: String, default: null },
  agent: { type: String, default: null },
  schedule: {
    type: { type: String, enum: ['cron', 'interval', 'continuous'], required: true },
    cron: { type: String, default: null },
    intervalMs: { type: Number, default: null },
    timezone: { type: String, default: 'America/Toronto' }
  },
  estimatedDurationMs: { type: Number, default: null },
  vramMb: { type: Number, default: null },
  priority: { type: Number, default: 5, min: 1, max: 10 },
  enabled: { type: Boolean, default: true },
  lastRun: { type: Date, default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

ClusterScheduleEntrySchema.index({ source: 1, sourceId: 1 }, { unique: true });

module.exports = mongoose.model('ClusterScheduleEntry', ClusterScheduleEntrySchema);
