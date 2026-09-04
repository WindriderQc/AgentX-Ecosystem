const mongoose = require('mongoose');

const HostProfileSchema = new mongoose.Schema({
  hostId: { type: String, required: true, unique: true, index: true },
  hostUrl: { type: String, required: true },
  displayName: String,
  gpu: {
    model: String,
    vramTotalMiB: Number,
    computeCapability: String,
    driver: String
  },
  ollama: {
    version: String,
    backend: {
      type: String,
      enum: ['CPU', 'CUDA', 'Metal', 'ROCm', 'Vulkan', 'OpenCL', 'Unknown'],
      default: 'Unknown'
    },
    cudaVersion: String
  },
  baseline: {
    referenceModel: String,
    tokensPerSec: Number,
    latencyMs: Number,
    ttftMs: Number,
    ttftMeasurement: { type: String, enum: ['streamed_wall_clock'], default: undefined },
    testedAt: Date,
    persistenceReceipt: { type: String, default: null, select: false },
    authorityAdmissionId: { type: String, default: null, select: false },
    authorityGeneration: { type: String, default: null },
    authorityPrincipal: { type: String, default: null, select: false }
  },
  rejectedBaselineReceipts: { type: [String], default: [], select: false },
  status: {
    type: String,
    enum: ['online', 'offline', 'unknown'],
    default: 'unknown'
  },
  lastSeenAt: Date,
  cpu: {
    cores: Number,
    threadOverride: Number
  },
  dedicated: {
    model: String,
    expiresAt: Date,
    vramUsedMiB: Number,
    detectedAt: Date
  },
  reconciliation: {
    state: { type: String, enum: ['prepared', 'mutating', 'unknown', 'pending_reconciliation', 'verified', 'resolved'], default: undefined },
    operation: String,
    operationId: String,
    workloadId: String,
    admissionId: String,
    admissionGeneration: String,
    admissionPrincipal: String,
    recoveryId: String,
    recoveryRequestId: String,
    ownerId: String,
    ownerEpoch: String,
    ownerClaimedAt: Date,
    model: String,
    priorDedicated: mongoose.Schema.Types.Mixed,
    desiredDedicated: mongoose.Schema.Types.Mixed,
    priorAvailable: Boolean,
    serverTerminalObserved: Boolean,
    serverTerminalAt: Date,
    operatorTerminalReceipt: mongoose.Schema.Types.Mixed,
    timeoutAt: Date,
    quietSince: Date,
    lastObservedAt: Date,
    attempts: Number,
    releaseReceipt: mongoose.Schema.Types.Mixed,
    reason: String,
    startedAt: Date,
    resolvedAt: Date
  }
}, { collection: 'hostprofiles', timestamps: true });

module.exports = mongoose.model('HostProfile', HostProfileSchema);
