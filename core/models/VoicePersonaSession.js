const mongoose = require('mongoose');

const VoicePersonaSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, index: true },
  packId: { type: String, required: true, index: true },
  modeId: { type: String, required: true, index: true },
  scopeId: { type: String, required: true, default: 'default', index: true },
  label: { type: String, default: '' },
  status: { type: String, enum: ['active', 'closed'], default: 'active', index: true },
  turnCount: { type: Number, default: 0 },
  lastTurnAt: { type: Date, default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

VoicePersonaSessionSchema.index({ packId: 1, scopeId: 1, updatedAt: -1 });

module.exports = mongoose.model('VoicePersonaSession', VoicePersonaSessionSchema);
