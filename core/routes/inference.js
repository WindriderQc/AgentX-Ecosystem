/**
 * Inference routes — caller-aware lane policy (task 0168).
 *
 * /api/inference/generate selects one of three performance lanes from the
 * authenticated caller policy. `callerDetail` remains telemetry metadata.
 * Every lane preserves the exact requested model tag. The
 * retired `useAdapted: true` property is rejected instead of silently changing
 * artifact identity.
 *
 * Trust model — LOAD-BEARING ASSUMPTION
 * --------------------------------------
 * `callerDetail` is a free-form string set by the caller. Benchmark lanes
 * require the scoped Benchmark token; interactive lanes require same-origin
 * UI proof or the existing operator token. Untrusted claims degrade to the
 * automated safe path and remain visible in telemetry.
 *
 * Safety invariant — the interactive lane keeps hostGate.acquire. Skipping
 * it would let chat/buddy cut in line on a cron mid-call and force model
 * swaps. The "buddy can't interrupt cron" rule is non-negotiable.
 */
const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const fetch = require('node-fetch');
const { resolveTarget } = require('../src/helpers/ollamaUtils');
const { normalizeHostUrl, validateHostUrl, getHostUrls, hostUrlKey } = require('../src/helpers/ollamaHostConfig');
const {
  HOSTS,
  buildRouterConfigPayload,
  ensureTaskModelOverridesLoaded,
  getDefaultTaskModels,
  getAdvisoryModelForTask,
  getModelForTask,
  resolvePreferredTaskEntry,
  resetAllTaskModelOverrides,
  resetTaskModelOverride,
  saveTaskModelOverride
} = require('../src/services/modelRouterConfig');
const { getRoutingStatus, classifyQuery, getModelHealth, getAllModelsHealth, getTargetForModel, recordInference, resolveHostKey } = require('../src/services/modelRouter');
const { getRagServiceClient } = require('../src/services/ragServiceClient');
const { emit: emitBuddyEvent } = require('../src/services/buddyEvents');
const { getModelReadiness } = require('../src/services/modelReadinessService');
const hostGate = require('../src/services/hostGate');
const { scheduleShadowEvaluation } = require('../src/services/routing/shadowEvaluation');
const { buildRouteDecision, DECISION_MODES, REJECTION_REASONS } = require('../src/services/routing/routeDecision');
const { tryAndRespondDegraded } = require('../src/services/routing/degradedRetryResponse');
const { executeOllamaAttempt } = require('../src/services/routing/inferenceAttemptExecutor');
const {
    buildInferenceClientData,
    classifyHttpRetryFailure,
    setInferenceResponseHeaders,
} = require('../src/services/routing/inferenceResponsePresenter');
const {
    applyContractOutputLimit,
    resolveEmbeddingKeepAlive
} = require('../src/services/inferenceRuntimePolicy');
const lanePolicy = require('../src/services/inferenceLanePolicy');
const { resolveInferenceRequestCaller } = require('../src/services/routing/inferenceCallerAccess');
const { assertHostAvailableForConsumer } = require('../src/services/benchmarkClaimGuard');
const { resolveThinkingPolicy } = require('../src/services/thinkingPolicy');
const {
    resolveInferenceContract,
    resolveInferenceContractSnapshot
} = require('../src/services/inferenceContractService');
const { telemetryContextFromRequest } = require('../src/helpers/llmTelemetryContext');
const { trustedNestorConsumer } = require('../src/services/nestorConsumerAttribution');
const alertService = require('../src/services/alertService');
const { summarizeOllamaOutcome } = require('../src/services/laneObservabilityService');
const ragStore = getRagServiceClient();

const INFERENCE_FETCH_TIMEOUT_MS =
  parseInt(process.env.INFERENCE_FETCH_TIMEOUT_MS, 10) || 600000;

function requireProfiledModels() {
  return process.env.REQUIRE_PROFILED_MODELS === 'true';
}

const ROUTING_PREVIEW_CHARS = 420;

function truncatePreview(value, maxLength = ROUTING_PREVIEW_CHARS) {
    const text = typeof value === 'string' ? value : '';
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}...`;
}

function buildMessagePreview(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.slice(-6).map((message, index) => {
        const content = typeof message?.content === 'string' ? message.content : '';
        return {
            index: Math.max(0, messages.length - 6) + index,
            role: typeof message?.role === 'string' ? message.role : 'unknown',
            chars: content.length,
            preview: truncatePreview(content)
        };
    });
}

function buildRequestPreview({ prompt, messages, system, options, stream, think, keepAlive }) {
    return {
        mode: Array.isArray(messages) ? 'chat' : 'generate',
        prompt: prompt ? {
            chars: prompt.length,
            preview: truncatePreview(prompt)
        } : null,
        system: system ? {
            chars: system.length,
            preview: truncatePreview(system)
        } : null,
        messages: Array.isArray(messages) ? buildMessagePreview(messages) : [],
        options: options && typeof options === 'object' ? { ...options } : {},
        stream: stream === true,
        think: think === undefined ? null : think,
        keepAlive: keepAlive === undefined ? null : keepAlive
    };
}

function summarizeRecommendation(recommendation) {
    if (!recommendation) return null;
    const scheduler = recommendation.recommendation || null;
    return {
        model: recommendation.model || null,
        host: recommendation.host || null,
        hostUrl: recommendation.url || null,
        source: recommendation.source || null,
        reason: recommendation.reason || null,
        claimId: recommendation.claimId || null,
        claimExpiresAt: recommendation.claimExpiresAt || null,
        readiness: recommendation.readiness || null,
        scheduler: scheduler ? {
            host: scheduler.host || null,
            hostUrl: scheduler.hostUrl || null,
            reason: scheduler.reason || null,
            confidence: scheduler.confidence || null,
            warnings: Array.isArray(scheduler.warnings) ? scheduler.warnings : [],
            scored: Array.isArray(scheduler._scored) ? scheduler._scored : []
        } : null
    };
}

function buildRoutingDifference(trace) {
    const reasons = [];
    const recommendation = trace.recommendation;
    const selected = trace.selected || {};
    const requested = trace.request || {};

    if (requested.hostOverride) {
        reasons.push(`Caller supplied host override "${requested.hostOverride}".`);
    }

    if (recommendation?.host && selected.hostKey && recommendation.host !== selected.hostKey) {
        reasons.push(`Selected host ${selected.hostKey} differs from recommended host ${recommendation.host}.`);
    }

    if (recommendation?.hostUrl && selected.hostUrl && normalizeHostUrl(recommendation.hostUrl) !== normalizeHostUrl(selected.hostUrl)) {
        reasons.push(`Selected host URL differs from recommendation.`);
    }

    if (recommendation?.scheduler?.reason) {
        reasons.push(`Scheduler reason: ${recommendation.scheduler.reason}.`);
    } else if (recommendation?.reason) {
        reasons.push(`Router reason: ${recommendation.reason}.`);
    }

    if (reasons.length === 0) {
        reasons.push(recommendation ? 'Actual path matched the router recommendation.' : 'Direct path; no task recommendation was requested.');
    }

    return {
        differsFromRecommendation: !!(
            requested.hostOverride
            || (recommendation?.host && selected.hostKey && recommendation.host !== selected.hostKey)
            || (recommendation?.hostUrl && selected.hostUrl && normalizeHostUrl(recommendation.hostUrl) !== normalizeHostUrl(selected.hostUrl))
        ),
        reasons
    };
}

router.get('/ollama/models', async (req, res) => {
    const target = req.query.target || process.env.OLLAMA_HOST;
    let resolvedTarget = target;
    if (!target) {
        return res.status(500).json({ status: 'error', message: 'OLLAMA_HOST not configured and no target provided' });
    }
    // Allowlist user-supplied target (task 0182 followup — read-only proxies
    // still forward TCP wherever the URL points, so an arbitrary URL remains
    // a vector for whatever runs there). The env-var fallback path is exempt.
    if (req.query.target) {
        const validation = validateHostUrl(req.query.target);
        if (!validation.valid) {
            return res.status(400).json({
                status: 'error',
                message: 'Host URL not in configured allowlist',
                detail: validation.error
            });
        }
        resolvedTarget = validation.host || target;
    }
    try {
        const url = `${resolveTarget(resolvedTarget)}/api/tags`;
        const response = await fetch(url);
        const data = await response.json();
        const allModels = Array.isArray(data?.models) ? data.models : [];
        const models = allModels
            .map((model) => ({
                name: model.name,
                size: model.size,
                modified_at: model.modified_at,
            }));
        res.json({ status: 'success', data: models });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Split liveness from the long embed budget: cold loads can be slow, while a
// black-holed host should be skipped after a short probe.
const EMBED_TIMEOUT_MS = Number(process.env.EMBED_TIMEOUT_MS) > 0
    ? Number(process.env.EMBED_TIMEOUT_MS)
    : 60000;
const EMBED_PROBE_TIMEOUT_MS = Number(process.env.EMBED_PROBE_TIMEOUT_MS) > 0
    ? Number(process.env.EMBED_PROBE_TIMEOUT_MS)
    : 3000;
// Liveness is cached so a batch ingest doesn't pay a probe per chunk.
const EMBED_LIVENESS_TTL_MS = 15000;
const embedLiveness = new Map();

async function isEmbedHostLive(hostUrl) {
    const cached = embedLiveness.get(hostUrl);
    if (cached && Date.now() - cached.at < EMBED_LIVENESS_TTL_MS) return cached.ok;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_PROBE_TIMEOUT_MS);
    let ok = false;
    try {
        const probe = await fetch(`${hostUrl}/api/tags`, { signal: controller.signal });
        ok = probe.ok;
    } catch (err) {
        ok = false;
    } finally {
        clearTimeout(timer);
    }

    embedLiveness.set(hostUrl, { ok, at: Date.now() });
    return ok;
}

function emitEmbedHostFailure(candidate, model, error) {
    const alertSvc = alertService;
    if (!alertSvc?.evaluateEvent) return;
    alertSvc.evaluateEvent({
        component: resolveHostKey(candidate) || candidate,
        metric: 'host_unreachable',
        value: 1,
        source: 'embedding-proxy',
        additionalData: { model, host: candidate, error }
    }).catch(() => {});
}

router.post('/inference/embed', async (req, res) => {
    const startedAt = Date.now();
    const body = req.body || {};
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const ollamaHostOverride = typeof body.ollamaHost === 'string' ? body.ollamaHost.trim() : '';

    if (!model || !prompt) {
        return res.status(400).json({
            status: 'error',
            message: 'model and prompt are required and must be non-empty strings'
        });
    }

    // Allowlist check (task 0182). The override is the SSRF surface; the
    // task-router fallback already returns a configured URL.
    const embedHostCheck = validateHostUrl(ollamaHostOverride);
    if (!embedHostCheck.valid) {
        return res.status(400).json({ status: 'error', message: embedHostCheck.message });
    }

    // Reassigned to the host that actually answered, so telemetry and error
    // payloads name the real upstream rather than the first one we tried.
    let target = embedHostCheck.host
        ? normalizeHostUrl(embedHostCheck.host)
        : normalizeHostUrl(getTargetForModel(model));

    if (!target) {
        return res.status(500).json({
            status: 'error',
            message: 'No Ollama host configured for embeddings'
        });
    }
    const routedTarget = target;

    if (requireProfiledModels()) {
        const readinessState = await getModelReadiness(model, target);
        if (readinessState.readiness?.isReady !== true) {
            return res.status(409).json({
                status: 'error',
                message: `Model "${model}" is not profiled on the selected host. Enable profiling first or disable REQUIRE_PROFILED_MODELS.`,
                data: {
                    model,
                    host: target,
                    readiness: readinessState.readiness
                }
            });
        }
    }

    // Fall through configured hosts unless the caller explicitly pinned one.
    const candidates = embedHostCheck.host
        ? [target]
        : [target, ...getHostUrls()
            .map(normalizeHostUrl)
            .filter(url => url && hostUrlKey(url) !== hostUrlKey(target))];

    /**
     * RouteDecision v1 (task 0540 — the embed half of 0519). Embeddings are the
     * highest-volume inference path and fail over between hosts silently;
     * without a decision on the row, `primary` vs `selected` divergence is
     * invisible in aggregate. `mode` is explicit_model because the caller
     * always names the model here — only the host is routed. Rejected
     * candidates accumulate so the attempt that finally serves carries the
     * full failover story. Pure and wrapped: telemetry must never break an
     * embed call.
     */
    const consumerContract = trustedNestorConsumer(req);
    const telemetryContext = telemetryContextFromRequest(req, 'agentx');
    const rejections = [];
    const buildEmbedDecision = ({ candidate, attempt, fallbackUsed, fallbackReason }) => {
        try {
            return buildRouteDecision({
                mode: DECISION_MODES.EXPLICIT_MODEL,
                caller: 'embedding',
                callerDetail: body.callerDetail || null,
                consumerContract,
                correlationId: telemetryContext.correlationId,
                workItemId: telemetryContext.workItemId,
                runtime: telemetryContext.runtime,
                attempt,
                requestedModel: model,
                requestedHost: ollamaHostOverride || null,
                // `primary` is where the request was originally aimed; on a
                // failover that is deliberately NOT the host being recorded.
                primaryModel: model,
                primaryHost: resolveHostKey(routedTarget),
                primaryHostUrl: routedTarget,
                selectedModel: model,
                selectedHost: resolveHostKey(candidate),
                selectedHostUrl: candidate,
                fallbackUsed,
                fallbackReason,
                degraded: Boolean(fallbackUsed),
                degradedReason: fallbackReason,
                rejections: rejections.slice(),
                totalMs: Date.now() - startedAt,
            });
        } catch (err) {
            logger.debug('[EmbeddingProxy] route decision build failed', { error: err.message });
            return null;
        }
    };

    let response = null;
    let raw = '';
    let data = null;
    let attemptTarget = target;
    let lastError = null;

    try {
        for (const [candidateIndex, candidate] of candidates.entries()) {
            attemptTarget = candidate;
            // Why we moved off the previous candidate — captured before this
            // attempt's own failure can overwrite lastError.
            const attemptFallbackReason = candidateIndex > 0 ? (lastError?.message || null) : null;

            // Skip a dead host without burning the full embed budget.
            if (!await isEmbedHostLive(candidate)) {
                lastError = new Error(`Embedding host ${candidate} is unreachable`);
                recordInference({
                    host: candidate,
                    routedHostUrl: routedTarget,
                    model,
                    caller: 'embedding',
                    attempt: candidateIndex + 1,
                    routeDecision: buildEmbedDecision({
                        candidate,
                        attempt: candidateIndex + 1,
                        fallbackUsed: candidateIndex > 0,
                        fallbackReason: attemptFallbackReason,
                    }),
                    num_ctx: null,
                    num_ctx_source: 'n/a',
                    durationMs: Date.now() - startedAt,
                    status: 'error',
                    error: lastError.message
                });
                logger.warn('Embedding host failed liveness probe; trying next', {
                    host: candidate,
                    model
                });
                emitEmbedHostFailure(candidate, model, lastError.message);
                rejections.push({
                    model,
                    host: resolveHostKey(candidate),
                    hostUrl: candidate,
                    reason: REJECTION_REASONS.HOST_OFFLINE,
                });
                response = null;
                continue;
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);

            try {
                const keepAlive = await resolveEmbeddingKeepAlive(candidate, model);
                response = await fetch(`${candidate}/api/embeddings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model,
                        prompt,
                        ...(keepAlive !== undefined && { keep_alive: keepAlive })
                    }),
                    signal: controller.signal
                });
            } catch (err) {
                lastError = err.name === 'AbortError'
                    ? new Error(`Embedding request to ${candidate} timed out after ${EMBED_TIMEOUT_MS}ms`)
                    : err;
                recordInference({
                    host: candidate,
                    routedHostUrl: routedTarget,
                    model,
                    caller: 'embedding',
                    attempt: candidateIndex + 1,
                    routeDecision: buildEmbedDecision({
                        candidate,
                        attempt: candidateIndex + 1,
                        fallbackUsed: candidateIndex > 0,
                        fallbackReason: attemptFallbackReason,
                    }),
                    num_ctx: null,
                    num_ctx_source: 'n/a',
                    durationMs: Date.now() - startedAt,
                    status: 'error',
                    error: lastError.message
                });
                logger.warn('Embedding host unreachable; trying next', {
                    host: candidate,
                    model,
                    error: lastError.message
                });
                emitEmbedHostFailure(candidate, model, lastError.message);
                rejections.push({
                    model,
                    host: resolveHostKey(candidate),
                    hostUrl: candidate,
                    // A timeout on a probe-live host is a wedged/busy runner,
                    // not an offline box — 0465 groups on these strings.
                    reason: err.name === 'AbortError'
                        ? REJECTION_REASONS.HOST_BUSY
                        : REJECTION_REASONS.HOST_OFFLINE,
                });
                response = null;
                continue;
            } finally {
                clearTimeout(timer);
            }

            break;
        }

        if (!response) {
            throw lastError || new Error('No Ollama host available for embeddings');
        }

        target = attemptTarget;
        const fallbackUsed = hostUrlKey(target) !== hostUrlKey(routedTarget);
        const fallbackReason = fallbackUsed
            ? lastError?.message || `Embedding route moved from ${routedTarget} to ${target}`
            : null;
        const attemptNumber = candidates.findIndex(candidate => hostUrlKey(candidate) === hostUrlKey(target)) + 1;
        // One decision for whichever terminal row this attempt produces —
        // success, HTTP error, or invalid body are mutually exclusive.
        const finalDecision = buildEmbedDecision({
            candidate: target,
            attempt: attemptNumber,
            fallbackUsed,
            fallbackReason,
        });

        raw = await response.text();
        if (raw) {
            try {
                data = JSON.parse(raw);
            } catch (err) {
                data = null;
            }
        }

        // Embeddings have fixed context handling; keep them out of num_ctx drift.
        const EMBED_SOURCE = 'n/a';

        if (!response.ok) {
            recordInference({
                host: target,
                model,
                caller: 'embedding',
                routeDecision: finalDecision,
                num_ctx: null,
                num_ctx_source: EMBED_SOURCE,
                durationMs: Date.now() - startedAt,
                status: 'error',
                error: `HTTP ${response.status}`
            });

            return res.status(response.status).json({
                status: 'error',
                message: data?.error || raw || response.statusText || 'Embedding request failed'
            });
        }

        if (!data || !Array.isArray(data.embedding)) {
            recordInference({
                host: target,
                model,
                caller: 'embedding',
                routeDecision: finalDecision,
                num_ctx: null,
                num_ctx_source: EMBED_SOURCE,
                durationMs: Date.now() - startedAt,
                status: 'error',
                error: 'Invalid embedding response'
            });

            return res.status(502).json({
                status: 'error',
                message: 'Invalid response from Ollama embeddings API'
            });
        }

        recordInference({
            host: target,
            routedHostUrl: routedTarget,
            model,
            caller: 'embedding',
            attempt: attemptNumber,
            fallbackUsed,
            fallbackReason,
            routeDecision: finalDecision,
            num_ctx: null,
            num_ctx_source: EMBED_SOURCE,
            tokensIn: prompt.length > 0 ? 1 : 0,
            durationMs: Date.now() - startedAt,
            status: 'success'
        });

        const alertSvc = alertService;
        alertSvc?.resolveRecoveredInferenceAlerts?.({
            host: target,
            hostKey: resolveHostKey(target),
            model,
            latencyMs: Date.now() - startedAt
        }).catch(() => {});

        res.set('X-Routed-Host', target);
        res.set('X-AgentX-Fallback-Used', String(fallbackUsed));
        if (fallbackReason) res.set('X-AgentX-Fallback-Reason', fallbackReason);
        if (fallbackUsed) {
            emitBuddyEvent(
                'failover_triggered',
                'infrastructure',
                `Embedding failover: ${model} moved from ${routedTarget} to ${target}`,
                'high',
                { intent: 'warning', surfaceScope: 'core' }
            );
        }

        return res.json({
            embedding: data.embedding
        });
    } catch (err) {
        // Terminal failure — usually every candidate was rejected. The
        // decision still gets built so the exhausted-fleet case is attributed,
        // with the rejection list carrying which hosts were tried and why.
        const exhaustedFallback = hostUrlKey(attemptTarget) !== hostUrlKey(routedTarget);
        recordInference({
            host: target,
            model,
            caller: 'embedding',
            routeDecision: buildEmbedDecision({
                candidate: attemptTarget,
                attempt: Math.max(candidates.findIndex(candidate => hostUrlKey(candidate) === hostUrlKey(attemptTarget)) + 1, 1),
                fallbackUsed: exhaustedFallback,
                fallbackReason: exhaustedFallback ? err.message : null,
            }),
            num_ctx: null,
            num_ctx_source: 'n/a',
            durationMs: Date.now() - startedAt,
            status: 'error',
            error: err.message
        });

        return res.status(502).json({
            status: 'error',
            message: err.message
        });
    }
});

/**
 * Resolve a serializable host/artifact contract once, before a benchmark or
 * other reproducible matrix begins. Callers are expected to persist the
 * returned snapshot and reuse it rather than resolving capabilities between
 * attempts.
 */
router.post('/inference/contract/resolve', async (req, res) => {
    const body = req.body || {};
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    const host = typeof body.host === 'string' ? body.host.trim() : '';
    if (!model || !host) {
        return res.status(400).json({
            status: 'error',
            message: 'model and host are required to freeze a deployed-artifact contract'
        });
    }

    const hostCheck = validateHostUrl(host);
    if (!hostCheck.valid) {
        return res.status(400).json({ status: 'error', message: hostCheck.message });
    }

    try {
        const options = body.options || {};
        const rawNumCtx = options.num_ctx ?? body.num_ctx;
        const rawNumPredict = options.num_predict ?? body.num_predict;
        const requestedNumCtx = rawNumCtx == null ? null : Number(rawNumCtx);
        const requestedMaxOutputTokens = rawNumPredict == null ? null : Number(rawNumPredict);
        if ((rawNumCtx != null && (!Number.isInteger(requestedNumCtx) || requestedNumCtx <= 0))
            || (rawNumPredict != null
                && (!Number.isInteger(requestedMaxOutputTokens) || requestedMaxOutputTokens <= 0))) {
            return res.status(400).json({
                status: 'error',
                message: 'num_ctx and num_predict must be positive integers when supplied'
            });
        }
        const snapshot = await resolveInferenceContractSnapshot({
            model,
            host: hostCheck.host,
            requestedNumCtx,
            numCtxSource: requestedNumCtx != null ? 'caller' : 'profile',
            requestedMaxOutputTokens
        });
        return res.json(snapshot);
    } catch (err) {
        logger.error('[inference] contract snapshot resolution failed', {
            model,
            host: hostCheck.host,
            error: err.message
        });
        return res.status(500).json({
            status: 'error',
            message: 'Failed to resolve inference contract snapshot'
        });
    }
});

/**
 * POST /api/inference/generate — Unified inference proxy.
 * Routes model to correct Ollama host via model router.
 * Supports both /api/generate (prompt) and /api/chat (messages) modes.
 */
router.post('/inference/generate', async (req, res) => {
    const startedAt = Date.now();
    const body = req.body || {};
    const consumerContract = trustedNestorConsumer(req);
    const telemetryContext = telemetryContextFromRequest(req, 'agentx');
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
    const taskType = typeof body.taskType === 'string' ? body.taskType.trim() : '';
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const messages = Array.isArray(body.messages) ? body.messages : null;
    const system = typeof body.system === 'string' ? body.system : undefined;
    const stream = body.stream === true;
    const responseMode = typeof body.responseMode === 'string' ? body.responseMode.trim().toLowerCase() : '';
    const rawResponseRequested = body.rawResponse === true || responseMode === 'raw';
    // num_ctx policy:
    // - explicit caller options always win (benchmark/profiler/direct sweeps)
    // - routed daily lanes may inherit HostPreference.pinnedModels[*].contextSize
    // - routed daily lanes enforce the inference contract's output reserve as
    //   num_predict so Modelfile defaults cannot silently cap replies at 512
    const options = { ...(body.options || {}) };
    let numCtxSource = options.num_ctx != null ? 'caller' : 'modelfile';
    const requestedThink = body.think;
    let think = requestedThink;
    const thinkingMode = body.thinkingMode ?? body.thinking_mode;
    let keepAlive = body.keep_alive ?? body.keepAlive;
    const hostOverride = typeof body.host === 'string' ? body.host.trim() : '';

    if (!requestedModel && !taskType) {
        return res.status(400).json({ status: 'error', message: 'model or taskType is required' });
    }
    if (!prompt && !messages) {
        return res.status(400).json({ status: 'error', message: 'prompt or messages is required' });
    }

    // Allowlist check (task 0182). When the caller passes a `host` string it
    // MUST resolve to a configured Ollama host (URL allowlist with loopback
    // equivalence, or by host name/id). When the field is absent we fall
    // through to model-router resolution unchanged.
    const generateHostCheck = validateHostUrl(hostOverride);
    if (!generateHostCheck.valid) {
        return res.status(400).json({ status: 'error', message: generateHostCheck.message });
    }
    const allowlistedHostOverride = generateHostCheck.host || '';

    // The rate-limiter middleware resolved the authenticated caller policy.
    // Missing context fails closed to `automated` — the safe full-step path.
    const callerContext = req.inferenceCallerContext || resolveInferenceRequestCaller(req);
    const { name: laneName, policy: lane } = lanePolicy.resolvePolicyLane(
        callerContext.effectivePolicy
    );
    const routingTrace = {
        version: 1,
        request: {
            requestedModel: requestedModel || null,
            taskType: taskType || null,
            hostOverride: hostOverride || null,
            callerDetail: body.callerDetail || null,
            lane: laneName,
            laneRoutesTasks: lane.route === true,
            preview: null
        },
        lane: {
            name: laneName,
            route: lane.route === true,
            admit: lane.admit !== false,
            recordInferenceSync: lane.recordInferenceSync === true,
            alert: lane.alert
        },
        configured: null,
        recommendation: null,
        selected: null,
        artifactResolution: null,
        ollama: null,
        difference: null
    };

    let model = requestedModel;
    let target = null;
    let routedHostKey = null;
    let routingSource = hostOverride ? 'host_override' : 'model_router';

    if (lane.route && !model && taskType) {
        await ensureTaskModelOverridesLoaded();
        const configured = getModelForTask(taskType) || {};
        routingTrace.configured = {
            model: configured.model || null,
            host: configured.host || null,
            hostUrl: configured.url || null
        };
        const recommendation = await getAdvisoryModelForTask(taskType, {
            caller: body.callerDetail || 'inference-proxy',
            durationMs: Number(body.durationMs) || 30000,
            createSoftClaim: true
        });
        routingTrace.recommendation = summarizeRecommendation(recommendation);
        model = recommendation.model;
        target = hostOverride
            ? normalizeHostUrl(allowlistedHostOverride)
            : normalizeHostUrl(recommendation.url);
        routedHostKey = hostOverride ? resolveHostKey(target) : (recommendation.host || resolveHostKey(target));
        routingSource = hostOverride ? 'host_override' : (recommendation.source || 'task_router');
    } else if (!lane.route && !model && taskType) {
        // Direct lane: bench/profiler must specify model + host explicitly.
        // We do not run task→model routing for direct callers — they self-route.
        return res.status(400).json({
            status: 'error',
            message: 'direct-lane callers must specify `model` (and optionally `host`); taskType routing is not run for this lane'
        });
    } else {
        target = hostOverride
            ? normalizeHostUrl(allowlistedHostOverride)
            : normalizeHostUrl(getTargetForModel(model));
        routedHostKey = resolveHostKey(target);
        routingTrace.recommendation = hostOverride ? null : {
            model,
            host: routedHostKey || null,
            hostUrl: target,
            source: 'model_target',
            reason: 'Selected from model-to-host routing because no task-only recommendation was requested.',
            claimId: null,
            claimExpiresAt: null,
            readiness: null,
            scheduler: null
        };
    }

    if (!target) {
        const blockedByClaim = routingTrace.recommendation?.source === 'scheduler-blocked'
            || routingTrace.recommendation?.scheduler?.blockedByBenchmarkClaim === true;
        return res.status(blockedByClaim ? 503 : 500).json({
            status: 'error',
            code: blockedByClaim ? 'NO_UNCLAIMED_OLLAMA_HOST' : undefined,
            message: blockedByClaim
                ? (routingTrace.recommendation?.reason || `No unclaimed Ollama host available for request: ${taskType || model}`)
                : `No Ollama host configured for request: ${taskType || model}`
        });
    }

    try {
        await assertHostAvailableForConsumer(target, {
            callerDetail: body.callerDetail || null,
            model,
            path: '/api/inference/generate'
        });
    } catch (err) {
        return res.status(err.statusCode || 503).json({
            status: 'error',
            code: err.code || 'BENCHMARK_CLAIM_ACTIVE',
            message: err.message,
            data: {
                host: err.hostUrl || target,
                batchId: err.batchId || null,
                lane: laneName
            }
        });
    }

    // Exact-artifact invariant: never rewrite the caller-selected model tag.
    if (body.useAdapted === true) {
        return res.status(400).json({
            status: 'error',
            code: 'ADAPTED_MODEL_RESOLUTION_RETIRED',
            message: 'useAdapted is retired; request the exact installed model tag explicitly'
        });
    }
    const artifactResolution = {
        source: 'exact_artifact',
        requested: model,
        resolved: model,
        rewritten: false
    };
    routingTrace.artifactResolution = artifactResolution;

    if (lane.route && requireProfiledModels()) {
        const readinessState = await getModelReadiness(model, target);
        if (readinessState.readiness?.isReady !== true) {
            return res.status(409).json({
                status: 'error',
                message: `Model "${model}" is not profiled on the selected host. Enable profiling first or disable REQUIRE_PROFILED_MODELS.`,
                data: {
                    model,
                    host: target,
                    readiness: readinessState.readiness
                }
            });
        }
    }

    // Apply host preference keep_alive for pinned models. Each pinned entry
    // can carry its own keepAlive (post-0151 shape); fall back to legacy
    // per-host `keepAlive` if a pre-migration doc is still in use.
    // Skipped on the direct lane — bench/profiler control keep_alive themselves.
    if (lane.route) {
        const hostPrefService = require('../src/services/hostPreferenceService');
        const hostPref = await hostPrefService.getByHost(target);
        if (hostPref) {
            const pinnedEntry = hostPrefService.getPinnedEntries(hostPref).find(e => e.model === model);
            if (pinnedEntry) {
                keepAlive = pinnedEntry.keepAlive ?? -1;
                const pinnedContext = Number(pinnedEntry.contextSize);
                if (options.num_ctx == null && Number.isFinite(pinnedContext) && pinnedContext > 0) {
                    options.num_ctx = Math.round(pinnedContext);
                    numCtxSource = 'host_preference_pin';
                    routingSource = `${routingSource}+pin-ctx`;
                }
            }
        }
    }

    const inferenceContract = await resolveInferenceContract({
        model,
        host: target,
        prompt,
        messages,
        system,
        requestedNumCtx: options.num_ctx,
        numCtxSource,
        requestedMaxOutputTokens: options.num_predict
    }, { includeArtifactIdentity: requireProfiledModels() });
    if (requireProfiledModels() && inferenceContract.qualification?.qualified !== true) {
        return res.status(409).json({
            status: 'error',
            code: 'EXACT_ARTIFACT_PROFILE_REQUIRED',
            message: `Model "${model}" is not qualified for this exact host digest/runtime. Re-profile it before inference.`,
            data: { model, host: target, qualification: inferenceContract.qualification, artifact: inferenceContract.artifact }
        });
    }
    applyContractOutputLimit({ routed: lane.route, options, inferenceContract });
    const thinkingPolicy = resolveThinkingPolicy({
        requestedThink: think,
        thinkingMode,
        capabilityContract: inferenceContract,
        taskType,
        callerDetail: body.callerDetail,
        laneName,
        rawResponseRequested,
        stream
    });
    think = thinkingPolicy.think;
    routingTrace.thinking = thinkingPolicy;
    routingTrace.inferenceContract = inferenceContract;

    // Choose Ollama API: /api/chat if messages provided, else /api/generate
    const useChat = !!messages;
    const ollamaUrl = `${target}/api/${useChat ? 'chat' : 'generate'}`;

    const ollamaPayload = useChat
        ? { model, messages, stream, options, ...(think !== undefined && { think }), ...(keepAlive !== undefined && { keep_alive: keepAlive }) }
        : { model, prompt, system, stream, options, ...(think !== undefined && { think }), ...(keepAlive !== undefined && { keep_alive: keepAlive }) };
    routingTrace.request.preview = buildRequestPreview({ prompt, messages, system, options, stream, think, keepAlive });
    routingTrace.selected = {
        model,
        hostKey: routedHostKey || resolveHostKey(target) || null,
        hostUrl: target,
        routingSource
    };
    routingTrace.ollama = {
        api: useChat ? 'chat' : 'generate',
        endpoint: `/api/${useChat ? 'chat' : 'generate'}`,
        url: ollamaUrl,
        stream,
        think: think === undefined ? null : think,
        keepAlive: keepAlive === undefined ? null : keepAlive,
        options: options && typeof options === 'object' ? { ...options } : {}
    };
    routingTrace.difference = buildRoutingDifference(routingTrace);

    // Admission gate — per-(host, model) semaphore. Streaming bypasses because
    // long-lived streams would starve the gate for other callers.
    //
    // Lane policy:
    //   - direct lane: skip admission (bench/profiler self-sequence per host)
    //   - interactive: KEEP admission — load-bearing for cron fairness
    //   - automated:   keep admission
    const skipGate = stream || !lane.admit;
    const gateRelease = skipGate ? (() => {}) : await hostGate.acquire(target, model);

    // recordInference dispatcher honoring the lane's sync/async preference.
    // recordInference is self-contained (only reads its `data` arg, no req/res
    // capture) so deferring via process.nextTick is safe.
    const dispatchRecord = (entry) => {
        if (lane.recordInferenceSync) {
            recordInference(entry);
        } else {
            process.nextTick(() => recordInference(entry));
        }
    };

    /**
     * Describe one attempt as a RouteDecision v1 (task 0519).
     *
     * Pure and cheap — no I/O — because it runs on the telemetry path of every
     * inference call. It reports what this route actually decided rather than
     * re-deriving it: `selected` is the target chosen for this attempt, and on a
     * degraded retry `actual` differs from the original `primary`, which is what
     * makes a fallback visible in aggregate instead of just showing where
     * traffic landed.
     */
    const buildAttemptDecision = ({
        hostUrl, hostKey, attemptModel, attempt, attemptOptions,
        fallbackUsed, fallbackReason, durationMs,
    }) => {
        try {
            let mode = DECISION_MODES.DEFAULT;
            if (hostOverride) mode = DECISION_MODES.EXPLICIT_MODEL;
            else if (requestedModel && !taskType) mode = DECISION_MODES.EXPLICIT_MODEL;
            else if (taskType) mode = DECISION_MODES.EXPLICIT_TASK;

            return buildRouteDecision({
                mode,
                taskType: taskType || null,
                caller: 'proxy',
                callerDetail: body.callerDetail || null,
                consumerContract,
                correlationId: telemetryContext.correlationId,
                workItemId: telemetryContext.workItemId,
                runtime: telemetryContext.runtime,
                attempt,
                requestedModel: requestedModel || null,
                requestedHost: hostOverride || null,
                // `primary` is where the request was originally aimed; on a
                // retry that is deliberately NOT the host being recorded.
                primaryModel: model,
                primaryHostUrl: target,
                primaryHost: routedHostKey || resolveHostKey(target),
                selectedModel: attemptModel,
                selectedHost: hostKey || resolveHostKey(hostUrl),
                selectedHostUrl: hostUrl,
                fallbackUsed,
                fallbackReason,
                degraded: Boolean(fallbackUsed),
                degradedReason: fallbackReason,
                runtimeOptions: attemptOptions || undefined,
                classificationMs: routingTrace?.request?.classificationMs,
                totalMs: durationMs,
            });
        } catch (err) {
            // Telemetry must never break inference — the same rule the
            // surrounding recordInference path already follows.
            logger.debug('[InferenceProxy] route decision build failed', { error: err.message });
            return null;
        }
    };

    const dispatchAttemptRecord = ({
        hostUrl,
        hostKey,
        attemptModel,
        attempt,
        attemptData,
        attemptTrace,
        attemptContract = inferenceContract,
        attemptOptions,
        attemptNumCtxSource,
        durationMs,
        status,
        error,
        fallbackUsed = false,
        fallbackReason = null,
    }) => dispatchRecord({
        host: hostUrl,
        model: attemptModel,
        caller: 'proxy',
        callerDetail: body.callerDetail || null,
        consumerContract,
        ...telemetryContext,
        // RouteDecision v1 (task 0519). The contract shipped with a schema field
        // that nothing populated: 403 production calls over 24h carried zero
        // decisions, because this route never went through `routeRequest` (the
        // only place a decision was being built). Attaching it here — inside the
        // single telemetry funnel — gives every attempt its own decision,
        // including the degraded retry, and is why 0465 alerting has something
        // durable to read.
        routeDecision: buildAttemptDecision({
            hostUrl, hostKey, attemptModel, attempt, attemptOptions,
            fallbackUsed, fallbackReason, durationMs,
        }),
        observability: {
            contract: attemptContract,
            outcome: attemptData && status === 'success'
                ? summarizeOllamaOutcome(attemptData)
                : null,
            lane: laneName,
            campaignId: body.campaignId || body.batchId || telemetryContext.workItemId || null,
        },
        attempt,
        taskType: taskType || null,
        routed: !!taskType,
        routedModel: attemptModel,
        routedHost: hostKey || resolveHostKey(hostUrl),
        routedHostUrl: hostUrl,
        routingTrace: attemptTrace,
        num_ctx: attemptOptions?.num_ctx ?? null,
        num_ctx_source: attemptNumCtxSource,
        tokensIn: attemptData?.prompt_eval_count || 0,
        tokensOut: attemptData?.eval_count || 0,
        fallbackUsed,
        fallbackReason,
        durationMs,
        status,
        error: error || null,
    });

    const attemptDegradedResponse = (failure) => tryAndRespondDegraded({
        failure,
        res,
        body,
        consumerContract,
        telemetryContext,
        taskType,
        model,
        target,
        options,
        numCtxSource,
        artifactResolution,
        ollamaPayload,
        useChat,
        gateRelease,
        prompt,
        messages,
        system,
        requestedThink,
        thinkingMode,
        lane,
        laneName,
        rawResponseRequested,
        stream,
        skipGate,
        routingSource,
        routingTrace,
        requestedModel,
        dispatchAttemptRecord,
        buildRoutingDifference,
        timeoutMs: INFERENCE_FETCH_TIMEOUT_MS,
    });

    try {
        const primaryAttempt = await executeOllamaAttempt({
            hostUrl: target,
            payload: ollamaPayload,
            useChat,
            stream,
            timeoutMs: INFERENCE_FETCH_TIMEOUT_MS,
        });
        const { response, raw, data } = primaryAttempt;

        setInferenceResponseHeaders(res, {
            model,
            hostUrl: target,
            hostKey: routedHostKey || resolveHostKey(target),
            routingSource,
            laneName,
            rawResponseRequested,
            stream,
            thinkingPolicy,
            inferenceContract,
            taskType,
        });

        dispatchAttemptRecord({
            hostUrl: target,
            hostKey: routedHostKey || resolveHostKey(target),
            attemptModel: model,
            attempt: telemetryContext.attempt,
            attemptData: data,
            attemptTrace: routingTrace,
            attemptOptions: options,
            attemptNumCtxSource: numCtxSource,
            durationMs: Date.now() - startedAt,
            status: response.ok ? 'success' : 'error',
        });

        // Fire-and-forget alert evaluation. Lane policy:
        //   - 'error-only': skip latency alerts; keep error alerts
        //   - true: full alerts
        //   - false: would skip entirely (no lane uses this today)
        if (lane.alert) {
            try {
                const alertSvc = alertService;
                if (alertSvc) {
                    const durationMs = Date.now() - startedAt;
                    const alertComponent = routedHostKey || resolveHostKey(target) || 'inference';
                    if (response.ok) {
                        alertSvc.resolveRecoveredInferenceAlerts?.({
                            host: target,
                            hostKey: alertComponent,
                            model,
                            latencyMs: durationMs
                        }).catch(() => {});
                    }
                    if (response.ok && durationMs > 10000 && lane.alert !== 'error-only') {
                        alertSvc.evaluateEvent({
                            component: alertComponent, metric: 'latency',
                            value: durationMs, threshold: 10000, trend: 'spike',
                            source: 'inference-proxy',
                            additionalData: { model, host: target, caller: body.callerDetail, taskType: taskType || null, lane: laneName }
                        }).catch(() => {});
                    }
                    if (!response.ok) {
                        alertSvc.evaluateEvent({
                            component: alertComponent, metric: 'error',
                            value: 1, source: 'inference-proxy',
                            additionalData: { model, host: target, status: response.status, taskType: taskType || null, lane: laneName }
                        }).catch(() => {});
                    }
                }
            } catch { /* never block inference response */ }
        }

        if (!response.ok) {
            const degradedResponded = await attemptDegradedResponse(
                classifyHttpRetryFailure(response.status, data, raw)
            );
            if (degradedResponded) return undefined;
            emitBuddyEvent('inference_error', 'infrastructure', 'Inference failed: ' + model + ' (' + response.status + ')', 'high');
            return res.status(response.status).json({
                status: 'error',
                message: data?.error || raw || 'Ollama request failed',
            });
        }

        const clientData = buildInferenceClientData(
            data,
            model,
            inferenceContract,
            body,
            rawResponseRequested,
            stream
        );
        res.json(clientData);

        // Shadow route evaluation (task 0522), deliberately AFTER the reply is
        // sent. Inline it would add a Mongo read and a scoring pass to the
        // hottest path on the platform, and any bug in it would become a
        // user-visible failure. Deferred, the worst case is a missing
        // comparison sample. No-op unless ROUTE_RESOLVER_SHADOW is enabled.
        scheduleShadowEvaluation(
            { model, hostUrl: target },
            {
                taskType: taskType || null,
                requestedModel: requestedModel || null,
                caller: 'proxy',
                callerDetail: body.callerDetail || null,
                correlationId: telemetryContext.correlationId,
                cloudEligible: false,
                requiredContextTokens: options.num_ctx,
            }
        );
        return undefined;
    } catch (err) {
        if (err.isOllamaAttemptError !== true) {
            logger.error('[InferenceProxy] response processing failed', {
                host: target,
                model,
                error: err.message,
                headersSent: res.headersSent,
            });
            if (res.headersSent) return undefined;
            return res.status(500).json({ status: 'error', message: 'Inference response processing failed' });
        }

        const isTimeout = err.name === 'AbortError';
        if (isTimeout) {
            logger.warn('[InferenceProxy] fetch timeout — gate slot released', {
                host: target, model, timeoutMs: INFERENCE_FETCH_TIMEOUT_MS, lane: laneName
            });
        }

        dispatchAttemptRecord({
            hostUrl: target,
            hostKey: routedHostKey || resolveHostKey(target),
            attemptModel: model,
            attempt: telemetryContext.attempt,
            attemptTrace: routingTrace,
            attemptOptions: options,
            attemptNumCtxSource: numCtxSource,
            durationMs: Date.now() - startedAt,
            status: 'error',
            error: isTimeout ? `fetch_timeout_${INFERENCE_FETCH_TIMEOUT_MS}ms` : err.message,
        });

        // Fire-and-forget alert evaluation for host unreachable.
        // 'error-only' direct lane still emits these; 'false' (no lane today) would skip.
        if (lane.alert) {
            try {
                const alertSvc = alertService;
                if (alertSvc) {
                    alertSvc.evaluateEvent({
                        component: routedHostKey || resolveHostKey(target) || 'inference',
                        metric: isTimeout ? 'fetch_timeout' : 'host_unreachable',
                        value: 1, source: 'inference-proxy',
                        additionalData: { model, host: target, error: err.message, taskType: taskType || null, lane: laneName }
                    }).catch(() => {});
                }
            } catch { /* never block */ }
        }

        const degradedResponded = await attemptDegradedResponse(
            isTimeout
                ? { kind: 'timeout', streamStarted: false }
                : { kind: 'connection' }
        );
        if (degradedResponded) return undefined;

        emitBuddyEvent('inference_error', 'infrastructure',
            isTimeout
                ? 'Inference timeout: ' + model + ' @ ' + target
                : 'Host unreachable: ' + model + ' @ ' + target,
            'high');
        return res.status(isTimeout ? 504 : 502).json({ status: 'error', message: err.message });
    } finally {
        gateRelease();
    }
});

router.get('/router/gate-stats', (_req, res) => {
    try {
        res.json({ status: 'success', data: hostGate.stats() });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/router/config', async (_req, res) => {
    try {
        const data = await buildRouterConfigPayload();
        res.json({ status: 'success', data });
    } catch (err) {
        logger.error('Failed to fetch router config', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/router/config/defaults', async (_req, res) => {
    try {
        await ensureTaskModelOverridesLoaded();
        res.json({
            status: 'success',
            data: {
                taskModels: getDefaultTaskModels(),
                hosts: { ...HOSTS }
            }
        });
    } catch (err) {
        logger.error('Failed to fetch router defaults', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.put('/router/config/tasks/:taskType', async (req, res) => {
    try {
        const { taskType } = req.params;
        const state = req.body?.resetToDefault === true
            ? await resetTaskModelOverride(taskType)
            : await saveTaskModelOverride(taskType, req.body || {});

        res.json({
            status: 'success',
            data: {
                taskType,
                ...state
            }
        });
    } catch (err) {
        logger.error('Failed to update router task config', {
            taskType: req.params.taskType,
            error: err.message
        });
        res.status(err.statusCode || 500).json({ status: 'error', message: err.message });
    }
});

router.post('/router/config/reset', async (req, res) => {
    if (req.body?.confirmDeploymentDefaults !== true) {
        return res.status(409).json({
            status: 'error',
            code: 'deployment_defaults_confirmation_required',
            message: 'Bulk reset removes every app override. Retry with confirmDeploymentDefaults: true after reviewing GET /api/router/config/defaults.'
        });
    }
    try {
        const taskConfigState = await resetAllTaskModelOverrides();
        const data = await buildRouterConfigPayload();
        data.taskConfigState = taskConfigState;
        res.json({ status: 'success', data });
    } catch (err) {
        logger.error('Failed to reset router config', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// MODEL ROUTING: Get routing configuration and status
router.get('/models/routing', async (req, res) => {
    try {
        const status = await getRoutingStatus();
        const config = await buildRouterConfigPayload();
        res.json({
            status: 'success',
            data: {
                ...status,
                taskMetadata: config.taskMetadata,
                explainerSteps: config.explainerSteps,
                classification: config.classification,
                defaults: config.defaults,
                overrides: config.overrides,
                taskConfigState: config.taskConfigState,
                availableModels: config.availableModels
            }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// MODEL ROUTING: Classify a query (preview routing decision)
router.post('/models/classify', async (req, res) => {
    const { message } = req.body;
    if (!message) {
        return res.status(400).json({ status: 'error', message: 'Message is required' });
    }
    try {
        await ensureTaskModelOverridesLoaded();
        const classification = await classifyQuery(message);
        const recommendation = requireProfiledModels()
            ? await resolvePreferredTaskEntry(classification)
            : getModelForTask(classification);
        res.json({
            status: 'success',
            data: {
                taskType: classification,
                recommendedModel: recommendation.model,
                recommendedHost: recommendation.host,
                hostUrl: recommendation.url
            }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/models/health', async (req, res) => {
    try {
        const { host, model } = req.query;

        if (host && model) {
            const validation = validateHostUrl(host);
            if (!validation.valid) {
                return res.status(400).json({ status: 'error', message: validation.message });
            }
            const health = await getModelHealth(validation.host || host, model);
            return res.json({ status: 'success', data: { health } });
        }

        const allHealth = await getAllModelsHealth();
        res.json({ status: 'success', data: { models: allHealth } });
    } catch (err) {
        logger.error('Failed to get model health', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});


// Test seam for the embed liveness cache, mirroring hostGate._resetForTests().
// The cache is module-level and TTL'd, so without this the probe result from
// one test leaks into the next.
router._resetEmbedLivenessForTests = () => embedLiveness.clear();

module.exports = router;
