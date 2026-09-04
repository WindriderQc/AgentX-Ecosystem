'use strict';

const mongoose = require('mongoose');

const BenchmarkAuthorityReconciliationSchema = new mongoose.Schema({
  kind: {
    type: String,
    enum: ['result_invalidation'],
    required: true,
    default: 'result_invalidation'
  },
  resultId: { type: String, required: true, unique: true, index: true },
  batchId: { type: String, default: null, index: true },
  phase: { type: String, required: true },
  state: {
    type: String,
    enum: ['pending_reconciliation', 'resolved'],
    required: true,
    default: 'pending_reconciliation',
    index: true
  },
  reason: { type: String, default: null },
  attempts: { type: Number, default: 0 },
  lastError: { type: String, default: null },
  startedAt: { type: Date, default: Date.now },
  lastAttemptAt: { type: Date, default: null },
  resolvedAt: { type: Date, default: null }
}, {
  collection: 'benchmarkauthorityreconciliations',
  timestamps: true
});

module.exports = mongoose.model(
  'BenchmarkAuthorityReconciliation',
  BenchmarkAuthorityReconciliationSchema
);
