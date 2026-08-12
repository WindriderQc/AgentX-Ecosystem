/**
 * Budget accounting — separate *cloud spend* from *free local compute* (0455).
 *
 * THE BUG THIS FIXES
 * `budget_health` was computed from every token in InferenceLog measured
 * against DAILY_TOKEN_LIMIT, and Nestor's cloud-escalation gate consumed that
 * number. But the overwhelming majority of logged tokens are local Ollama
 * inference, which costs nothing: a single benchmark campaign burns ~1M local
 * tokens, pushing usage_ratio past 2.4 and turning the gate red. The result was
 * a gate meant to protect the credit card being tripped by free GPU cycles —
 * on any benchmark day Nestor could not escalate to a cloud specialist no
 * matter how little cloud money had actually been spent.
 *
 * THE FIX
 * Classify each logged model by its provider prefix and account for the two
 * populations separately. `budget_health` keeps its original whole-fleet
 * meaning (other consumers and dashboards depend on it); a new `cloud_health`
 * describes only billable traffic, and that is what the escalation policy
 * consumes.
 *
 * Classification is an explicit provider allowlist, NOT "does the name contain
 * a slash" — local Ollama models are routinely namespaced (`ax/gemma4:26b`,
 * `qllama/bge-m3:f16`) and a slash heuristic would misclassify the entire
 * local fleet as cloud, inverting the bug instead of fixing it.
 */

const DEFAULT_CLOUD_PROVIDERS = [
  'openrouter', 'anthropic', 'openai', 'openai-codex', 'azure', 'bedrock',
  'google', 'gemini', 'vertex', 'groq', 'mistral', 'deepseek', 'xai',
  'together', 'fireworks', 'perplexity', 'cohere'
];

/** Providers may be extended per-deployment without a code change. */
function cloudProviders() {
  const raw = process.env.BUDGET_CLOUD_PROVIDERS;
  if (!raw || !String(raw).trim()) return new Set(DEFAULT_CLOUD_PROVIDERS);
  const extra = String(raw).split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  return new Set([...DEFAULT_CLOUD_PROVIDERS, ...extra]);
}

/** The segment before the first '/', lowercased. `null` when unqualified. */
function modelProvider(model) {
  const name = String(model || '').trim();
  if (!name) return null;
  const idx = name.indexOf('/');
  if (idx <= 0) return null;
  return name.slice(0, idx).toLowerCase();
}

/**
 * A model is billable only when its provider prefix is a known cloud vendor.
 * Bare names (`qwen2.5:14b`), Ollama namespaces (`ax/...`, `qllama/...`) and
 * an explicit `ollama/` prefix are all local and therefore free.
 */
function isCloudModel(model) {
  const provider = modelProvider(model);
  if (!provider) return false;
  return cloudProviders().has(provider);
}

/**
 * Hostnames that mean the call left the LAN for a paid API.
 * Needed because the model name alone is not always enough: OpenRouter
 * serves `z-ai/glm-5.2`, whose `z-ai` prefix is the MODEL vendor, not the
 * billing provider, so a prefix-only check filed real OpenRouter spend as
 * local and reported $0.
 */
const CLOUD_HOST_PATTERNS = [
  'openrouter.ai', 'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com',
  'api.groq.com', 'api.mistral.ai', 'api.deepseek.com', 'api.x.ai', 'api.together.xyz',
  'api.fireworks.ai', 'api.perplexity.ai', 'api.cohere.ai', 'azure.com', 'amazonaws.com'
];

/** Extra hosts may be added per-deployment without a code change. */
function cloudHosts() {
  const raw = process.env.BUDGET_CLOUD_HOSTS;
  if (!raw || !String(raw).trim()) return CLOUD_HOST_PATTERNS;
  const extra = String(raw).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return [...CLOUD_HOST_PATTERNS, ...extra];
}

/**
 * True when the endpoint URL is a known paid API. Private LAN addresses
 * (192.168.x, 10.x, 172.16-31.x, localhost) are never cloud, whatever the
 * model is called.
 */
function isCloudHost(host) {
  const url = String(host || '').trim().toLowerCase();
  if (!url) return false;
  if (/(^|\/\/)(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url)) return false;
  return cloudHosts().some((pattern) => url.includes(pattern));
}

/**
 * A call is billable if EITHER its model carries a cloud provider prefix
 * OR it was served by a known cloud endpoint. Pass the host whenever you
 * have it; model-only callers keep the old behaviour.
 */
function isCloudCall({ model, host, hosts } = {}) {
  if (isCloudModel(model)) return true;
  const candidates = Array.isArray(hosts) ? hosts : [host];
  return candidates.some((h) => isCloudHost(h));
}

function healthFromRatio(ratio) {
  if (!Number.isFinite(ratio)) return 'red';
  if (ratio < 0.7) return 'green';
  if (ratio < 0.9) return 'yellow';
  return 'red';
}

/**
 * Split aggregated per-model usage into cloud vs local populations.
 * `rows` are `{ _id: model, requests, tokens }` as produced by the budget
 * aggregation pipeline.
 */
function splitUsageByModel(rows = []) {
  const cloud = { requests: 0, tokens: 0, models: [] };
  const local = { requests: 0, tokens: 0, models: [] };

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const model = row._id || row.model || 'unknown';
    const requests = Number(row.requests) || 0;
    const tokens = Number(row.tokens) || 0;
    const bucket = isCloudModel(model) ? cloud : local;
    bucket.requests += requests;
    bucket.tokens += tokens;
    bucket.models.push(model);
  }

  cloud.models.sort();
  local.models.sort();
  return { cloud, local };
}

/**
 * Build the cloud-only budget view.
 *
 * `cloud_spend_observability` is deliberately explicit. When no billable call
 * appears in the window the honest reading is "zero recorded cloud spend", not
 * "unknown" — so the gate stays green rather than denying a feature forever on
 * the strength of free local traffic. The flag makes it visible that the number
 * reflects AgentX-routed traffic only, so nobody mistakes it for a provider
 * invoice.
 */
function buildCloudBudget({ rows = [], hours = 24, cloudDailyLimit } = {}) {
  const { cloud, local } = splitUsageByModel(rows);
  const limit = Number.isFinite(Number(cloudDailyLimit)) && Number(cloudDailyLimit) > 0
    ? Number(cloudDailyLimit)
    : null;
  const scaledLimit = limit ? Math.round(limit * (Number(hours) / 24)) : null;
  const ratio = scaledLimit && scaledLimit > 0 ? cloud.tokens / scaledLimit : 0;

  return {
    cloud_requests: cloud.requests,
    cloud_tokens: cloud.tokens,
    cloud_models: cloud.models,
    local_requests: local.requests,
    local_tokens: local.tokens,
    cloud_daily_limit: limit,
    cloud_scaled_limit: scaledLimit,
    cloud_usage_ratio: Math.round(ratio * 1000) / 1000,
    cloud_health: healthFromRatio(ratio),
    cloud_spend_observability: cloud.requests > 0 ? 'agentx-routed-calls' : 'none-recorded'
  };
}

module.exports = {
  DEFAULT_CLOUD_PROVIDERS,
  CLOUD_HOST_PATTERNS,
  cloudProviders,
  cloudHosts,
  modelProvider,
  isCloudModel,
  isCloudHost,
  isCloudCall,
  healthFromRatio,
  splitUsageByModel,
  buildCloudBudget
};
