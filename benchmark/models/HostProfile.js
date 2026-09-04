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
    testedAt: Date
  },
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
  }
}, { collection: 'hostprofiles', timestamps: true });

module.exports = mongoose.model('HostProfile', HostProfileSchema);
