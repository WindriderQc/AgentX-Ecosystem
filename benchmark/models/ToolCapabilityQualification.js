'use strict';

const mongoose = require('mongoose');

const ScenarioOutcomeSchema = new mongoose.Schema({
  scenarioId: { type: String, required: true },
  classification: {
    type: String,
    enum: [
      'ok',
      'unsupported_no_tool_call_surface',
      'no_final_answer',
      'hallucinated_call',
      'leaked_tool_xml',
      'contract_violation'
    ],
    required: true
  },
  pass: { type: Boolean, required: true }
}, { _id: false });

const RepetitionEvidenceSchema = new mongoose.Schema({
  index: { type: Number, required: true, min: 0 },
  recordedAt: { type: Date, required: true },
  passed: { type: Number, required: true, min: 0 },
  graded: { type: Number, required: true, min: 0 },
  ratio: { type: Number, default: null, min: 0, max: 1 },
  scenarios: { type: [ScenarioOutcomeSchema], default: undefined }
}, { _id: false });

const ClaimReceiptSchema = new mongoose.Schema({
  batchId: { type: String, required: true },
  claimGeneration: { type: String, required: true },
  hostUrl: { type: String, required: true },
  claimedAt: { type: Date, default: null }
}, { _id: false });

const ToolCapabilityQualificationSchema = new mongoose.Schema({
  campaignId: { type: String, required: true, unique: true, immutable: true, index: true },
  identityKey: { type: String, required: true, immutable: true, index: true },
  schemaVersion: { type: String, required: true, immutable: true },
  modelName: { type: String, required: true, immutable: true, index: true },
  hostUrl: { type: String, required: true, immutable: true, index: true },
  hostId: { type: String, required: true, immutable: true },
  artifactDigest: { type: String, required: true, immutable: true, index: true },
  runtimeFingerprint: { type: String, required: true, immutable: true },
  protocolVersion: { type: String, required: true, immutable: true },
  fixtureVersion: { type: String, required: true, immutable: true },
  fixtureFingerprint: { type: String, required: true, immutable: true },
  contractFingerprint: { type: String, required: true, immutable: true },
  claim: { type: ClaimReceiptSchema, required: true, immutable: true },
  runState: {
    type: String,
    enum: ['running', 'finalized'],
    default: 'running',
    required: true
  },
  outcome: {
    type: String,
    enum: ['supported', 'unsupported', 'inconclusive', 'interrupted', null],
    default: null
  },
  repetitionsRequested: { type: Number, required: true, min: 3, max: 20, immutable: true },
  repetitionsCompleted: { type: Number, default: 0, min: 0, max: 20 },
  repetitions: { type: [RepetitionEvidenceSchema], default: undefined },
  startedAt: { type: Date, required: true, immutable: true },
  completedAt: { type: Date, default: null },
  validUntil: { type: Date, default: null, index: true },
  failureCode: { type: String, default: null },
  // Set exactly once by the fenced finalization service. The service refuses
  // every later mutation after runState becomes finalized.
  evidenceDigest: { type: String, default: null }
}, {
  collection: 'toolcapabilityqualifications',
  timestamps: true
});

ToolCapabilityQualificationSchema.index(
  {
    schemaVersion: 1,
    modelName: 1,
    hostUrl: 1,
    hostId: 1,
    artifactDigest: 1,
    runtimeFingerprint: 1,
    protocolVersion: 1,
    fixtureVersion: 1,
    fixtureFingerprint: 1,
    completedAt: -1
  },
  { name: 'exact_tool_capability_evidence_lookup' }
);

ToolCapabilityQualificationSchema.index(
  { identityKey: 1, campaignId: 1 },
  { unique: true, name: 'immutable_tool_capability_campaign_identity' }
);

module.exports = mongoose.model('ToolCapabilityQualification', ToolCapabilityQualificationSchema);
