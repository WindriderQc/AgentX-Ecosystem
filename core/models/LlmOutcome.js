'use strict';

const mongoose = require('mongoose');

const UsageSchema = new mongoose.Schema({
  source: {
    type: String,
    enum: ['none', 'reported', 'agentx-inference', 'openclaw', 'hermes', 'codex', 'provider'],
    default: 'none',
  },
  inputTokens: { type: Number, min: 0, default: 0 },
  outputTokens: { type: Number, min: 0, default: 0 },
  cachedInputTokens: { type: Number, min: 0, default: 0 },
  totalTokens: { type: Number, min: 0, default: 0 },
  costUsd: { type: Number, min: 0, default: null },
  inferenceMs: { type: Number, min: 0, default: 0 },
}, { _id: false });

const LlmOutcomeSchema = new mongoose.Schema({
  outcomeId: { type: String, required: true, unique: true, index: true, maxlength: 160 },
  workItemId: { type: String, default: null, index: true, maxlength: 160 },
  correlationId: { type: String, default: null, index: true, maxlength: 160 },
  runtime: {
    type: String,
    enum: ['agentx', 'openclaw', 'hermes', 'codex', 'claude-code', 'other'],
    required: true,
    index: true,
  },
  source: { type: String, required: true, maxlength: 80 },
  outcomeType: {
    type: String,
    enum: ['task', 'deployment', 'incident', 'benchmark', 'document', 'conversation', 'other'],
    default: 'task',
  },
  verdict: {
    type: String,
    enum: ['success', 'partial', 'failure', 'abandoned'],
    required: true,
    index: true,
  },
  verified: { type: Boolean, default: false, index: true },
  verificationMethod: {
    type: String,
    enum: ['none', 'automated-tests', 'operator-review', 'deployment', 'benchmark', 'external'],
    default: 'none',
  },
  qualityScore: { type: Number, min: 0, max: 1, default: null },
  attempts: { type: Number, min: 1, default: null },
  reworkCount: { type: Number, min: 0, default: null },
  humanInterventionMinutes: { type: Number, min: 0, default: null },
  usage: { type: UsageSchema, default: () => ({}) },
  evidenceRefs: { type: [String], default: [] },
  reportedBy: { type: String, default: 'unknown', maxlength: 120 },
  completedAt: { type: Date, required: true, default: Date.now, index: true },
}, {
  timestamps: true,
  collection: 'llmoutcomes',
});

LlmOutcomeSchema.index({ runtime: 1, completedAt: -1 });
LlmOutcomeSchema.index({ verified: 1, verdict: 1, completedAt: -1 });

module.exports = mongoose.model('LlmOutcome', LlmOutcomeSchema);
