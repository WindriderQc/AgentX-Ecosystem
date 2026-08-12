const mongoose = require('mongoose');

const TextDigestSchema = new mongoose.Schema({
  length: { type: Number, default: 0 },
  sha256: { type: String, default: '' },
  preview: { type: String, default: undefined },
  text: { type: String, default: undefined }
}, { _id: false });

const VoicePersonaAuditSchema = new mongoose.Schema({
  traceId: { type: String, required: true, unique: true, index: true },
  sessionId: { type: String, required: true, index: true },
  packId: { type: String, required: true, index: true },
  modeId: { type: String, required: true },
  scopeId: { type: String, required: true, default: 'default', index: true },
  channel: { type: String, enum: ['text', 'voice'], default: 'text', index: true },
  input: { type: TextDigestSchema, default: () => ({}) },
  reply: { type: TextDigestSchema, default: () => ({}) },
  safety: {
    mode: { type: String, default: '' },
    flags: { type: [String], default: [] },
    requiresAttention: { type: Boolean, default: false },
    deterministicEscalation: { type: Boolean, default: false }
  },
  memory: {
    chunks: { type: Number, default: 0 },
    warning: { type: String, default: '' }
  },
  timings: { type: mongoose.Schema.Types.Mixed, default: {} },
  model: { type: mongoose.Schema.Types.Mixed, default: {} },
  routing: { type: mongoose.Schema.Types.Mixed, default: {} },
  upstream: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

VoicePersonaAuditSchema.index({ createdAt: -1 });
VoicePersonaAuditSchema.index({ packId: 1, scopeId: 1, createdAt: -1 });
VoicePersonaAuditSchema.index({ 'safety.flags': 1, createdAt: -1 });

module.exports = mongoose.model('VoicePersonaAudit', VoicePersonaAuditSchema);
