/**
 * Hermes -> OpenAI-compatible Ollama proxy.
 *
 * Hermes speaks the OpenAI-compatible `/v1/*` API, unlike OpenClaw which uses
 * Ollama-native `/api/*` routes. This proxy gives Hermes the AgentX
 * control-plane protections: OpenRouter forwarding for cloud-namespaced models,
 * model/host routing for local models, benchmark claim gating, context drift
 * reporting for local models, and inference telemetry.
 *
 * Authority policy (0330): Hermes is cloud-first through this AgentX proxy.
 * Direct provider/Ollama runtime bypass is drift unless explicitly classified
 * as an intentional override. Do not rewrite prompts, model names, context,
 * reasoning flags, or response payloads.
 */
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const logger = require('../config/logger');
const { normalizeHostUrl } = require('../src/helpers/ollamaHostConfig');
const { modelsMatch } = require('../src/helpers/modelNameNormalization');
const hostPrefService = require('../src/services/hostPreferenceService');
const {
  getTargetForModel,
  recordInference,
  resolveHostKey
} = require('../src/services/modelRouter');
const { applyRagReflex, reflexEnabled: ragReflexEnabled } = require('../src/services/proxyRagReflex');
const { resolveCloudProvider } = require('../src/services/cloudProviderRouter');
const { telemetryContextFromRequest } = require('../src/helpers/llmTelemetryContext');
const { buildRelayHeaders } = require('../src/helpers/serviceRelay');

const READ_ONLY_PATHS = new Set([
  '/v1/models'
]);

const READ_ONLY_ALIAS_PATHS = new Map([
  ['/api/v1/models', '/v1/models'],
  ['/api/tags', '/api/tags'],
  ['/api/version', '/api/version'],
  ['/version', '/api/version']
]);

const LOCAL_READ_ONLY_RESPONSES = new Map([
  ['/props', {}],
  ['/v1/props', {}]
]);

const INFERENCE_PATHS = new Set([
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/embeddings'
]);

// The conversational chat path (OpenAI `messages` shape) — the only request the
// RAG reflex (task 0271) augments. `/v1/completions` (raw prompt) and
// `/v1/embeddings` are deliberately left untouched.
const CHAT_PATH = '/v1/chat/completions';

const FORWARD_TIMEOUT_MS =
  parseInt(process.env.HERMES_OPENAI_TIMEOUT_MS, 10) || 900000;
const CONTEXT_DRIFT_CHECK_ENABLED =
  (process.env.HERMES_OPENAI_CONTEXT_DRIFT_CHECK || 'true').toLowerCase() !== 'false';
const CONTEXT_DRIFT_TIMEOUT_MS =
  parseInt(process.env.HERMES_OPENAI_CONTEXT_DRIFT_TIMEOUT_MS, 10) || 2500;
const CONTEXT_DRIFT_CACHE_TTL_MS =
  parseInt(process.env.HERMES_OPENAI_CONTEXT_DRIFT_CACHE_TTL_MS, 10) || 5000;
const contextDriftCache = new Map();

function openAiError(message, type = 'agentx_proxy_error', code = null) {
  return {
    error: {
      message,
      type,
      param: null,
      code
    }
  };
}

function positiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function normalizeOllamaRoot(raw) {
  const normalized = normalizeHostUrl(raw);
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    if (cleanPath.toLowerCase().endsWith('/v1')) {
      parsed.pathname = cleanPath.slice(0, -3) || '/';
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return normalized.replace(/\/v1\/?$/i, '').replace(/\/$/, '');
  }
}

function resolveUpstream(model) {
  const explicit = process.env.HERMES_OPENAI_UPSTREAM || process.env.HERMES_OLLAMA_UPSTREAM;
  if (explicit) return normalizeOllamaRoot(explicit);

  const useRouter = (process.env.HERMES_OPENAI_USE_ROUTER || 'true').toLowerCase() !== 'false';
  if (useRouter && model) {
    const routed = getTargetForModel(model);
    if (routed) return normalizeOllamaRoot(routed);
  }

  return normalizeOllamaRoot(
    process.env.OPENCLAW_OLLAMA_UPSTREAM || process.env.OLLAMA_HOST || ''
  );
}

function resolveCaller(req) {
  const explicit =
    (typeof req.query.caller === 'string' && req.query.caller.trim()) ||
    (typeof req.get('X-AgentX-Caller') === 'string' && req.get('X-AgentX-Caller').trim());
  if (explicit) {
    return explicit.startsWith('hermes-') ? explicit : `hermes-${explicit}`;
  }
  return 'hermes-openai';
}

function extractRuntimeContext(body) {
  const fromOptions = positiveInteger(body?.options?.num_ctx);
  if (fromOptions != null) return { num_ctx: fromOptions, num_ctx_source: 'caller' };

  const fromParams = positiveInteger(body?.params?.num_ctx);
  if (fromParams != null) return { num_ctx: fromParams, num_ctx_source: 'caller' };

  const fromTopLevel = positiveInteger(body?.num_ctx);
  if (fromTopLevel != null) return { num_ctx: fromTopLevel, num_ctx_source: 'caller' };

  return { num_ctx: null, num_ctx_source: null };
}

function readLoadedContextLength(modelInfo) {
  const value = modelInfo?.context_length
    ?? modelInfo?.contextLength
    ?? modelInfo?.details?.context_length;
  return positiveInteger(value);
}

async function getLoadedModelContext(upstream, model) {
  if (!CONTEXT_DRIFT_CHECK_ENABLED || !upstream || !model) return null;

  const cacheKey = `${upstream}@@${model}`;
  const now = Date.now();
  const cached = contextDriftCache.get(cacheKey);
  if (cached && now - cached.checkedAt < CONTEXT_DRIFT_CACHE_TTL_MS) {
    return cached.value;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`context drift check timeout after ${CONTEXT_DRIFT_TIMEOUT_MS}ms`)),
    CONTEXT_DRIFT_TIMEOUT_MS
  );

  try {
    const resp = await fetch(`${upstream}/api/ps`, { signal: controller.signal });
    if (!resp.ok) return null;
    const data = await resp.json();
    const loaded = (data.models || []).find(m => modelsMatch(m.name || m.model, model));
    if (!loaded) return null;
    const value = {
      loadedModel: loaded.name || loaded.model || model,
      loadedNumCtx: readLoadedContextLength(loaded)
    };
    contextDriftCache.set(cacheKey, { checkedAt: now, value });
    return value;
  } catch (err) {
    logger.debug('[hermes-openai] context drift check skipped', {
      upstream, model, error: err.message
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function detectContextDrift(upstream, model, requestedNumCtx) {
  const requested = positiveInteger(requestedNumCtx);
  if (!requested) return null;

  const loaded = await getLoadedModelContext(upstream, model);
  const loadedNumCtx = positiveInteger(loaded?.loadedNumCtx);
  if (!loadedNumCtx) return null;

  return {
    requestedNumCtx: requested,
    loadedNumCtx,
    loadedModel: loaded.loadedModel,
    drift: requested !== loadedNumCtx
  };
}

/**
 * Headers for the upstream call.
 *
 * Task 0520: this previously relayed the caller's `Authorization` verbatim.
 * On the cloud path that value was overwritten anyway (see the injection at the
 * call site), but on the local path it was forwarded to an Ollama host that has
 * no authentication and no use for it — sending a caller's bearer token one hop
 * further than it needed to go, into another process's logs.
 *
 * `buildRelayHeaders` is allowlist-based, so credentials are now structurally
 * unable to cross the edge. Anything privileged is injected explicitly via
 * `inject`, server-side, after filtering.
 */
function buildForwardHeaders(req, inject = {}) {
  return buildRelayHeaders(req, {
    contentType: req.get('Content-Type') || 'application/json',
    inject,
  });
}

function hasReasoningOnlyResponse(data) {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  const message = choice?.message || {};
  const content = message.content;
  const reasoning = message.reasoning || message.reasoning_content || message.reasoningContent;
  return (!content || String(content).length === 0) && !!reasoning;
}

function usageTokens(data) {
  const usage = data?.usage || {};
  return {
    tokensIn: positiveInteger(usage.prompt_tokens) || 0,
    tokensOut: positiveInteger(usage.completion_tokens) || 0
  };
}

function setProxyHeaders(res, { callerDetail, upstream, contextDrift, reasoningOnly, cloudProvider }) {
  res.set('X-AgentX-Hermes-OpenAI-Proxy', 'forwarded');
  res.set('X-AgentX-Caller-Detail', callerDetail);
  if (upstream) res.set('X-AgentX-Upstream', upstream);
  if (cloudProvider) res.set('X-AgentX-Cloud-Provider', cloudProvider);
  if (contextDrift?.drift) {
    res.set('X-AgentX-Context-Drift', 'true');
    res.set('X-AgentX-Loaded-Num-Ctx', String(contextDrift.loadedNumCtx));
    res.set('X-AgentX-Requested-Num-Ctx', String(contextDrift.requestedNumCtx));
  }
  if (reasoningOnly) {
    res.set('X-AgentX-Hermes-Reasoning-Only', 'true');
  }
}

function forwardQuery(req) {
  return req.url.includes('?') ? `?${req.url.split('?').slice(1).join('?')}` : '';
}

router.get([
  '/api/v1/models',
  '/api/tags',
  '/api/version',
  '/version',
  '/props',
  '/v1/props'
], async (req, res) => {
  const path = req.path;
  const upstream = resolveUpstream(null);
  const callerDetail = resolveCaller(req);
  if (!upstream) {
    return res.status(503).json(openAiError('hermes-openai proxy: upstream not configured'));
  }

  if (LOCAL_READ_ONLY_RESPONSES.has(path)) {
    setProxyHeaders(res, { callerDetail, upstream, contextDrift: null, reasoningOnly: false });
    return res.json(LOCAL_READ_ONLY_RESPONSES.get(path));
  }

  const upstreamPath = READ_ONLY_ALIAS_PATHS.get(path);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`hermes-openai read-only forward timeout after ${FORWARD_TIMEOUT_MS}ms`)),
    FORWARD_TIMEOUT_MS
  );

  try {
    const resp = await fetch(`${upstream}${upstreamPath}${forwardQuery(req)}`, {
      method: 'GET',
      headers: buildForwardHeaders(req),
      signal: controller.signal
    });
    const contentType = resp.headers?.get?.('content-type') || '';
    const raw = await resp.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }

    res.status(resp.status);
    if (contentType) res.set('Content-Type', contentType);
    setProxyHeaders(res, { callerDetail, upstream, contextDrift: null, reasoningOnly: false });
    if (data !== null) return res.json(data);
    return res.send(raw);
  } catch (err) {
    logger.warn('[hermes-openai] read-only alias forward failed', {
      path, upstream, error: err.message
    });
    return res.status(err.name === 'AbortError' ? 504 : 502).json(openAiError(err.message));
  } finally {
    clearTimeout(timer);
  }
});

router.all(/^\/v1(?:\/.*)?$/, async (req, res) => {
  const path = req.path;
  const body = req.body || {};
  const model = typeof body?.model === 'string' ? body.model : null;

  // Cloud provider routing (#2): a cloud-namespaced model (e.g. openrouter/*) is
  // forwarded to its OpenAI-compatible upstream *through* AgentX so telemetry +
  // budget stay visible. Ollama-only gates (benchmark claim, context drift) are
  // skipped for cloud; the shared forward + telemetry path below is reused.
  const cloud = resolveCloudProvider(model);
  if (cloud && !cloud.apiKey) {
    return res.status(503).json(openAiError(
      `hermes-openai proxy: OpenRouter routing requested for "${model}" but OPENROUTER_API_KEY is not configured`,
      'cloud_provider_unconfigured',
      'openrouter_api_key_missing'
    ));
  }
  const upstream = cloud ? cloud.baseUrl : resolveUpstream(model);
  if (!upstream) {
    return res.status(503).json(openAiError('hermes-openai proxy: upstream not configured'));
  }

  const isInferencePath = INFERENCE_PATHS.has(path);
  const isReadOnly = READ_ONLY_PATHS.has(path);
  const claimGated = isInferencePath || !isReadOnly;
  const routedHostLabel = cloud ? cloud.provider : resolveHostKey(upstream);
  const callerDetail = resolveCaller(req);
  const runtimeContext = extractRuntimeContext(body);
  const telemetryContext = { ...telemetryContextFromRequest(req, 'hermes'), runtime: 'hermes' };
  const startedAt = Date.now();
  let contextDrift = null;

  if (!cloud && claimGated) {
    try {
      const pref = await hostPrefService.getByHost(upstream);
      if (hostPrefService.hasActiveBenchmarkClaim(pref)) {
        logger.info('[hermes-openai] short-circuit on active benchmark claim', {
          path, upstream, model, callerDetail,
          batchId: pref?.benchmarkClaim?.batchId || null
        });

        process.nextTick(() => recordInference({
          host: upstream,
          model: model || 'unknown',
          caller: 'proxy',
          callerDetail,
          ...telemetryContext,
          routedHostUrl: upstream,
          routedHost: routedHostLabel,
          durationMs: Date.now() - startedAt,
          status: 'error',
          error: 'blocked_by_benchmark_claim',
          ...runtimeContext
        }));

        return res.status(503).json(openAiError(
          `hermes-openai proxy: upstream ${upstream} is held by an active benchmark claim`,
          'benchmark_claim_active',
          'blocked_by_benchmark_claim'
        ));
      }
    } catch (err) {
      logger.warn('[hermes-openai] claim lookup failed; blocking inference path', {
        path, upstream, model, callerDetail, error: err.message
      });

      process.nextTick(() => recordInference({
        host: upstream,
        model: model || 'unknown',
        caller: 'proxy',
        callerDetail,
        ...telemetryContext,
        routedHostUrl: upstream,
        routedHost: routedHostLabel,
        durationMs: Date.now() - startedAt,
        status: 'error',
        error: 'benchmark_claim_lookup_failed',
        ...runtimeContext
      }));

      return res.status(503).json(openAiError(
        `hermes-openai proxy: could not verify benchmark claim state for ${upstream}`,
        'benchmark_claim_lookup_failed',
        'benchmark_claim_lookup_failed'
      ));
    }
  }

  if (!cloud && claimGated && model && runtimeContext.num_ctx != null) {
    contextDrift = await detectContextDrift(upstream, model, runtimeContext.num_ctx);
    if (contextDrift?.drift) {
      logger.warn('[hermes-openai] caller num_ctx differs from loaded context', {
        path,
        upstream,
        model,
        callerDetail,
        requestedNumCtx: contextDrift.requestedNumCtx,
        loadedNumCtx: contextDrift.loadedNumCtx,
        loadedModel: contextDrift.loadedModel
      });
    }
  }

  // RAG reflex (task 0271): for chat-style turns, retrieve-before-answer and
  // inject a `## Relevant knowledge` system block. Flag-gated (PROXY_RAG_REFLEX,
  // default off). When off — or on any retrieval failure — `forwardBody` stays
  // the original `body` reference, so the forward is byte-identical.
  let forwardBody = cloud ? { ...body, model: cloud.upstreamModel } : body;
  let ragInjected = false;
  const boundedEvidenceCaller = callerDetail === 'hermes-memory-review';
  if (path === CHAT_PATH && ragReflexEnabled() && !boundedEvidenceCaller) {
    const reflex = await applyRagReflex(forwardBody, { caller: callerDetail });
    forwardBody = reflex.body;
    ragInjected = reflex.ragInjected;
  }

  // Cloud base URLs already include `/v1`; strip the inbound `/v1` prefix so we
  // don't double it. Ollama roots have no `/v1`, so the path is used as-is.
  const forwardPath = cloud ? path.replace(/^\/v1/, '') : path;
  const url = `${upstream}${forwardPath}${forwardQuery(req)}`;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`hermes-openai forward timeout after ${FORWARD_TIMEOUT_MS}ms`)),
    FORWARD_TIMEOUT_MS
  );

  try {
    // AgentX owns cloud egress + auth: the provider key is injected here,
    // server-side, and is the only credential that ever reaches an upstream.
    // Inbound Authorization is not relayed on either path (task 0520).
    const inject = cloud
      ? {
        Authorization: `Bearer ${cloud.apiKey}`,
        'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://agentx.local',
        'X-Title': process.env.OPENROUTER_TITLE || 'AgentX',
      }
      : {};
    const fetchOpts = {
      method: req.method,
      headers: buildForwardHeaders(req, inject),
      signal: controller.signal
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fetchOpts.body = JSON.stringify(forwardBody);
    }

    const resp = await fetch(url, fetchOpts);
    const contentType = resp.headers?.get?.('content-type') || '';

    res.status(resp.status);
    if (contentType) res.set('Content-Type', contentType);
    if (ragInjected) res.set('X-AgentX-RAG-Reflex', 'injected');

    if (body?.stream === true || contentType.includes('text/event-stream')) {
      setProxyHeaders(res, { callerDetail, upstream, contextDrift, reasoningOnly: false, cloudProvider: cloud?.provider });

      if (claimGated) {
        const finishTelemetry = (status, error = null) => {
          process.nextTick(() => recordInference({
            host: upstream,
            model: model || 'unknown',
            caller: 'proxy',
            callerDetail,
            ...telemetryContext,
            routedHostUrl: upstream,
            routedHost: routedHostLabel,
            ...runtimeContext,
            durationMs: Date.now() - startedAt,
            status,
            error
          }));
        };
        resp.body.on('end', () => finishTelemetry(resp.ok ? 'success' : 'error', resp.ok ? null : `upstream_status_${resp.status}`));
        resp.body.on('error', err => finishTelemetry('error', err.message));
      }

      return resp.body.pipe(res);
    }

    const raw = await resp.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }

    const reasoningOnly = hasReasoningOnlyResponse(data);
    if (reasoningOnly) {
      logger.warn('[hermes-openai] upstream returned reasoning without final content', {
        path, upstream, model, callerDetail
      });
    }

    if (claimGated) {
      const { tokensIn, tokensOut } = usageTokens(data);
      process.nextTick(() => recordInference({
        host: upstream,
        model: data?.model || model || 'unknown',
        caller: 'proxy',
        callerDetail,
        ...telemetryContext,
        routedHostUrl: upstream,
        routedHost: routedHostLabel,
        ...runtimeContext,
        tokensIn,
        tokensOut,
        durationMs: Date.now() - startedAt,
        status: resp.ok ? 'success' : 'error',
        error: resp.ok ? null : (data?.error?.message || data?.error || `upstream_status_${resp.status}`)
      }));
    }

    setProxyHeaders(res, { callerDetail, upstream, contextDrift, reasoningOnly, cloudProvider: cloud?.provider });
    if (data !== null) return res.json(data);
    return res.send(raw);
  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    logger.warn('[hermes-openai] forward failed', {
      path, upstream, error: err.message, isTimeout
    });

    if (claimGated) {
      process.nextTick(() => recordInference({
        host: upstream,
        model: model || 'unknown',
        caller: 'proxy',
        callerDetail,
        ...telemetryContext,
        routedHostUrl: upstream,
        routedHost: routedHostLabel,
        ...runtimeContext,
        durationMs: Date.now() - startedAt,
        status: 'error',
        error: isTimeout ? 'forward_timeout' : err.message
      }));
    }

    return res.status(isTimeout ? 504 : 502).json(openAiError(err.message));
  } finally {
    clearTimeout(timer);
  }
});

module.exports = router;
