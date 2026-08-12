/**
 * OpenClaw → Ollama claim- and pin-aware passthrough (task 0180).
 *
 * OpenClaw's runtime speaks the Ollama HTTP API directly. Before 0180, the
 * `ax` provider in `~/.openclaw/openclaw.json` had `baseUrl` pointing at
 * Host Delta:11434 — every cron job that loaded `ax/gemma4:26b` reached
 * Ollama directly, bypassing core's benchmark claim machinery (task 0175).
 * That bypass evicted the bench's working set mid-run and contaminated
 * every batch on the same host (see TODO/FEEDBACK/0175-feedback.md).
 *
 * This optional adapter lets an explicit OpenClaw endpoint send Ollama API
 * traffic through Core. We:
 *   1. resolve the upstream Ollama host (env-driven, defaults to
 *      `OLLAMA_HOST`),
 *   2. for any path that can load or run a model, look up the host
 *      preference and short-circuit with a 503 (Ollama-shaped error JSON)
 *      when `hasActiveBenchmarkClaim` returns true,
 *   3. reject model-loading requests that do not match an app-managed pin on
 *      the upstream host (default on; emergency rollback is env-driven),
 *   4. otherwise forward the request, log the call to `inferencelogs`
 *      with `callerDetail = openclaw-<provider>` so the traffic is
 *      visible in telemetry,
 *   5. let read-only paths (`/api/tags`, `/api/ps`, `/api/show`,
 *      `/api/version`) always pass through — they don't load models.
 *
 * Trust model: `callerDetail` is informational. The claim check is the
 * authoritative gate; tagging is for telemetry/grouping only. Caller can
 * override with `?caller=` or `X-AgentX-Caller` header so the OpenClaw
 * runtime can pass per-job detail (e.g. `openclaw-cron-overseer-prework`)
 * once the upstream config gains that capability.
 */
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const logger = require('../config/logger');
const { normalizeHostUrl } = require('../src/helpers/ollamaHostConfig');
const { modelsMatch } = require('../src/helpers/modelNameNormalization');
const hostPrefService = require('../src/services/hostPreferenceService');
const { recordInference, resolveHostKey } = require('../src/services/modelRouter');
const { applyRagReflex, reflexEnabled: ragReflexEnabled } = require('../src/services/proxyRagReflex');
const { telemetryContextFromRequest } = require('../src/helpers/llmTelemetryContext');

// Upstream Ollama host this proxy forwards to. The OpenClaw `ax` provider
// only ever hits Host Delta (gemma4:26b is pinned there), so a single env
// variable is sufficient. Override per-deployment if other OpenClaw
// providers ever migrate to this proxy.
function getUpstream() {
  return normalizeHostUrl(
    process.env.OPENCLAW_OLLAMA_UPSTREAM || process.env.OLLAMA_HOST || ''
  );
}

// Paths that load/run a model — these MUST honour benchmark claims.
const INFERENCE_PATHS = new Set([
  '/api/chat',
  '/api/generate',
  '/api/embed',
  '/api/embeddings',
]);

// Paths that are read-only metadata — always safe to forward.
const READ_ONLY_PATHS = new Set([
  '/api/tags',
  '/api/ps',
  '/api/show',
  '/api/version',
]);

// The conversational chat path (Ollama-native `messages` shape) — the only
// request the RAG reflex (task 0271) augments. `/api/generate` (raw prompt) and
// `/api/embed*` are deliberately left untouched.
const CHAT_PATH = '/api/chat';

const FORWARD_TIMEOUT_MS =
  parseInt(process.env.OPENCLAW_OLLAMA_TIMEOUT_MS, 10) || 600000;
const CONTEXT_DRIFT_CHECK_ENABLED =
  (process.env.OPENCLAW_CONTEXT_DRIFT_CHECK || 'true').toLowerCase() !== 'false';
const CONTEXT_DRIFT_TIMEOUT_MS =
  parseInt(process.env.OPENCLAW_CONTEXT_DRIFT_TIMEOUT_MS, 10) || 2500;
const CONTEXT_DRIFT_CACHE_TTL_MS =
  parseInt(process.env.OPENCLAW_CONTEXT_DRIFT_CACHE_TTL_MS, 10) || 5000;
const contextDriftCache = new Map();

function resolveCaller(req) {
  const explicit =
    (typeof req.query.caller === 'string' && req.query.caller.trim()) ||
    (typeof req.get('X-AgentX-Caller') === 'string' && req.get('X-AgentX-Caller').trim());
  if (explicit) {
    return explicit.startsWith('openclaw-') ? explicit : `openclaw-${explicit}`;
  }
  return 'openclaw-ax';
}

function ollamaError(message) {
  return { error: message };
}

function pinGuardEnabled() {
  return String(process.env.OPENCLAW_PIN_GUARD_ENABLED || 'true').toLowerCase() !== 'false';
}

function positiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function extractRuntimeContext(body) {
  const fromOptions = positiveInteger(body?.options?.num_ctx);
  if (fromOptions != null) return { num_ctx: fromOptions, num_ctx_source: 'caller' };

  const fromParams = positiveInteger(body?.params?.num_ctx);
  if (fromParams != null) return { num_ctx: fromParams, num_ctx_source: 'caller' };

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
    logger.debug('[openclaw-ollama] context drift check skipped', {
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

router.all(/^\/api\/.*/, async (req, res) => {
  const upstream = getUpstream();
  if (!upstream) {
    return res.status(503).json(ollamaError('openclaw-ollama proxy: upstream not configured'));
  }

  const path = req.path;
  const isInferencePath = INFERENCE_PATHS.has(path);
  const isReadOnly = READ_ONLY_PATHS.has(path);

  // Unknown Ollama paths default to the safe behavior — claim-check them.
  // Anything we haven't explicitly listed as read-only could still load a
  // model server-side (e.g. /api/pull). Treating unknown as inference
  // matches the "fail-closed for the bench" invariant.
  const claimGated = isInferencePath || !isReadOnly;

  const callerDetail = resolveCaller(req);
  const startedAt = Date.now();
  const body = req.body || {};
  const telemetryContext = { ...telemetryContextFromRequest(req, 'openclaw'), runtime: 'openclaw' };
  const model = typeof body?.model === 'string'
    ? body.model
    : (typeof body?.name === 'string' ? body.name : null);
  const runtimeContext = extractRuntimeContext(body);
  let contextDrift = null;

  if (claimGated) {
    try {
      const pref = await hostPrefService.getByHost(upstream);
      if (hostPrefService.hasActiveBenchmarkClaim(pref)) {
        logger.info('[openclaw-ollama] short-circuit on active benchmark claim', {
          path, upstream, model, callerDetail,
          batchId: pref?.benchmarkClaim?.batchId || null,
        });

        // Fire-and-forget telemetry — the call never reached Ollama.
        process.nextTick(() => recordInference({
          host: upstream,
          model: model || 'unknown',
          caller: 'proxy',
          callerDetail,
          ...telemetryContext,
          routedHostUrl: upstream,
          routedHost: resolveHostKey(upstream),
          durationMs: Date.now() - startedAt,
          status: 'error',
          error: 'blocked_by_benchmark_claim',
          ...runtimeContext,
        }));

        return res.status(503).json(ollamaError(
          `openclaw-ollama proxy: upstream ${upstream} is held by an active benchmark claim`
        ));
      }

      const pins = hostPrefService.getPinnedEntries(pref);
      if (
        pinGuardEnabled()
        && pins.length > 0
        && (
          !isInferencePath
          || !model
          || !pins.some(pin => modelsMatch(pin.model, model))
        )
      ) {
        logger.warn('[openclaw-ollama] blocked model outside app-managed pins', {
          path,
          upstream,
          model,
          callerDetail,
          pinnedModels: pins.map(pin => pin.model)
        });

        process.nextTick(() => recordInference({
          host: upstream,
          model: model || 'unknown',
          caller: 'proxy',
          callerDetail,
          ...telemetryContext,
          routedHostUrl: upstream,
          routedHost: resolveHostKey(upstream),
          durationMs: Date.now() - startedAt,
          status: 'error',
          error: 'blocked_by_pin_policy',
          ...runtimeContext
        }));

        res.set('X-AgentX-Pin-Guard', 'blocked');
        return res.status(409).json(ollamaError(
          `openclaw-ollama proxy: request is not an allowed pinned inference call on ${upstream}`
        ));
      }
    } catch (err) {
      logger.warn('[openclaw-ollama] claim lookup failed; blocking inference path', {
        path, upstream, model, callerDetail, error: err.message,
      });

      process.nextTick(() => recordInference({
        host: upstream,
        model: model || 'unknown',
        caller: 'proxy',
        callerDetail,
        ...telemetryContext,
        routedHostUrl: upstream,
        routedHost: resolveHostKey(upstream),
        durationMs: Date.now() - startedAt,
        status: 'error',
        error: 'benchmark_claim_lookup_failed',
        ...runtimeContext,
      }));

      return res.status(503).json(ollamaError(
        `openclaw-ollama proxy: could not verify benchmark claim state for ${upstream}`
      ));
    }
  }

  if (claimGated && model && runtimeContext.num_ctx != null) {
    contextDrift = await detectContextDrift(upstream, model, runtimeContext.num_ctx);
    if (contextDrift?.drift) {
      logger.warn('[openclaw-ollama] caller num_ctx differs from loaded context', {
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
  let forwardBody = body;
  let ragInjected = false;
  if (path === CHAT_PATH && ragReflexEnabled()) {
    const reflex = await applyRagReflex(body, { caller: callerDetail });
    forwardBody = reflex.body;
    ragInjected = reflex.ragInjected;
  }

  // Forward to upstream Ollama.
  const url = `${upstream}${path}${req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : ''}`;
  const method = req.method;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`openclaw-ollama forward timeout after ${FORWARD_TIMEOUT_MS}ms`)),
    FORWARD_TIMEOUT_MS
  );

  try {
    const fetchOpts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    };
    if (method !== 'GET' && method !== 'HEAD') {
      fetchOpts.body = JSON.stringify(forwardBody);
    }
    const resp = await fetch(url, fetchOpts);
    const raw = await resp.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }

    if (claimGated) {
      // Record successful (or upstream-error) inference forwards. Read-only
      // metadata paths are not interesting telemetry — skip the write.
      const tokensIn = data?.prompt_eval_count || 0;
      const tokensOut = data?.eval_count || 0;
      process.nextTick(() => recordInference({
        host: upstream,
        model: data?.model || model || 'unknown',
        caller: 'proxy',
        callerDetail,
        ...telemetryContext,
        routedHostUrl: upstream,
        routedHost: resolveHostKey(upstream),
        ...runtimeContext,
        tokensIn,
        tokensOut,
        durationMs: Date.now() - startedAt,
        status: resp.ok ? 'success' : 'error',
        error: resp.ok ? null : (data?.error || `upstream_status_${resp.status}`),
      }));
    }

    res.status(resp.status);
    res.set('X-AgentX-OpenClaw-Proxy', 'forwarded');
    res.set('X-AgentX-Caller-Detail', callerDetail);
    if (ragInjected) res.set('X-AgentX-RAG-Reflex', 'injected');
    if (contextDrift?.drift) {
      res.set('X-AgentX-Context-Drift', 'true');
      res.set('X-AgentX-Loaded-Num-Ctx', String(contextDrift.loadedNumCtx));
      res.set('X-AgentX-Requested-Num-Ctx', String(contextDrift.requestedNumCtx));
    }
    if (data !== null) {
      return res.json(data);
    }
    return res.send(raw);
  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    logger.warn('[openclaw-ollama] forward failed', {
      path, upstream, error: err.message, isTimeout,
    });

    if (claimGated) {
      process.nextTick(() => recordInference({
        host: upstream,
        model: model || 'unknown',
        caller: 'proxy',
        callerDetail,
        ...telemetryContext,
        routedHostUrl: upstream,
        routedHost: resolveHostKey(upstream),
        ...runtimeContext,
        durationMs: Date.now() - startedAt,
        status: 'error',
        error: isTimeout ? 'forward_timeout' : err.message,
      }));
    }
    return res.status(isTimeout ? 504 : 502).json(ollamaError(err.message));
  } finally {
    clearTimeout(timer);
  }
});

module.exports = router;
