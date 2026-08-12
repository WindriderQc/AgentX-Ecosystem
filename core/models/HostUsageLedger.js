const mongoose = require('mongoose');

/**
 * HostUsageLedger — hourly per-host usage aggregates derived from InferenceLog.
 * Written by hostUsageAggregator.js on a recurring schedule.
 * Used by cluster.html for actual-vs-planned overlays and utilization heatmaps.
 */
const HostUsageLedgerSchema = new mongoose.Schema({
  host: { type: String, required: true },       // full Ollama URL
  hostKey: { type: String, default: null },      // 'primary' | 'secondary' | 'tertiary'
  hostLabel: { type: String, default: null },    // registry display name
  hour: { type: Date, required: true },          // truncated to top of the hour (UTC)

  // Volume
  totalCalls: { type: Number, default: 0 },
  successCalls: { type: Number, default: 0 },
  errorCalls: { type: Number, default: 0 },
  fallbackCalls: { type: Number, default: 0 },

  // Tokens
  totalTokensIn: { type: Number, default: 0 },
  totalTokensOut: { type: Number, default: 0 },

  // Timing
  totalDurationMs: { type: Number, default: 0 },
  avgDurationMs: { type: Number, default: 0 },
  maxDurationMs: { type: Number, default: 0 },

  // Utilization (inference time / wall clock time for that hour)
  utilizationPct: { type: Number, default: 0 },  // 0–100

  // Model diversity
  uniqueModels: { type: [String], default: [] },
  callerBreakdown: { type: mongoose.Schema.Types.Mixed, default: {} }, // { chat: N, benchmark: N, ... }

  aggregatedAt: { type: Date, default: Date.now }
}, {
  timestamps: false,
  collection: 'hostusageledger'
});

// Unique compound index — one record per host per hour
HostUsageLedgerSchema.index({ host: 1, hour: 1 }, { unique: true });
HostUsageLedgerSchema.index({ hour: -1 });
HostUsageLedgerSchema.index({ hostKey: 1, hour: -1 });

// TTL — keep 90 days of hourly data
HostUsageLedgerSchema.index({ hour: 1 }, { expireAfterSeconds: 90 * 86400 });

module.exports = mongoose.model('HostUsageLedger', HostUsageLedgerSchema);
