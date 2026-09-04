/**
 * Model Warmup
 * Pre-execution model warmup and VRAM readiness verification.
 *
 * Core invariant (2026-04-18): a benchmark test must run with the target
 * model AS THE ONLY large model on the host. Any other model still loaded
 * competes for VRAM and can cause Ollama to accept the request but return
 * an empty response (observed: HTTP 200, 0 tokens, 7 ms latency). So
 * warmupModel unloads everything else on the host before warming the target.
 * Embedding and judge-on-same-host exceptions are configurable.
 */

const logger = require('../../../config/logger');
const nodeFetch = require('node-fetch');
const { isSameOllamaModel } = require('../../helpers/ollamaModelIdentity');
const { withBenchmarkServiceAuth } = require('../../helpers/coreServiceAuth');
const { getConfiguredHosts } = require('../../helpers/ollamaHostConfig');
const { admitOllamaTargetResolved } = require('../../helpers/ollamaTargetAdmission');
const { createNodeFetchPeerTransport } = require('../../helpers/outboundHttpTransport');
const {
    OUTBOUND_ERROR_CODES,
    createOutboundHttpExecutor,
    discardBoundedResponse,
    readBoundedJson,
    readBoundedText
} = require('../../../../shared/outboundHttpExecutor');

// Warmup routes through core's /api/inference/generate. As of task 0168,
// the scoped Benchmark credential plus `callerDetail: 'benchmark-warmup'`
// selects the **direct lane** (no probe, no gate, no Mongo, async telemetry)
// so warmup keeps its low overhead
// WITHOUT losing telemetry. /api/ps probe + keep_alive:0 unloads stay
// direct — metadata + admin ops.
const CORE_URL = process.env.CORE_URL || 'http://localhost:3080';

const MODEL_WARMUP_OPERATIONS = Object.freeze({
    UNLOAD_OTHERS: 'benchmark.model-warmup.unload-others',
    UNLOAD_ONE: 'benchmark.model-warmup.unload-one',
    PS: 'benchmark.model-warmup.ps',
    GENERATE: 'benchmark.model-warmup.generate'
});

function operation(authoritySource, method, pathPattern, {
    deadlineMs,
    maxRequestBytes = 0,
    maxResponseBytes,
    responseMode
}) {
    return Object.freeze({
        allowSearch: false,
        method,
        pathPattern,
        responseMode,
        policy: Object.freeze({
            authoritySource,
            deadlineMs,
            maxRequestBytes,
            maxResponseBytes
        })
    });
}

const MODEL_WARMUP_OPERATION_SPECS = Object.freeze({
    [MODEL_WARMUP_OPERATIONS.UNLOAD_OTHERS]: operation(
        'request-admitted',
        'POST',
        '^/api/generate$',
        {
            deadlineMs: 5_000,
            maxRequestBytes: 64 * 1024,
            maxResponseBytes: 64 * 1024,
            responseMode: 'discard'
        }
    ),
    [MODEL_WARMUP_OPERATIONS.UNLOAD_ONE]: operation(
        'request-admitted',
        'POST',
        '^/api/generate$',
        {
            deadlineMs: 5_000,
            maxRequestBytes: 64 * 1024,
            maxResponseBytes: 64 * 1024,
            responseMode: 'discard'
        }
    ),
    [MODEL_WARMUP_OPERATIONS.PS]: operation(
        'request-admitted',
        'GET',
        '^/api/ps$',
        {
            deadlineMs: 5_000,
            maxResponseBytes: 1024 * 1024,
            responseMode: 'json'
        }
    ),
    [MODEL_WARMUP_OPERATIONS.GENERATE]: operation(
        'configured',
        'POST',
        '^/api/inference/generate$',
        {
            deadlineMs: 600_000,
            maxRequestBytes: 1024 * 1024,
            maxResponseBytes: 1024 * 1024,
            responseMode: 'json'
        }
    )
});

function configuredCoreOrigin(coreUrl = CORE_URL) {
    let parsed;
    try {
        parsed = new URL(coreUrl);
    } catch {
        throw new Error('Core service URL is invalid');
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        || parsed.username
        || parsed.password
        || parsed.pathname !== '/'
        || parsed.search
        || parsed.hash) {
        throw new Error('Core service URL is invalid');
    }
    return parsed.origin;
}

function operationMatches(spec, method, target) {
    return spec.method === method
        && new RegExp(spec.pathPattern).test(target.pathname)
        && (spec.allowSearch || !target.search);
}

function assertRegisteredOperation(operationId, method, target) {
    const spec = MODEL_WARMUP_OPERATION_SPECS[operationId];
    if (!spec || !operationMatches(spec, method, target)) {
        throw new Error('Model warmup outbound operation is not registered');
    }
    return spec;
}

function createModelWarmupExecutor(options = {}) {
    const admitTarget = options.admitOllamaTargetResolved || admitOllamaTargetResolved;
    const configuredHosts = options.getConfiguredHosts || getConfiguredHosts;
    const coreUrl = options.coreUrl || CORE_URL;

    return createOutboundHttpExecutor({
        operations: Object.fromEntries(Object.entries(MODEL_WARMUP_OPERATION_SPECS)
            .map(([operationId, spec]) => [operationId, spec.policy])),
        authorityAdapter: async ({ sinkId, target }) => {
            const spec = MODEL_WARMUP_OPERATION_SPECS[sinkId];
            const requested = new URL(target);
            if (!spec
                || !new RegExp(spec.pathPattern).test(requested.pathname)
                || (!spec.allowSearch && requested.search)) {
                throw new Error('Model warmup outbound target is not registered');
            }

            if (sinkId === MODEL_WARMUP_OPERATIONS.GENERATE) {
                const coreOrigin = configuredCoreOrigin(coreUrl);
                if (requested.origin !== coreOrigin) {
                    throw new Error('Model warmup Core target is not configured');
                }
                return { expectedOrigin: coreOrigin };
            }

            const expectedOrigin = await admitTarget(requested.origin, {
                configuredHosts: configuredHosts()
            });
            if (requested.origin !== expectedOrigin) {
                throw new Error('Model warmup Ollama target is not admitted');
            }
            return { expectedOrigin };
        },
        fetchImpl: options.fetchImpl || nodeFetch,
        transportAdapter: options.transportAdapter || createNodeFetchPeerTransport()
    });
}

const modelWarmupExecutor = createModelWarmupExecutor();

async function modelWarmupRequest(operationId, target, options = {}, executor = modelWarmupExecutor) {
    let requested;
    try {
        requested = new URL(target);
    } catch {
        throw new Error('Model warmup outbound target is not registered');
    }
    const method = String(options.method || 'GET').toUpperCase();
    assertRegisteredOperation(operationId, method, requested);
    const receipt = await executor.admitTarget(operationId, requested.href, {
        signal: options.signal
    });
    return executor.request(receipt, {
        ...options,
        method
    });
}

function createLocalDeadline(timeoutMs, maximumMs) {
    const parsed = Number(timeoutMs);
    const durationMs = Number.isFinite(parsed)
        ? Math.min(Math.max(0, Math.round(parsed)), maximumMs)
        : maximumMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), durationMs);
    timer.unref?.();
    return Object.freeze({
        signal: controller.signal,
        dispose: () => clearTimeout(timer),
        get expired() { return controller.signal.aborted; }
    });
}

function combineAbortSignals(...signals) {
    const active = signals.filter(Boolean);
    if (!active.length) return undefined;
    if (active.length === 1) return active[0];
    return AbortSignal.any(active);
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    const error = new Error('Benchmark claim stopped while model warmup was running');
    error.code = 'BENCHMARK_CLAIM_STOPPED';
    throw error;
}

// Models that should NOT be unloaded during pre-warmup (always stay resident):
//   - embeddings: small, shared across consumers, cheap to keep
// Callers can extend via options.keepLoaded (e.g., judge model on same host).
const ALWAYS_KEEP_LOADED_PATTERNS = [
    /embed/i,
    /^nomic-/i,
    /^bge-/i
];

function shouldKeepLoaded(modelName, keepList = []) {
    if (!modelName) return false;
    if (keepList.some(k => isSameOllamaModel(k, modelName))) return true;
    return ALWAYS_KEEP_LOADED_PATTERNS.some(rx => rx.test(modelName));
}

const UNLOAD_TIMEOUT_MS = 5000;

/**
 * Unload every listed model except the target and any caller-kept ones.
 * `loadedNames` comes from the caller's single /api/ps probe — we don't
 * re-fetch here to avoid breaking callers that mock /api/ps only once.
 *
 * Unloads run in parallel — each `keep_alive: 0` call is independent on
 * the Ollama side, and serialising them on a host with 8+ loaded models
 * was adding ~30–90s to benchmark batch startup for no benefit.
 */
async function unloadOthers(hostUrl, targetModel, loadedNames, keepLoaded, executor, signal = null) {
    const names = Array.isArray(loadedNames) ? loadedNames : [];
    if (names.length === 0) return [];

    const toUnload = names.filter(name =>
        !isSameOllamaModel(name, targetModel) && !shouldKeepLoaded(name, keepLoaded)
    );
    if (toUnload.length === 0) return [];

    const results = await Promise.all(toUnload.map(async (name) => {
        const deadline = createLocalDeadline(
            UNLOAD_TIMEOUT_MS,
            MODEL_WARMUP_OPERATION_SPECS[MODEL_WARMUP_OPERATIONS.UNLOAD_OTHERS].policy.deadlineMs
        );
        try {
            const response = await modelWarmupRequest(
                MODEL_WARMUP_OPERATIONS.UNLOAD_OTHERS,
                `${hostUrl}/api/generate`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: name, keep_alive: 0, stream: false }),
                    signal: combineAbortSignals(deadline.signal, signal)
                },
                executor
            );
            if (response.ok) await discardBoundedResponse(response);
            else await response.cancel();
            return name;
        } catch (err) {
            throwIfAborted(signal);
            err.retainAdmission = true;
            err.code = err.code || 'OLLAMA_UNLOAD_TERMINALITY_UNKNOWN';
            throw err;
        } finally {
            deadline.dispose();
        }
    }));

    const unloaded = results.filter(Boolean);
    if (unloaded.length > 0) {
        logger.info('[warmup] cleared VRAM before warmup', { hostUrl, targetModel, unloaded });
    }
    return unloaded;
}

function readLoadedContextLength(modelInfo) {
    const value = modelInfo?.context_length ?? modelInfo?.contextLength ?? modelInfo?.details?.context_length;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

async function unloadLoadedModel(hostUrl, modelName, executor, signal = null) {
    const deadline = createLocalDeadline(
        UNLOAD_TIMEOUT_MS,
        MODEL_WARMUP_OPERATION_SPECS[MODEL_WARMUP_OPERATIONS.UNLOAD_ONE].policy.deadlineMs
    );
    try {
        const response = await modelWarmupRequest(
            MODEL_WARMUP_OPERATIONS.UNLOAD_ONE,
            `${hostUrl}/api/generate`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: modelName, keep_alive: 0, stream: false }),
                signal: combineAbortSignals(deadline.signal, signal)
            },
            executor
        );
        if (response.ok) await discardBoundedResponse(response);
        else await response.cancel();
    } finally {
        deadline.dispose();
    }
}

function normalizeWarmupError(err, timeoutMs) {
    const rawMessage = String(err?.message || '').trim();
    const aborted = err?.name === 'AbortError' ||
        err?.type === 'aborted' ||
        err?.code === OUTBOUND_ERROR_CODES.CALLER_ABORTED ||
        err?.code === OUTBOUND_ERROR_CODES.DEADLINE_EXCEEDED ||
        /aborted|aborterror/i.test(rawMessage);
    if (aborted) {
        const timeoutSec = Math.max(1, Math.round((Number(timeoutMs) || 0) / 1000));
        return `Warmup timed out after ${timeoutSec}s (model may still be loading)`;
    }
    if (err?.code === OUTBOUND_ERROR_CODES.REDIRECT_REJECTED && Number.isInteger(err.status)) {
        return `Warmup failed: HTTP ${err.status}`;
    }
    return rawMessage || 'Warmup failed';
}

/**
 * Warm up a model by sending a minimal request
 * When response comes back, model is loaded in VRAM and ready for fast tests
 *
 * @param {string} hostUrl - Ollama host URL
 * @param {string} model - Model name to warm up
 * @param {Object} options - Optional settings
 * @param {string} options.timelinePrefix - Timeline event prefix for batch tracking
 * @param {Function} options.recordTimelineEvent - Async callback for timeline events
 * @param {boolean} options.strict - When true, throw on failure instead of swallowing
 * @param {number} options.num_ctx - Context window size to match test execution parameters
 * @returns {Object} Warmup data for validation/debugging
 */
async function warmupModel(hostUrl, model, options = {}) {
    const {
        timelinePrefix = null,
        recordTimelineEvent = null,
        strict = false,
        num_ctx = null,
        _fetch = nodeFetch,
        _executor = null,
        _transportAdapter = null,
        timeoutOverride = null,
        warmupTimeoutCold = null,
        warmupTimeoutLoaded = null,
        // Pre-unload invariant: clear everything else on the host before warming.
        // Defaults to on; flip false for the judge's own warmup (it IS the thing
        // that should coexist with test models on the same host).
        preUnloadOthers = true,
        // Extra models to keep loaded when pre-unloading (e.g., the judge model
        // when the test is running on the same host). Embedding/nomic/bge are
        // always kept per ALWAYS_KEEP_LOADED_PATTERNS.
        keepLoaded = [],
        claimIdentity = null,
        assertClaimActive = null,
        signal = null,
        // Optional callback for sub-phase progress strings (UI visibility).
        onPhaseDetail = null
    } = options;
    const executor = _executor || (
        _fetch !== nodeFetch || _transportAdapter
            ? createModelWarmupExecutor({
                fetchImpl: _fetch,
                transportAdapter: _transportAdapter
            })
            : modelWarmupExecutor
    );
    const warmupStart = Date.now();
    const checkpoint = typeof assertClaimActive === 'function' ? assertClaimActive : () => {};
    checkpoint();
    const warmupPrompt = 'Hi';
    let timeoutMs = timeoutOverride !== null ? timeoutOverride : (warmupTimeoutCold || 180000);
    const warmupData = {
        prompt: warmupPrompt,
        response: null,
        latency_ms: null,
        already_loaded: null,
        success: false,
        error: null
    };

    if (timelinePrefix && recordTimelineEvent) {
        await recordTimelineEvent(`${timelinePrefix}_start`, { model, success: null });
    }

    try {
        // Check if model is already loaded in VRAM via /api/ps
        let modelAlreadyLoaded = false;
        let loadedModels = [];
        let loadedTarget = null;
        try {
            const psDeadline = createLocalDeadline(
                5_000,
                MODEL_WARMUP_OPERATION_SPECS[MODEL_WARMUP_OPERATIONS.PS].policy.deadlineMs
            );
            let psResponse;
            try {
                psResponse = await modelWarmupRequest(
                    MODEL_WARMUP_OPERATIONS.PS,
                    `${hostUrl}/api/ps`,
                    {
                        method: 'GET',
                        signal: combineAbortSignals(psDeadline.signal, signal)
                    },
                    executor
                );

                if (psResponse.ok) {
                    const psData = await readBoundedJson(psResponse);
                    const loadedInfos = psData.models || [];
                    loadedModels = loadedInfos.map(m => m.name || m.model).filter(Boolean);
                    loadedTarget = loadedInfos.find((loaded) => isSameOllamaModel(loaded.name || loaded.model, model)) || null;
                    modelAlreadyLoaded = !!loadedTarget;
                    if (modelAlreadyLoaded) {
                        logger.debug('Model already loaded in VRAM', { host: hostUrl, model, loadedModels });
                    }
                } else {
                    // Inventory failure is best-effort. Preserve the status-first
                    // behavior and do not let an error body delay warmup.
                    await psResponse.cancel();
                }
            } finally {
                psDeadline.dispose();
            }
        } catch (psErr) {
            throwIfAborted(signal);
            logger.debug('Could not check /api/ps', { host: hostUrl, error: psErr.message });
        }

        warmupData.already_loaded = modelAlreadyLoaded;

        const requestedNumCtx = Number.isFinite(Number(num_ctx)) && Number(num_ctx) > 0
            ? Math.round(Number(num_ctx))
            : null;
        const loadedNumCtx = readLoadedContextLength(loadedTarget);
        const contextMismatch = !!(modelAlreadyLoaded && requestedNumCtx && loadedNumCtx && loadedNumCtx !== requestedNumCtx);
        if (contextMismatch) {
            checkpoint();
            const loadedName = loadedTarget.name || loadedTarget.model || model;
            logger.info('Reloading warmup target because loaded context differs from requested context', {
                host: hostUrl,
                model,
                loadedModel: loadedName,
                loadedNumCtx,
                requestedNumCtx
            });
            if (typeof onPhaseDetail === 'function') {
                try { await onPhaseDetail(`Reloading ${model} at ${requestedNumCtx} ctx…`); } catch (_e) {}
            }
            await unloadLoadedModel(hostUrl, loadedName, executor, signal);
            loadedModels = loadedModels.filter(name => !isSameOllamaModel(name, model));
            modelAlreadyLoaded = false;
            warmupData.already_loaded = false;
            warmupData.reloaded_for_num_ctx = { loaded_num_ctx: loadedNumCtx, requested_num_ctx: requestedNumCtx };
        }

        // Pre-unload: clear VRAM of everything that isn't the target, the
        // judge (if co-located), or an embedding. Invariant — a benchmark
        // run must own the host's VRAM so the test model fully loads and
        // isn't evicted mid-generation. Without this, Ollama may return
        // HTTP 200 with an empty response and tokens=0 when it can't fit
        // the model alongside whatever else is loaded.
        if (preUnloadOthers && !modelAlreadyLoaded && loadedModels.length > 0) {
            checkpoint();
            if (typeof onPhaseDetail === 'function') {
                try { await onPhaseDetail(`Unloading ${loadedModels.length} other model(s) from ${hostUrl}…`); } catch (_e) {}
            }
            warmupData.pre_unloaded = await unloadOthers(hostUrl, model, loadedModels, keepLoaded, executor, signal);
        } else {
            warmupData.pre_unloaded = [];
        }

        timeoutMs = timeoutOverride !== null ? timeoutOverride : (modelAlreadyLoaded ? (warmupTimeoutLoaded || 90000) : (warmupTimeoutCold || 180000));
        if (typeof onPhaseDetail === 'function') {
            try {
                const kind = modelAlreadyLoaded ? 'already loaded' : 'cold start';
                await onPhaseDetail(`Warming ${model} on ${hostUrl} (${kind}, ≤${Math.round(timeoutMs/1000)}s)`);
            } catch (_e) {}
        }
        logger.info('Warming up model', {
            host: hostUrl, model, alreadyLoaded: modelAlreadyLoaded, timeoutMs,
            timeoutSource: timeoutOverride !== null ? 'override' : 'auto'
        });

        const url = `${CORE_URL}/api/inference/generate`;
        const deadline = createLocalDeadline(
            timeoutMs,
            MODEL_WARMUP_OPERATION_SPECS[MODEL_WARMUP_OPERATIONS.GENERATE].policy.deadlineMs
        );

        let response;
        try {
            const warmupOptions = { num_predict: 1 };
            if (num_ctx) {
                warmupOptions.num_ctx = num_ctx;
            }

            const requestBody = {
                model,
                host: hostUrl,
                messages: [{ role: 'user', content: warmupPrompt }],
                stream: false,
                responseMode: 'normalized',
                think: false,
                callerDetail: 'benchmark-warmup',
                ...(claimIdentity || {}),
                options: warmupOptions
            };

            response = await modelWarmupRequest(
                MODEL_WARMUP_OPERATIONS.GENERATE,
                url,
                {
                    method: 'POST',
                    headers: withBenchmarkServiceAuth({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify(requestBody),
                    signal: combineAbortSignals(deadline.signal, signal)
                },
                executor
            );

            const durationMs = Date.now() - warmupStart;
            warmupData.latency_ms = durationMs;

            if (response.ok) {
                const data = await readBoundedJson(response);
                checkpoint();
                throwIfAborted(signal);
                warmupData.response = data.message?.content || '';
                warmupData.success = true;
                logger.info('Model ready', { host: hostUrl, model, durationMs, wasLoaded: modelAlreadyLoaded });
                if (timelinePrefix && recordTimelineEvent) {
                    await recordTimelineEvent(`${timelinePrefix}_complete`, {
                        model, duration_ms: durationMs, success: true
                    });
                }
            } else {
                const errorText = await readBoundedText(response).catch(() => '');
                warmupData.error = `Warmup failed: HTTP ${response.status} - ${errorText.substring(0, 100)}`;
                throw new Error(warmupData.error);
            }
        } finally {
            deadline.dispose();
        }
    } catch (err) {
        throwIfAborted(signal);
        const durationMs = Date.now() - warmupStart;
        warmupData.latency_ms = durationMs;
        warmupData.error = normalizeWarmupError(err, timeoutMs);
        logger.warn('Model warmup failed', { host: hostUrl, model, error: warmupData.error, durationMs });

        const terminalityUnknown = err?.name === 'AbortError'
            || err?.type === 'aborted'
            || err?.code === OUTBOUND_ERROR_CODES.CALLER_ABORTED
            || err?.code === OUTBOUND_ERROR_CODES.DEADLINE_EXCEEDED
            || /timeout|aborted|aborterror/i.test(String(err?.message || ''));
        if (terminalityUnknown) {
            err.retainAdmission = true;
            err.code = err.code || 'OLLAMA_WARMUP_TERMINALITY_UNKNOWN';
            throw err;
        }

        if (timelinePrefix && recordTimelineEvent) {
            await recordTimelineEvent(`${timelinePrefix}_complete`, {
                model, duration_ms: durationMs, success: false, error: warmupData.error
            });
        }
        // In strict mode, propagate the error (used for judge warmup)
        if (strict) {
            throw new Error(warmupData.error);
        }
        // Don't throw - let tests try anyway
    }

    return warmupData;
}

module.exports = {
    warmupModel,
    MODEL_WARMUP_OPERATIONS,
    _internal: {
        MODEL_WARMUP_OPERATION_SPECS,
        configuredCoreOrigin,
        createLocalDeadline,
        createModelWarmupExecutor,
        modelWarmupRequest,
        normalizeWarmupError,
        operationMatches
    }
};
