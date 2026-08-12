/**
 * Cloud provider routing for the AgentX OpenAI-compatible gateway (task: #2
 * "AgentX fronts OpenRouter"). Maps a cloud-namespaced model id to an
 * OpenAI-compatible cloud upstream so the Hermes proxy can forward cloud
 * inference *through* AgentX — keeping telemetry + budget visibility — instead
 * of callers reaching the provider directly and bypassing governance.
 *
 * Convention: the routing namespace is the FIRST path segment of the model id,
 * matching OpenClaw's existing `openrouter/<vendor>/<model>` scheme. Only the
 * routing prefix is stripped for the upstream; the rest is the provider's native
 * model id (e.g. `openrouter/z-ai/glm-5.2` -> OpenRouter model `z-ai/glm-5.2`).
 *
 * OpenRouter-first (decided 2026-07-01): only `openrouter/*` is wired today.
 * Add sibling entries here (e.g. `anthropic/`, `xai/`) when a second provider is
 * pertinent — the proxy calls this resolver and needs no further changes.
 *
 * Returns `null` for any non-cloud model so the caller falls through to the
 * existing local Ollama host routing unchanged.
 */

const PROVIDERS = {
  openrouter: {
    provider: 'openrouter',
    // OpenAI-compatible base; already includes the `/v1` segment.
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    baseUrlEnv: 'OPENROUTER_BASE_URL',
    apiKeyEnv: 'OPENROUTER_API_KEY'
  }
};

function stripTrailingSlashes(value) {
  return String(value || '').replace(/\/+$/, '');
}

/**
 * @param {string} model e.g. "openrouter/z-ai/glm-5.2"
 * @returns {null | {provider, baseUrl, apiKey, upstreamModel, requestedModel}}
 */
function resolveCloudProvider(model) {
  if (typeof model !== 'string' || !model) return null;

  const slash = model.indexOf('/');
  if (slash <= 0) return null;

  const namespace = model.slice(0, slash).toLowerCase();
  const spec = PROVIDERS[namespace];
  if (!spec) return null;

  const upstreamModel = model.slice(slash + 1);
  if (!upstreamModel) return null;

  const baseUrl = stripTrailingSlashes(process.env[spec.baseUrlEnv] || spec.defaultBaseUrl);
  const apiKey = (process.env[spec.apiKeyEnv] || '').trim() || null;

  return {
    provider: spec.provider,
    baseUrl,
    apiKey,
    upstreamModel,
    requestedModel: model
  };
}

module.exports = { resolveCloudProvider };
