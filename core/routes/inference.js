/**
 * Inference routes — caller-aware execution lanes.
 *
 * /api/inference/generate selects one of three performance lanes from the
 * declared caller policy. `callerDetail` remains telemetry metadata.
 * Every lane preserves the exact requested model tag. The
 * retired `useAdapted: true` property is rejected instead of silently changing
 * artifact identity.
 *
 * The private-LAN product uses plain caller attribution. Benchmark operations
 * still carry exact Core-owned reservation proof so chat and evaluation do
 * not change a host's loaded model while another request is using it.
 */
const express = require('express');
const { requestPrincipal } = require('../src/helpers/requestCaller');
const router = express.Router();
const { executeInference } = require('../src/services/inferenceService');
const logger = require('../config/logger');
const fetch = require('node-fetch');
const { resolveTarget } = require('../src/helpers/ollamaUtils');
const { normalizeHostUrl, validateHostUrl, getHostUrls, hostUrlKey } = require('../src/helpers/ollamaHostConfig');
const { requireTypedConfirmation } = require('../src/helpers/typedConfirmation');
const { runRuntimeMutation } = require('../src/services/runtimeMutationLeaseService');
const { HOSTS, buildRouterConfigPayload, ensureTaskModelOverridesLoaded, getDefaultTaskModels, getModelForTask, resolvePreferredTaskEntry, getRoutingConfigVersion, resetAllTaskModelOverrides, resetTaskModelOverride, saveTaskModelOverride } = require('../src/services/modelRouterConfig');
const { getRoutingStatus, classifyQuery, getModelHealth, getAllModelsHealth, getTargetForModel, recordInference, resolveHostKey } = require('../src/services/modelRouter');
const { getRagServiceClient } = require('../src/services/ragServiceClient');
const { emit: emitBuddyEvent } = require('../src/services/buddyEvents');
const { getModelReadiness } = require('../src/services/modelReadinessService');
const hostGate = require('../src/services/hostGate');

const { buildRouteDecision, DECISION_MODES, REJECTION_REASONS, ROUTE_OUTCOME_CODES, ROUTE_OUTCOME_STAGES } = require('../src/services/routing/routeDecision');

const { resolveEmbeddingKeepAlive } = require('../src/services/inferenceRuntimePolicy');

const { resolveInferenceRequestCaller } = require('../src/services/routing/inferenceCallerAccess');

const { resolveInferenceContractSnapshot } = require('../src/services/inferenceContractService');
const { telemetryContextFromRequest } = require('../src/helpers/llmTelemetryContext');
const { beginInferenceAdmission } = require('../src/services/inferenceAdmissionService');
const { trustedNestorConsumer } = require('../src/services/nestorConsumerAttribution');
const alertService = require('../src/services/alertService');

const ragStore = getRagServiceClient();

function safeRoutingConfigVersion() {
    return typeof getRoutingConfigVersion === 'function'
        ? getRoutingConfigVersion()
        : 'router-unversioned-v1';
}

function createInferenceDisconnectSignal(req, res) {
    const controller = new AbortController();
    let complete = false;

    const cancel = () => {
        if (complete || controller.signal.aborted) return;
        controller.abort(new Error('Inference caller disconnected'));
    };
    const handleResponseClose = () => {
        // ServerResponse emits `close` after an ordinary completed response too.
        // Only a close before either completion flag is a caller disconnect.
        if (res.writableEnded || res.writableFinished) return;
        cancel();
    };

    req.once('aborted', cancel);
    res.once('close', handleResponseClose);

    // The caller can disappear during earlier routing work, before this
    // deliberately bounded listener window begins.
    if (req.aborted || (res.destroyed && !res.writableEnded && !res.writableFinished)) {
        cancel();
    }

    return {
        signal: controller.signal,
        isDisconnected() {
            return controller.signal.aborted
                || (res.destroyed && !res.writableEnded && !res.writableFinished);
        },
        cleanup() {
            complete = true;
            req.off('aborted', cancel);
            res.off('close', handleResponseClose);
        }
    };
}

function requireProfiledModels() {
  return process.env.REQUIRE_PROFILED_MODELS === 'true';
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
    const buildEmbedDecision = ({
        candidate, attempt, fallbackUsed, fallbackReason, status, reasonCode
    }) => {
        try {
            const terminalStage = fallbackUsed
                ? ROUTE_OUTCOME_STAGES.FALLBACK
                : ROUTE_OUTCOME_STAGES.EXECUTION;
            const terminalCode = status === 'success'
                ? (fallbackUsed
                    ? ROUTE_OUTCOME_CODES.FALLBACK_SUCCEEDED
                    : ROUTE_OUTCOME_CODES.EXECUTION_SUCCEEDED)
                : status === 'timeout'
                    ? (fallbackUsed
                        ? ROUTE_OUTCOME_CODES.FALLBACK_FAILED
                        : ROUTE_OUTCOME_CODES.UPSTREAM_TIMEOUT)
                    : (fallbackUsed
                        ? ROUTE_OUTCOME_CODES.FALLBACK_FAILED
                        : ROUTE_OUTCOME_CODES.UPSTREAM_ERROR);
            return buildRouteDecision({
                configVersion: safeRoutingConfigVersion(),
                mode: DECISION_MODES.EXPLICIT_MODEL,
                selectionSource: embedHostCheck.host ? 'host_override' : 'model_target',
                outcomeStage: terminalStage,
                outcomeCode: terminalCode,
                outcomeReasonCode: reasonCode,
                caller: 'embedding',
                callerDetail: body.callerDetail || null,
                consumerContract,
                correlationId: telemetryContext.correlationId,
                workItemId: telemetryContext.workItemId,
                runtime: telemetryContext.runtime,
                attempt,
                requestedModel: model,
                requestedHost: resolveHostKey(ollamaHostOverride),
                requestedHostUrl: ollamaHostOverride || null,
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
    let lastFailureReason = null;
    let embedAdmission = null;

    try {
        for (const [candidateIndex, candidate] of candidates.entries()) {
            attemptTarget = candidate;
            // Why we moved off the previous candidate — captured before this
            // attempt's own failure can overwrite the stable failure code.
            const attemptFallbackReasonCode = candidateIndex > 0 ? lastFailureReason : null;

            // Skip a dead host without burning the full embed budget.
            if (!await isEmbedHostLive(candidate)) {
                lastError = new Error(`Embedding host ${candidate} is unreachable`);
                lastFailureReason = REJECTION_REASONS.HOST_OFFLINE;
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
                        fallbackReason: attemptFallbackReasonCode,
                        status: 'error',
                        reasonCode: REJECTION_REASONS.HOST_OFFLINE,
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
                embedAdmission = await beginInferenceAdmission({
                    host: candidate,
                    model,
                    kind: 'embedding',
                    principal: resolveInferenceRequestCaller(req).principal,
                    ...(keepAlive !== undefined && { keepAlive }),
                    signal: controller.signal
                });
                embedAdmission.markDispatched();
                response = await fetch(`${candidate}/api/embeddings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model,
                        prompt,
                        ...(keepAlive !== undefined && { keep_alive: keepAlive })
                    }),
                    signal: embedAdmission.signal
                });
            } catch (err) {
                if (embedAdmission) {
                    await embedAdmission.abandon(err);
                    embedAdmission = null;
                }
                const failureReason = err.name === 'AbortError'
                    ? 'pre_response_timeout'
                    : 'connection_failure';
                const failureStatus = err.name === 'AbortError' ? 'timeout' : 'error';
                lastError = err.name === 'AbortError'
                    ? new Error(`Embedding request to ${candidate} timed out after ${EMBED_TIMEOUT_MS}ms`)
                    : err;
                lastFailureReason = failureReason;
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
                        fallbackReason: attemptFallbackReasonCode,
                        status: failureStatus,
                        reasonCode: failureReason,
                    }),
                    num_ctx: null,
                    num_ctx_source: 'n/a',
                    durationMs: Date.now() - startedAt,
                    status: failureStatus,
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
        const finalDecision = (status, reasonCode = null) => buildEmbedDecision({
            candidate: target,
            attempt: attemptNumber,
            fallbackUsed,
            fallbackReason: fallbackUsed ? lastFailureReason : null,
            status,
            reasonCode,
        });

        try {
            raw = await response.text();
            await embedAdmission.complete();
            embedAdmission = null;
        } catch (error) {
            if (embedAdmission) {
                await embedAdmission.abandon(error);
                embedAdmission = null;
            }
            throw error;
        }
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
                routeDecision: finalDecision('error', `upstream_http_${response.status}`),
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
                routeDecision: finalDecision('error', 'invalid_upstream_response'),
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
            routeDecision: finalDecision('success', fallbackUsed ? lastFailureReason : null),
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
        if (embedAdmission) {
            await embedAdmission.abandon(err).catch(quarantineError => {
                err.inferenceQuarantineError = quarantineError;
            });
            embedAdmission = null;
        }
        // Terminal failure — usually every candidate was rejected. The
        // decision still gets built so the exhausted-fleet case is attributed,
        // with the rejection list carrying which hosts were tried and why.
        const exhaustedFallback = hostUrlKey(attemptTarget) !== hostUrlKey(routedTarget);
        const terminalStatus = lastFailureReason === 'pre_response_timeout' ? 'timeout' : 'error';
        recordInference({
            host: target,
            model,
            caller: 'embedding',
            routeDecision: buildEmbedDecision({
                candidate: attemptTarget,
                attempt: Math.max(candidates.findIndex(candidate => hostUrlKey(candidate) === hostUrlKey(attemptTarget)) + 1, 1),
                fallbackUsed: exhaustedFallback,
                fallbackReason: exhaustedFallback ? lastFailureReason : null,
                status: terminalStatus,
                reasonCode: lastFailureReason || 'connection_failure',
            }),
            num_ctx: null,
            num_ctx_source: 'n/a',
            durationMs: Date.now() - startedAt,
            status: terminalStatus,
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
    const disconnect = createInferenceDisconnectSignal(req, res);
    try {
        const result = await executeInference(req.body || {}, {
            callerContext: req.inferenceCallerContext || resolveInferenceRequestCaller(req),
            consumerContract: trustedNestorConsumer(req),
            telemetryContext: telemetryContextFromRequest(req, 'agentx'),
            signal: disconnect.signal,
        });
        if (result && !disconnect.isDisconnected()) {
            res.set(result.headers).status(result.status).json(result.body);
        }
    } finally {
        disconnect.cleanup();
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
        const state = await runRuntimeMutation({
            principal: requestPrincipal(req),
            scope: `router-task-config:${taskType}`
        }, () => req.body?.resetToDefault === true
            ? resetTaskModelOverride(taskType)
            : saveTaskModelOverride(taskType, req.body || {}));

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
    if (!requireTypedConfirmation(req, res, 'RESET ROUTER CONFIG')) return;
    try {
        const taskConfigState = await runRuntimeMutation({
            principal: requestPrincipal(req),
            scope: 'router-task-config:reset-all'
        }, () => resetAllTaskModelOverrides());
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
