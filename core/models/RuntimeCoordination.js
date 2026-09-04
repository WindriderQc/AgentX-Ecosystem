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
  expiresAt: { type: Date, required: true }
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
  expiresAt: { type: Date, required: true }
}, { _id: false });

const RuntimeCoordinationSchema = new mongoose.Schema({
  _id: { type: String, default: 'runtime' },
  maintenance: { type: MaintenanceLeaseSchema, default: null },
  workloads: { type: [WorkloadAdmissionSchema], default: [] },
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
