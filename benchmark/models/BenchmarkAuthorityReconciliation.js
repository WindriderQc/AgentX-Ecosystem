'use strict';

const mongoose = require('mongoose');

const BenchmarkAuthorityReconciliationSchema = new mongoose.Schema({
  kind: {
    type: String,
    enum: ['workload_invalidation', 'result_invalidation', 'batch_invalidation', 'judge_matrix_invalidation', 'judge_governance_invalidation', 'ground_truth_invalidation'],
    required: true,
    default: 'result_invalidation'
  },
  resultId: { type: String, required: true, unique: true, index: true },
  resourceType: { type: String, default: 'BenchmarkResult' },
  batchId: { type: String, default: null, index: true },
  workloadId: { type: String, required: true, index: true },
  admissionId: { type: String, required: true },
  admissionGeneration: { type: String, required: true },
  admissionPrincipal: { type: String, required: true },
  recoveryId: { type: String, required: true, index: true },
  recoveryRequestId: { type: String, required: true },
  phase: { type: String, required: true },
  state: {
    type: String,
    enum: ['pending_reconciliation', 'verified', 'releasing', 'resolved'],
    required: true,
    default: 'pending_reconciliation',
    index: true
  },
  reason: { type: String, default: null },
  attempts: { type: Number, default: 0 },
  lastError: { type: String, default: null },
  startedAt: { type: Date, default: Date.now },
  lastAttemptAt: { type: Date, default: null },
  resolvedAt: { type: Date, default: null },
  ownerId: { type: String, default: null, index: true },
  ownerEpoch: { type: String, default: null },
  ownerClaimedAt: { type: Date, default: null },
  compensationReceipt: { type: mongoose.Schema.Types.Mixed, default: null },
  releaseReceipt: { type: mongoose.Schema.Types.Mixed, default: null }
}, {
  collection: 'benchmarkauthorityreconciliations',
  timestamps: true
});

module.exports = mongoose.model(
  'BenchmarkAuthorityReconciliation',
  BenchmarkAuthorityReconciliationSchema
);
