/**
 * Model Router Service
 * Routes chat requests to appropriate Ollama host based on model/task complexity.
 * Static config (TASK_MODELS, host state) lives in modelRouterConfig.js.
 * This file handles health checks, failover state, classification, and inference telemetry.
 */

const logger = require('../../config/logger');
const fetch = require('node-fetch');
const { getAlertService } = require('./alertService');
const { getFetchOptions } = require('../helpers/httpAgent');
const { assertHostAvailableForConsumer } = require('./benchmarkClaimGuard');
const { characterizeRouteRequest } = require('./routing/routeDecision');
// Telemetry lives in routing/inferenceTelemetry.js (task 0519); re-exported below
// for symbol stability, matching the benchmarkClaimService precedent.
const { recordInference } = require('./routing/inferenceTelemetry');
const {
    HOSTS,
    refreshHosts,
    TASK_MODELS,
    CLASSIFICATION_MODEL,
    CLASSIFICATION_HOST,
    CLASSIFICATION_PROMPT,
    isClassifiableTask,
    ensureTaskModelOverridesLoaded,
    getTargetForModel,
    getAdvisoryTargetForModel,
    getModelForTask,
    getAdvisoryModelForTask
} = require('./modelRouterConfig');

async function getHostPinStatus(hostUrl) {
    try {
        const hostPrefService = require('./hostPreferenceService');
        const status = await hostPrefService.getPinStatus(hostUrl);
        return status;
    } catch {
        return { status: 'idle', pinnedModels: [], loadedModel: null };
    }
}

async function resolveClassificationRuntime(classificationHost, classificationModel) {
    if ((process.env.AGENTX_CLASSIFIER_RESPECT_PRIMARY_PIN || 'true').toLowerCase() === 'false') {
        return { model: classificationModel, source: 'configured' };
    }

    try {
        const hostPrefService = require('./hostPreferenceService');
        const pref = await hostPrefService.getByHost(classificationHost);
        const primaryPin = hostPrefService.getPinnedEntries(pref)?.[0]?.model || null;
        if (primaryPin) {
            return { model: primaryPin, source: 'host_preference_pin' };
        }
    } catch (err) {
        logger.debug('Classifier pin lookup skipped', {
            host: classificationHost,
            error: err.message
        });
    }

    return { model: classificationModel, source: 'configured' };
}

// ---------------------------------------------------------------------------
// Back-compat helpers (used by unit tests and older call-sites)
// ---------------------------------------------------------------------------

const HEALTH_CACHE_TTL_MS = parseInt(process.env.MODEL_HEALTH_CACHE_TTL_MS || '1000', 10);
const HEALTH_SLOW_THRESHOLD_MS = parseInt(process.env.MODEL_HEALTH_SLOW_THRESHOLD_MS || '6000', 10);
const _healthCache = new Map();

async function getModelHealth(hostUrl, _model = null) {
    refreshHosts();
    if (!hostUrl) {
        return { healthy: false, latency: -1, checkedAt: Date.now() };
    }

    const cacheKey = `${hostUrl}|${_model || ''}`;
    const now = Date.now();
    const cached = _healthCache.get(cacheKey);
    // Guard against undefined/null checkedAt which would result in NaN
    if (cached && typeof cached.checkedAt === 'number') {
        const cacheAgeMs = now - cached.checkedAt;
        if (cacheAgeMs >= 0 && cacheAgeMs < HEALTH_CACHE_TTL_MS) {
            return cached;
        }
    }

    // Delegate to canonical checkHostHealth and map to legacy shape
    const health = await checkHostHealth(hostUrl);
    const result = {
        healthy: health.status === 'online',
        latency: health.latency,
        checkedAt: Date.now(),
        ...(health.error ? { error: health.error } : {})
    };
    _healthCache.set(cacheKey, result);
    return result;
}

async function classifyAndRoute(message, options = {}) {
    refreshHosts();
    const { taskType = null } = options;

    // Minimal deterministic behavior for tests: if taskType is given, route to primary
    // unless health is slow/unhealthy.
    const primaryHost = HOSTS.primary;
    const secondaryHost = HOSTS.secondary;

    if (!primaryHost) {
        logger.error('No primary Ollama host configured');
        throw new Error('No primary Ollama host configured');
    }

    const primaryHealth = await getModelHealth(primaryHost, null);
    const shouldFailover = !primaryHealth.healthy || primaryHealth.latency > HEALTH_SLOW_THRESHOLD_MS;

    if (!shouldFailover) {
        return {
            host: primaryHost,
            failedOver: false,
            taskType: taskType || 'default',
            message
        };
    }

    // Alert on failover (best-effort)
    try {
        const svc = typeof getAlertService === 'function' ? getAlertService() : null;
        if (svc?.triggerAlert) {
            await svc.triggerAlert('model_failover', 'warning', {
                primary: primaryHost,
                backup: secondaryHost,
                latency: primaryHealth.latency
            });
        }
    } catch (_e) {
        // best-effort
    }

    // Verify backup quickly (best-effort)
    await getModelHealth(secondaryHost, null);

    return {
        host: secondaryHost,
        failedOver: true,
        taskType: taskType || 'default',
        message
    };
}

// Persistent failover state (in-memory)
let ACTIVE_HOST_STATE = {
    current: null, // Will be initialized to primary on first access
    failedOver: false,
    failoverTimestamp: null,
    reason: null,
    failoverCount: 0
};

// Initialize active host on module load
ACTIVE_HOST_STATE.current = HOSTS.primary;

/**
 * Classify a query using the front-door model (Qwen)
 * @param {string} message - User message to classify
 * @param {number} timeout - Request timeout in ms (default 10s)
 * @returns {Promise<string>} Task classification
 */
async function classifyQuery(message, timeout = 10000) {
    refreshHosts();
    const classificationHost = HOSTS[CLASSIFICATION_HOST] || HOSTS.secondary || HOSTS.primary;
    const { model: classificationModel, source: classificationModelSource } =
        await resolveClassificationRuntime(classificationHost, CLASSIFICATION_MODEL);

    const controller = new AbortController();
    // NOTE: must always clearTimeout (success or failure) so the timer does
    // not leak as an open handle (e.g., during tests where fetch is mocked
    // to reject immediately). Cleared in the finally block below.
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        await assertHostAvailableForConsumer(classificationHost, {
            callerDetail: 'classification',
            model: classificationModel,
            path: '/api/generate'
        });

        const url = `${classificationHost}/api/generate`;
        const fetchOptions = getFetchOptions(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: classificationModel,
                prompt: CLASSIFICATION_PROMPT + message,
                stream: false,
                options: {
                    temperature: 0.1,  // Low temp for consistent classification
                    num_predict: 20    // Short response expected
                    // num_ctx intentionally omitted — Modelfile governs (see docs/LLM_USAGE.md).
                    // Prior hardcode of 4096 evicted the KV cache on every routing decision.
                }
            }),
            signal: controller.signal
        });
        const response = await fetch(url, fetchOptions);

        if (!response.ok) {
            throw new Error(`Classification failed: ${response.statusText}`);
        }

        const data = await response.json();
        const classification = data.response?.trim().toLowerCase().replace(/[^a-z_]/g, '') || 'general_chat';

        // Validate classification — must be in the CLASSIFIABLE subset.
        // Direct-invoke categories (rag_*, buddy_reaction, janitor_ai,
        // embeddings) are deliberately not advertised in the prompt; if one
        // leaks through (hallucination, prompt drift) fall back to
        // general_chat rather than routing freeform chat to an RAG/embed
        // model.
        if (isClassifiableTask(classification)) {
            logger.debug('Query classified', {
                classification,
                message: message.substring(0, 50),
                model: classificationModel,
                modelSource: classificationModelSource
            });
            return classification;
        }

        if (TASK_MODELS[classification]) {
            logger.warn('Classifier emitted non-classifiable category, defaulting to general_chat', { classification });
        } else {
            logger.warn('Unknown classification, defaulting to general_chat', { classification });
        }
        return 'general_chat';

    } catch (err) {
        if (err.name === 'AbortError') {
            logger.warn('Classification timed out, using default');
        } else {
            logger.error('Classification error', { error: err.message });
        }
        return 'general_chat';
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Smart routing: classify query and determine best model/host
 * @param {string} message - User message
 * @param {Object} options - Routing options
 * @param {boolean} options.autoRoute - Enable auto-classification (default: false)
 * @param {string} options.taskType - Override task type (skip classification)
 * @param {string} options.preferredModel - Use specific model if available
 * @returns {Promise<{ model: string, target: string, taskType: string, routed: boolean }>}
 */
async function resolveRouteTarget(message, options = {}) {
    await ensureTaskModelOverridesLoaded();
    refreshHosts();
    const { autoRoute = false, taskType, preferredModel, caller = 'model-router', durationMs = 30000 } = options;

    // If preferred model specified, just return its target
    if (preferredModel) {
        const advisory = await getAdvisoryTargetForModel(preferredModel, {
            caller,
            durationMs,
            createSoftClaim: true
        });
        // Check if host is mid-swap
        const pinStatus = await getHostPinStatus(advisory.url);
        if (pinStatus.status === 'swapping' || pinStatus.status === 'restoring') {
          return {
            model: preferredModel,
            target: advisory.url,
            taskType: 'user_specified',
            routed: false,
            autoRouted: false,
            classificationMs: 0,
            host: advisory.host,
            source: advisory.source,
            claimId: advisory.claimId,
            hostBusy: true,
            hostStatus: pinStatus.status
          };
        }
        return {
            model: preferredModel,
            target: advisory.url,
            taskType: 'user_specified',
            routed: false,
            autoRouted: false,
            classificationMs: 0,
            host: advisory.host,
            source: advisory.source,
            claimId: advisory.claimId
        };
    }

    // If explicit task type provided
    if (taskType && TASK_MODELS[taskType]) {
        const recommendation = await getAdvisoryModelForTask(taskType, {
            caller,
            durationMs,
            createSoftClaim: true
        });
        return {
            model: recommendation.model,
            target: recommendation.url,
            taskType,
            routed: true,
            autoRouted: false,
            classificationMs: 0,
            host: recommendation.host,
            source: recommendation.source,
            claimId: recommendation.claimId
        };
    }

    // If auto-routing enabled, classify the query
    if (autoRoute && message) {
        const classificationStartedAt = Date.now();
        const classification = await classifyQuery(message);
        const classificationMs = Date.now() - classificationStartedAt;
        const recommendation = await getAdvisoryModelForTask(classification, {
            caller,
            durationMs,
            createSoftClaim: true
        });
        return {
            model: recommendation.model,
            target: recommendation.url,
            taskType: classification,
            routed: true,
            autoRouted: true,
            classificationMs,
            host: recommendation.host,
            source: recommendation.source,
            claimId: recommendation.claimId
        };
    }

    // Default: use front-door
    const defaultTask = getModelForTask('general_chat');
    return {
        model: process.env.AGENTX_ROUTER_FALLBACK_MODEL || defaultTask.model || 'qwen3:8b',
        target: HOSTS[defaultTask.host] || HOSTS.secondary || HOSTS.primary,
        taskType: 'default',
        routed: false,
        autoRouted: false,
        classificationMs: 0,
        host: defaultTask.host || resolveHostKey(HOSTS.secondary || HOSTS.primary)
    };
}

/**
 * Public routing entry point.
 *
 * Attaches exactly one RouteDecision v1 per call (task 0519). Selection happens
 * entirely inside `resolveRouteTarget`; this wrapper only describes what that
 * decided, which is why adopting the contract cannot move traffic. Doing it here
 * rather than at the four internal return sites is what makes "exactly one
 * decision per request" structural instead of a convention every future branch
 * has to remember.
 *
 * Telemetry never breaks routing: a malformed decision is logged and dropped,
 * and the caller still gets its target.
 */
async function routeRequest(message, options = {}) {
    const startedAt = Date.now();
    const result = await resolveRouteTarget(message, options);
    try {
        result.decision = characterizeRouteRequest(result, {
            caller: options.caller,
            callerDetail: options.callerDetail,
            consumerContract: options.consumerContract,
            correlationId: options.correlationId,
            workItemId: options.workItemId,
            runtime: options.runtime,
            attempt: options.attempt,
            requestedModel: options.preferredModel || null,
            runtimeOptions: options.runtimeOptions,
            decisionMs: Date.now() - startedAt,
        });
    } catch (err) {
        logger.warn('RouteDecision build failed (non-fatal)', { error: err.message, code: err.code });
    }
    return result;
}

/**
 * Check health of a specific host
 * @param {string} hostKey - 'primary' or 'secondary'
 * @returns {Promise<{ status: string, models: string[], latency: number }>}
 */
async function checkHostHealth(hostKey) {
    refreshHosts();
    // Accept several identifiers:
    // - 'primary' | 'secondary'
    // - legacy aliases 'ollama-main' | 'ollama-secondary'
    // - a full host URL
    // - a URL equal to HOSTS.primary / HOSTS.secondary
    let host = null;
    if (hostKey === 'primary' || hostKey === 'ollama-main') host = HOSTS.primary;
    else if (hostKey === 'secondary' || hostKey === 'ollama-secondary') host = HOSTS.secondary;
    else if (hostKey === 'tertiary' || hostKey === 'ollama-tertiary') host = HOSTS.tertiary;
    else if (typeof hostKey === 'string' && hostKey.startsWith('http')) host = hostKey;
    else if (hostKey === HOSTS.primary) host = HOSTS.primary;
    else if (hostKey === HOSTS.secondary) host = HOSTS.secondary;
    else if (hostKey === HOSTS.tertiary) host = HOSTS.tertiary;
    else if (typeof hostKey === 'string') host = HOSTS[hostKey];

    if (!host) {
        return { status: 'unknown', models: [], latency: -1 };
    }

    const start = Date.now();

    try {
        const url = `${host}/api/tags`;
        const fetchOptions = getFetchOptions(url, { method: 'GET' });
        const response = await fetch(url, fetchOptions);

        const latency = Date.now() - start;

        if (!response.ok) {
            return { status: 'error', models: [], latency };
        }

        let models = [];
        try {
            const data = await response.json();
            models = (data.models || []).map(m => m.name);
        } catch (_) {
            // Host is reachable but response body is not parseable
        }

        return {
            status: 'online',
            models,
            latency
        };

    } catch (err) {
        return {
            status: 'offline',
            models: [],
            latency: Date.now() - start,
            error: err.message
        };
    }
}

/**
 * Get all routing info for debugging/dashboard
 * @returns {Promise<Object>}
 */
async function getRoutingStatus() {
    await ensureTaskModelOverridesLoaded();
    refreshHosts();
    const healthChecks = [
        checkHostHealth('primary'),
        checkHostHealth('secondary')
    ];
    if (HOSTS.tertiary) healthChecks.push(checkHostHealth('tertiary'));

    const [primaryHealth, secondaryHealth, tertiaryHealth] = await Promise.all(healthChecks);

    const hosts = {
        primary: { url: HOSTS.primary, ...primaryHealth },
        secondary: { url: HOSTS.secondary, ...secondaryHealth }
    };
    if (HOSTS.tertiary) {
        hosts.tertiary = { url: HOSTS.tertiary, ...tertiaryHealth };
    }

    return {
        hosts,
        taskModels: TASK_MODELS
    };
}

/**
 * Get currently active host (for failover detection)
 * @returns {string} Active host URL
 */
function getActiveHost() {
    refreshHosts();
    return ACTIVE_HOST_STATE.current || HOSTS.primary;
}

/**
 * Get backup host URL
 * @returns {string} Backup host URL
 */
function getBackupHost() {
    refreshHosts();
    const current = getActiveHost();
    if (current === HOSTS.primary) {
        return HOSTS.secondary || HOSTS.tertiary || HOSTS.primary;
    }
    if (current === HOSTS.secondary) {
        return HOSTS.primary || HOSTS.tertiary || HOSTS.secondary;
    }
    if (current === HOSTS.tertiary) {
        return HOSTS.secondary || HOSTS.primary || HOSTS.tertiary;
    }
    return HOSTS.primary || HOSTS.secondary || HOSTS.tertiary;
}

/**
 * Get health and model inventory across all configured hosts.
 * @returns {Promise<Array<{hostKey: string, hostUrl: string, status: string, latency: number, models: string[], error?: string, checkedAt: string}>>}
 */
async function getAllModelsHealth() {
    refreshHosts();

    const hostEntries = [
        { hostKey: 'primary', hostUrl: HOSTS.primary },
        { hostKey: 'secondary', hostUrl: HOSTS.secondary },
        { hostKey: 'tertiary', hostUrl: HOSTS.tertiary }
    ].filter((entry) => !!entry.hostUrl);

    const checks = await Promise.all(hostEntries.map(async (entry) => {
        const health = await checkHostHealth(entry.hostKey);
        return {
            hostKey: entry.hostKey,
            hostUrl: entry.hostUrl,
            status: health.status,
            latency: health.latency,
            models: health.models || [],
            ...(health.error ? { error: health.error } : {}),
            checkedAt: new Date().toISOString()
        };
    }));

    return checks;
}

/**
 * Switch active host (for failover scenarios)
 * @param {string} hostUrl - Target host URL to switch to
 * @param {string} reason - Reason for the switch (optional)
 */
function switchHost(hostUrl, reason = 'manual') {
    refreshHosts();
    const previousHost = ACTIVE_HOST_STATE.current;

    // Update state
    ACTIVE_HOST_STATE.current = hostUrl;
    ACTIVE_HOST_STATE.failedOver = (hostUrl !== HOSTS.primary);
    ACTIVE_HOST_STATE.failoverTimestamp = new Date().toISOString();
    ACTIVE_HOST_STATE.reason = reason;
    ACTIVE_HOST_STATE.failoverCount += 1;

    logger.warn('Host switch executed', {
        from: previousHost,
        to: hostUrl,
        reason,
        timestamp: ACTIVE_HOST_STATE.failoverTimestamp,
        failoverCount: ACTIVE_HOST_STATE.failoverCount,
        isFailedOver: ACTIVE_HOST_STATE.failedOver
    });
}

/**
 * Get current failover status
 * @returns {Object} Current failover state
 */
function getFailoverStatus() {
    refreshHosts();
    return {
        currentHost: ACTIVE_HOST_STATE.current,
        isFailedOver: ACTIVE_HOST_STATE.failedOver,
        failoverTimestamp: ACTIVE_HOST_STATE.failoverTimestamp,
        reason: ACTIVE_HOST_STATE.reason,
        failoverCount: ACTIVE_HOST_STATE.failoverCount,
        primaryHost: HOSTS.primary,
        secondaryHost: HOSTS.secondary,
        tertiaryHost: HOSTS.tertiary
    };
}

/**
 * Reset to primary host
 * @param {string} reason - Reason for reset (optional)
 */
function resetToPrimary(reason = 'manual_reset') {
    refreshHosts();
    const previousState = { ...ACTIVE_HOST_STATE };

    ACTIVE_HOST_STATE.current = HOSTS.primary;
    ACTIVE_HOST_STATE.failedOver = false;
    ACTIVE_HOST_STATE.failoverTimestamp = null;
    ACTIVE_HOST_STATE.reason = null;
    // Keep failoverCount for historical tracking

    logger.info('Failover state reset to primary', {
        reason,
        previousHost: previousState.current,
        previousReason: previousState.reason,
        totalFailovers: ACTIVE_HOST_STATE.failoverCount
    });
}

// ---------------------------------------------------------------------------
// Inference Telemetry
// ---------------------------------------------------------------------------

/**
 * Resolve the host key ('primary' | 'secondary' | 'tertiary') from a host URL.
 * @param {string} hostUrl
 * @returns {string|null}
 */
function resolveHostKey(hostUrl) {
    if (!hostUrl) return null;
    if (hostUrl === HOSTS.primary) return 'primary';
    if (hostUrl === HOSTS.secondary) return 'secondary';
    if (hostUrl === HOSTS.tertiary) return 'tertiary';
    return null;
}

module.exports = {
    getTargetForModel,
    getModelForTask,
    classifyQuery,
    routeRequest,
    classifyAndRoute,
    checkHostHealth,
    getModelHealth,
    getRoutingStatus,
    getAllModelsHealth,
    getActiveHost,
    getBackupHost,
    switchHost,
    getFailoverStatus,
    resetToPrimary,
    recordInference,
    resolveHostKey,
    HOSTS,
    TASK_MODELS
};
