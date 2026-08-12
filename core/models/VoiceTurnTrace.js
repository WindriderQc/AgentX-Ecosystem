const mongoose = require('mongoose');

const MAX_TRACE_AGE_DAYS = Math.max(1, Number(process.env.VOICE_TRACE_TTL_DAYS) || 30);

/**
 * One privacy-bounded end-to-end voice turn. The document deliberately stores
 * no audio, transcript, prompt, or reply — only routing dimensions, status and
 * monotonic stage timings reported by the same-origin product surface.
 */
const VoiceTurnTraceSchema = new mongoose.Schema({
  traceId: { type: String, required: true, unique: true, maxlength: 120 },
  observedAt: { type: Date, default: Date.now, required: true },
  status: {
    type: String,
    enum: ['success', 'error', 'cancelled'],
    default: 'success',
    index: true
  },
  inputMode: { type: String, enum: ['voice', 'text'], default: 'voice' },
  surface: { type: String, default: 'unknown', maxlength: 64, index: true },
  requestedLane: { type: String, default: null, maxlength: 40 },
  lane: { type: String, default: null, maxlength: 40, index: true },
  brain: { type: String, default: null, maxlength: 80 },
  model: { type: String, default: null, maxlength: 200, index: true },
  host: { type: String, default: null, maxlength: 300, index: true },
  fallbackUsed: { type: Boolean, default: false, index: true },
  fallbackReason: { type: String, default: null, maxlength: 120 },
  stt: {
    provider: { type: String, default: null, maxlength: 80 },
    model: { type: String, default: null, maxlength: 160 }
  },
  tts: {
    provider: { type: String, default: null, maxlength: 80 },
    model: { type: String, default: null, maxlength: 160 },
    voice: { type: String, default: null, maxlength: 120 }
  },
  timings: {
    sttMs: { type: Number, default: null, min: 0 },
    firstTokenMs: { type: Number, default: null, min: 0 },
    firstPhraseMs: { type: Number, default: null, min: 0 },
    firstAudioMs: { type: Number, default: null, min: 0 },
    brainMs: { type: Number, default: null, min: 0 },
    ttsSynthesisMs: { type: Number, default: null, min: 0 },
    ttsPlaybackMs: { type: Number, default: null, min: 0 },
    ttsRtf: { type: Number, default: null, min: 0 },
    interSentenceGapMs: { type: Number, default: null, min: 0 },
    totalTurnMs: { type: Number, default: null, min: 0 }
  },
  sentenceCount: { type: Number, default: 0, min: 0, max: 100 },
  errorCode: { type: String, default: null, maxlength: 120 },
  sloViolations: [{ type: String, maxlength: 80 }]
}, {
  versionKey: false,
  collection: 'voiceturntraces'
});

VoiceTurnTraceSchema.index({ observedAt: -1 });
VoiceTurnTraceSchema.index({ surface: 1, observedAt: -1 });
VoiceTurnTraceSchema.index({ lane: 1, model: 1, observedAt: -1 });
VoiceTurnTraceSchema.index(
  { observedAt: 1 },
  { expireAfterSeconds: MAX_TRACE_AGE_DAYS * 24 * 60 * 60, name: 'voice_trace_ttl' }
);

module.exports = mongoose.model('VoiceTurnTrace', VoiceTurnTraceSchema);
