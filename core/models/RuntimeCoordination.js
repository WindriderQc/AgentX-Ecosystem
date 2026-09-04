'use strict';

const mongoose = require('mongoose');

const MaintenanceLeaseSchema = new mongoose.Schema({
  leaseId: { type: String, required: true },
  generation: { type: String, required: true },
  principal: { type: String, required: true },
  requestId: { type: String, required: true },
  scope: { type: String, required: true },
  acquiredAt: { type: Date, required: true },
  heartbeatAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  // Expiry cannot prove that an already-dispatched deploy/restart/pin
  // operation terminated. Keep the runtime fenced until explicit recovery.
  state: {
    type: String,
    enum: ['ACTIVE', 'UNKNOWN'],
    default: 'ACTIVE'
  },
  unknownAt: { type: Date, default: null },
  unknownReason: { type: String, default: null }
}, { _id: false });

const WorkloadAdmissionSchema = new mongoose.Schema({
  admissionId: { type: String, required: true },
  generation: { type: String, required: true },
  principal: { type: String, required: true },
  requestId: { type: String, required: true },
  workloadId: { type: String, required: true },
  kind: { type: String, required: true },
  batchId: { type: String, default: null },
  hosts: { type: [String], default: [] },
  acquiredAt: { type: Date, required: true },
  heartbeatAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  // Recovery quarantine is armed by the Benchmark client immediately after
  // acquisition and before acquireWorkloadAdmission returns to a mutator.
  // It is deliberately not TTL-reaped: an expired process proof must not let
  // maintenance enter while a database/Ollama operation may still complete.
  recoveryRequired: { type: Boolean, default: false },
  recoveryId: { type: String, default: null },
  recoveryGeneration: { type: String, default: null },
  recoveryRequestId: { type: String, default: null },
  recoveryOwnerId: { type: String, default: null },
  recoveryArmedAt: { type: Date, default: null },
  recoveryAdoptedAt: { type: Date, default: null },
  recoveryState: {
    type: String,
    enum: ['PREPARED', 'MUTATING', 'UNKNOWN', 'VERIFIED', 'RESTORED'],
    default: null
  },
  recoveryVersion: { type: Number, default: 0 },
  recoveryReceipt: { type: mongoose.Schema.Types.Mixed, default: null }
}, { _id: false });

const InferenceAdmissionSchema = new mongoose.Schema({
  admissionId: { type: String, required: true },
  generation: { type: String, required: true },
  principal: { type: String, required: true },
  requestId: { type: String, required: true },
  host: { type: String, required: true },
  model: { type: String, required: true },
  // Core derives this key from the canonical host-independent residency
  // intent. Callers never choose it. Shared admissions may coexist only when
  // the exact runner/residency key matches.
  residencyKey: { type: String, required: true },
  residencySpec: { type: mongoose.Schema.Types.Mixed, required: true },
  kind: { type: String, required: true },
  mode: { type: String, enum: ['shared', 'exclusive'], default: 'shared' },
  workloadAdmissionId: { type: String, default: null },
  workloadGeneration: { type: String, default: null },
  acquiredAt: { type: Date, required: true },
  heartbeatAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  // An inference is itself able to change Ollama residency. If its owner
  // disappears, TTL expiry cannot prove the upstream request stopped. Keep a
  // durable quarantine until an operator supplies a runtime-restart receipt.
  state: {
    type: String,
    enum: ['ACTIVE', 'UNKNOWN'],
    default: 'ACTIVE'
  },
  unknownAt: { type: Date, default: null },
  unknownReason: { type: String, default: null }
}, { _id: false });

const RuntimeCoordinationSchema = new mongoose.Schema({
  _id: { type: String, default: 'runtime' },
  maintenance: { type: MaintenanceLeaseSchema, default: null },
  workloads: { type: [WorkloadAdmissionSchema], default: [] },
  inferences: { type: [InferenceAdmissionSchema], default: [] },
  releaseReceipts: {
    type: [mongoose.Schema.Types.Mixed],
    default: [],
    select: false
  }
}, {
  collection: 'runtime_coordination',
  timestamps: true
});

module.exports = mongoose.models.RuntimeCoordination
  || mongoose.model('RuntimeCoordination', RuntimeCoordinationSchema);
