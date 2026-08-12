'use strict';

const mongoose = require('mongoose');

const ClusterScheduleClaimSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  host: { type: String, required: true, index: true },
  model: { type: String, required: true, index: true },
  caller: { type: String, required: true, index: true },
  expiresAt: { type: Date, required: true },
  ttlMs: { type: Number, default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, {
  collection: 'cluster_schedule_claims',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
});

ClusterScheduleClaimSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
ClusterScheduleClaimSchema.index({ host: 1, expiresAt: 1 });

module.exports = mongoose.models.ClusterScheduleClaim || mongoose.model('ClusterScheduleClaim', ClusterScheduleClaimSchema);
