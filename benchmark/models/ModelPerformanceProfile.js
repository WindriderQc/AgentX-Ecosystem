'use strict';

const mongoose = require('mongoose');

const ArtifactIdentitySchema = new mongoose.Schema({
  model: { type: String, required: true },
  hostId: { type: String, required: true },
  hostUrl: { type: String, required: true },
  digest: { type: String, required: true },
  runtimeFingerprint: { type: String, required: true },
  registryId: { type: String, default: null },
  registryDigest: { type: String, default: null },
  registryQualified: { type: Boolean, default: false }
}, { _id: false });

const ModelPerformanceProfileSchema = new mongoose.Schema({
  modelName: { type: String, required: true, index: true },
  hostId: { type: String, required: true, index: true },
  artifact: { type: ArtifactIdentitySchema, required: true },
  profile: { type: mongoose.Schema.Types.Mixed, required: true },
  authorityWriteId: { type: String, default: null },
  active: { type: Boolean, default: true, index: true },
  stale: { type: Boolean, default: false },
  staleReason: { type: String, default: null }
}, { collection: 'modelperformanceprofiles', timestamps: true });

ModelPerformanceProfileSchema.index(
  { modelName: 1, hostId: 1, 'artifact.digest': 1, 'artifact.runtimeFingerprint': 1 },
  { unique: true, name: 'exact_model_host_runtime_profile_unique' }
);

module.exports = mongoose.model('ModelPerformanceProfile', ModelPerformanceProfileSchema);
