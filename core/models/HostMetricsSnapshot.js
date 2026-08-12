const mongoose = require('mongoose');

const SnapshotGpuSchema = new mongoose.Schema({
  index: { type: Number, default: 0 },
  vramUsed: { type: Number, default: 0 },
  temperature: { type: Number, default: null },
  utilization: { type: Number, default: null }
}, { _id: false });

const HostMetricsSnapshotSchema = new mongoose.Schema({
  hostId: { type: String, required: true, index: true },
  timestamp: { type: Date, default: Date.now },
  cpu: {
    usage: { type: Number, default: 0 },
    temperature: { type: Number, default: null }
  },
  memory: {
    usagePercent: { type: Number, default: 0 },
    used: { type: Number, default: 0 }
  },
  gpus: { type: [SnapshotGpuSchema], default: [] },
  diskMaxUsagePercent: { type: Number, default: 0 },
  networkBytesIn: { type: Number, default: 0 },
  networkBytesOut: { type: Number, default: 0 }
}, {
  timestamps: false,
  collection: 'host_metrics_snapshots'
});

// TTL: auto-delete snapshots after 30 days
HostMetricsSnapshotSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
// Compound index for efficient time-range queries per host
HostMetricsSnapshotSchema.index({ hostId: 1, timestamp: -1 });

module.exports = mongoose.model('HostMetricsSnapshot', HostMetricsSnapshotSchema);
