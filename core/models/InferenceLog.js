const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * InferenceLog — records every Ollama inference call across all hosts.
 * Written fire-and-forget from modelRouter.recordInference().
 * TTL: 30 days by default (configurable via INFERENCE_LOG_TTL_DAYS env).
 */
const InferenceLogSchema = new mongoose.Schema({
  // Routing
  host: { type: String, required: true },          // full URL e.g. http://192.0.2.99:11434
  hostKey: { type: String, default: null },         // 'primary' | 'secondary' | 'tertiary'
  model: { type: String, required: true },

  // Caller identity
  caller: {
    type: String,
    enum: ['chat', 'benchmark', 'embedding', 'classification', 'proxy', 'unknown'],
    default: 'unknown'
  },
  callerDetail: { type: String, default: null },    // agent ID, task ID, cron job name, etc.
  consumerContract: { type: String, default: null }, // server-attested internal consumer contract
  runtime: {
    type: String,
    enum: ['agentx', 'openclaw', 'hermes', 'codex', 'claude-code', 'other'],
    default: 'agentx'
  },
  correlationId: { type: String, default: null },
  workItemId: { type: String, default: null },
  attempt: { type: Number, min: 1, default: 1 },

  // Task context
  taskType: { type: String, default: null },        // from TASK_MODELS or custom
  routed: { type: Boolean, default: false },        // whether auto-routing was used
  autoRouted: { type: Boolean, default: false },    // whether classifier auto-routing was used
  classificationMs: { type: Number, default: 0 },
  routedModel: { type: String, default: null },
  routedHost: { type: String, default: null },      // host key when known
  routedHostUrl: { type: String, default: null },
  fallbackUsed: { type: Boolean, default: false },
  fallbackReason: { type: String, default: null },
  swapped: { type: Boolean, default: false },
  routingTrace: { type: Schema.Types.Mixed, default: null },

  // RouteDecision v1 (task 0519) — the versioned, named record of why this call
  // went where it did. `routingTrace` above is free-form and shaped differently
  // per caller; this field is the contract 0465 alerting and 0522's resolver
  // build on. Mixed because the contract is versioned in-document
  // (`decisionVersion`) rather than by the Mongoose schema, so a v2 can land
  // without a migration. Never contains prompts or completions — see
  // src/services/routing/routeDecision.js `assertNoPayload`.
  routeDecision: { type: Schema.Types.Mixed, default: null },

  // Context observability — for detecting KV-cache reload cascades.
  // num_ctx: actual value sent to Ollama (null = omitted, Ollama used Modelfile default).
  // num_ctx_source: free string ('caller', 'modelfile', 'override',
  //   'target_host_vram_estimate', 'context_test', 'execution_default', 'fallback').
  num_ctx: { type: Number, default: null },
  num_ctx_source: { type: String, default: null },

  // Performance
  tokensIn: { type: Number, default: 0 },
  tokensOut: { type: Number, default: 0 },
  durationMs: { type: Number, default: 0 },

  // Status
  status: {
    type: String,
    enum: ['success', 'error', 'timeout'],
    default: 'success'
  },
  error: { type: String, default: null },

  timestamp: { type: Date, default: Date.now }
}, {
  timestamps: false,
  collection: 'inferencelogs'
});

// TTL index — expires documents after N days
const TTL_SECONDS = parseInt(process.env.INFERENCE_LOG_TTL_DAYS || '30', 10) * 86400;
InferenceLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: TTL_SECONDS });

// Query indexes
InferenceLogSchema.index({ host: 1, timestamp: -1 });
InferenceLogSchema.index({ model: 1, timestamp: -1 });
InferenceLogSchema.index({ caller: 1, timestamp: -1 });
InferenceLogSchema.index({ callerDetail: 1, timestamp: -1 });
InferenceLogSchema.index({ consumerContract: 1, timestamp: -1 });
InferenceLogSchema.index({ status: 1, timestamp: -1 });
InferenceLogSchema.index({ taskType: 1, timestamp: -1 });
InferenceLogSchema.index({ autoRouted: 1, timestamp: -1 });
InferenceLogSchema.index({ runtime: 1, timestamp: -1 });
InferenceLogSchema.index({ workItemId: 1, timestamp: -1 });
InferenceLogSchema.index({ correlationId: 1, timestamp: -1 });

module.exports = mongoose.model('InferenceLog', InferenceLogSchema);
