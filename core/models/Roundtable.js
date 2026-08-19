/**
 * Roundtable Model
 *
 * Multi-agent roundtable discussion: blind round → rebuttal rounds → synthesis.
 * Turns are appended as agents speak (crash-recovery by persistence).
 * Quality scoring (optional) runs after completion and stores per-agent and
 * synthesis scores plus an agreement index.
 */

const mongoose = require('mongoose');

const AgentTurnSchema = new mongoose.Schema({
  agentId: { type: String, required: true },
  role: { type: String, required: true },
  round: { type: Number, required: true },
  model: { type: String, required: true },
  runtime: { type: String, enum: ['model', 'codex'], default: 'model' },
  runtimeRef: { type: String, default: null },
  target: { type: String, default: null },
  hostName: { type: String, default: null },
  response: { type: String, default: '' },
  thinking: { type: String, default: null },
  error: { type: String, default: null },
  webSearchResults: [{
    title: { type: String, default: '' },
    url: { type: String, default: '' },
    snippet: { type: String, default: '' }
  }],
  stats: {
    tokensPerSecond: { type: Number, default: null },
    latencyMs: { type: Number, default: null },
    promptTokens: { type: Number, default: null },
    completionTokens: { type: Number, default: null }
  },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null }
}, { _id: false });

const RuntimeConfigSchema = new mongoose.Schema({
  sessionKey: { type: String, default: null, maxlength: 120 },
  sessionId: { type: String, default: null, maxlength: 120 }
}, { _id: false });

const PanelAgentConfigSchema = new mongoose.Schema({
  agentId: { type: String, required: true },
  role: { type: String, required: true },
  runtime: { type: String, enum: ['model', 'codex'], default: 'model' },
  model: { type: String, default: 'runtime-managed' },
  runtimeConfig: { type: RuntimeConfigSchema, default: () => ({}) },
  systemPrompt: { type: String, required: true },
  enableWebSearch: { type: Boolean, default: false },
  resolvedTarget: { type: String, default: null },
  resolvedHostName: { type: String, default: null }
}, { _id: false });

const InterjectionSchema = new mongoose.Schema({
  interjectionId: { type: String, required: true },
  text: { type: String, required: true, maxlength: 2000 },
  author: { type: String, required: true, maxlength: 120 },
  source: { type: String, enum: ['api', 'web-ui'], default: 'api' },
  status: { type: String, enum: ['pending', 'applied'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  appliedAt: { type: Date, default: null },
  appliedRound: { type: Number, default: null }
}, { _id: false });

const GovernanceSchema = new mongoose.Schema({
  requireApproval: { type: Boolean, default: false },
  decisionStatus: {
    type: String,
    enum: ['deliberating', 'advisory', 'awaiting_approval', 'approved', 'rejected'],
    default: 'deliberating'
  },
  requestedAt: { type: Date, default: null },
  decidedAt: { type: Date, default: null },
  decidedBy: { type: String, default: null },
  decisionSource: { type: String, enum: ['api', 'web-ui', null], default: null },
  decisionNote: { type: String, default: '', maxlength: 1000 }
}, { _id: false });

const SynthesizerConfigSchema = new mongoose.Schema({
  model: { type: String, required: true },
  systemPrompt: { type: String, required: true },
  resolvedTarget: { type: String, default: null },
  resolvedHostName: { type: String, default: null }
}, { _id: false });

const RoundtableSchema = new mongoose.Schema({
  question: { type: String, required: true, maxlength: 5000 },
  status: {
    type: String,
    enum: ['pending', 'running', 'completed', 'failed', 'timeout'],
    default: 'pending',
    index: true
  },
  rounds: { type: Number, default: 2, min: 1, max: 3 },
  panelConfig: [PanelAgentConfigSchema],
  synthesizerConfig: SynthesizerConfigSchema,
  turns: [AgentTurnSchema],
  interjections: { type: [InterjectionSchema], default: [] },
  governance: { type: GovernanceSchema, default: () => ({}) },
  synthesis: {
    model: { type: String, default: null },
    target: { type: String, default: null },
    hostName: { type: String, default: null },
    response: { type: String, default: '' },
    thinking: { type: String, default: null },
    error: { type: String, default: null },
    stats: {
      tokensPerSecond: { type: Number, default: null },
      latencyMs: { type: Number, default: null },
      promptTokens: { type: Number, default: null },
      completionTokens: { type: Number, default: null }
    },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null }
  },
  totalDurationMs: { type: Number, default: null },
  error: { type: String, default: null },
  qualityScores: { type: mongoose.Schema.Types.Mixed, default: null },
  source: { type: String, default: 'api' },
  tags: { type: [String], default: [] },
  completedAt: { type: Date, default: null }
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
});

RoundtableSchema.index({ createdAt: -1 });

RoundtableSchema.virtual('turnsCount').get(function () {
  return this.turns ? this.turns.length : 0;
});
function stripPrivateReasoning(_doc, ret) {
  for (const turn of ret.turns || []) delete turn.thinking;
  if (ret.synthesis) delete ret.synthesis.thinking;
  return ret;
}

RoundtableSchema.set('toJSON', { virtuals: true, transform: stripPrivateReasoning });
RoundtableSchema.set('toObject', { virtuals: true, transform: stripPrivateReasoning });

RoundtableSchema.statics.getRecent = function (limit = 20) {
  return this.find().sort({ createdAt: -1 }).limit(limit);
};
RoundtableSchema.statics.getActive = function () {
  return this.find({ status: { $in: ['pending', 'running'] } }).sort({ createdAt: -1 });
};

module.exports = mongoose.model('Roundtable', RoundtableSchema);
