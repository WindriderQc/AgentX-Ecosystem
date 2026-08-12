'use strict';

const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true, index: true },
  hostId: { type: String, required: true, index: true },
  sessionKey: { type: String, required: true },
  observedAtMs: { type: Number, required: true, index: true },
  model: { type: String, default: null },
  inputTokens: { type: Number, default: 0 },
  cachedInputTokens: { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  reasoningOutputTokens: { type: Number, default: 0 },
  totalTokens: { type: Number, default: 0 },
  source: { type: String, required: true },
}, { timestamps: true, collection: 'codexusageevents' });

const watermarkSchema = new mongoose.Schema({
  hostId: { type: String, required: true },
  sessionKey: { type: String, required: true },
  startedAtMs: { type: Number, default: null },
  lastSeenAtMs: { type: Number, required: true },
  lastUpdatedAtMs: { type: Number, required: true },
  model: { type: String, default: null },
  inputTokens: { type: Number, default: 0 },
  cachedInputTokens: { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  reasoningOutputTokens: { type: Number, default: 0 },
  totalTokens: { type: Number, default: 0 },
}, { timestamps: true, collection: 'codexusagewatermarks' });
watermarkSchema.index({ hostId: 1, sessionKey: 1 }, { unique: true });

const accountSchema = new mongoose.Schema({
  snapshotId: { type: String, required: true, unique: true, index: true },
  hostId: { type: String, required: true, index: true },
  observedAtMs: { type: Number, required: true, index: true },
  account: { type: mongoose.Schema.Types.Mixed, default: null },
  scan: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true, collection: 'codexaccountsnapshots' });

module.exports = {
  CodexUsageEvent: mongoose.models.CodexUsageEvent || mongoose.model('CodexUsageEvent', eventSchema),
  CodexUsageWatermark: mongoose.models.CodexUsageWatermark || mongoose.model('CodexUsageWatermark', watermarkSchema),
  CodexAccountSnapshot: mongoose.models.CodexAccountSnapshot || mongoose.model('CodexAccountSnapshot', accountSchema),
};
