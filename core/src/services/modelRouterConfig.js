'use strict';
/**
 * Model Router — Static Configuration
 *
 * Centralises all host state, model→host mapping, task→model mapping,
 * and the classification prompt.
 *
 * Environment/code values are deployment defaults. Persisted RouterTaskConfig
 * rows are the operational app configuration: they load from MongoDB on
 * demand and merge into TASK_MODELS without a service restart. Resetting a
 * row deliberately deletes that app override and reveals its deployment default.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Classifier-vs-direct-invoke split
 * ─────────────────────────────────────────────────────────────────────────
 * Task types come in two flavours:
 *
 *   1. CLASSIFIABLE_TASKS — categories that the lightweight classifier is
 *      allowed to emit. These are advertised to the LLM in
 *      `CLASSIFICATION_PROMPT`. A user-facing chat request with autoRoute
 *      enabled can land on any of these.
 *
 *   2. DIRECT_INVOKE_TASKS — categories that are ONLY routed when a known
 *      caller passes an explicit `taskType` arg (RAG pipeline, buddy
 *      reactor, janitor, embedding workers). These are deliberately NOT
 *      advertised in the classifier prompt — the classifier has no business
 *      picking "embeddings" or "rag_reranking" from a freeform chat.
 *
 * `DEFAULT_TASK_MODELS` is the union of both and remains the canonical
 * surface for downstream code (`TASK_MODELS`, overrides, config UI).
 * Adding a new task type: decide which bucket it belongs in, add it there,
 * and — if classifiable — also add it to `CLASSIFICATION_PROMPT`.
 */

const logger = require('../../config/logger');
const { resolveAdvisoryHost } = require('../helpers/schedulerClient');
const {
    getModelReadiness,
    compareReadiness
} = require('./modelReadinessService');
const {
    TASK_TYPE_METADATA,
    ROUTING_EXPLAINER_STEPS,
    CLASSIFICATION_PROMPT
} = require('./modelRouterTaskMetadata');
const {
    HOSTS,
    refreshHosts,
    PRODUCT_DEFAULT_MODEL,
    PRODUCT_MASTER_BRAIN_MODEL,
    CLASSIFIABLE_TASKS,
    DIRECT_INVOKE_TASKS,
    DEFAULT_TASK_MODELS,
    CLASSIFICATION_MODEL,
    CLASSIFICATION_HOST,
    STRICT_CONFIGURED_HOST_TASKS
} = require('./modelRouterDefaults');

// ── Pin cache: model → hostUrl — loaded async from HostPreference ────────
// Prevents bare-model chat calls (no taskType, no host) from arbitrarily
// picking primary/secondary. If any host has this model in its pinnedModels
// array, we route there first — matches the per-host pin design rule and
// prevents cascade evictions. Post-0151 the cache reads pinnedModels only,
// with a service-layer fallback for legacy docs still in the DB.
let _pinCache = new Map();
let _pinCacheLoadedAt = 0;
let _pinCacheRefreshing = null;

async function refreshPinCache() {
    if (_pinCacheRefreshing) return _pinCacheRefreshing;
    _pinCacheRefreshing = (async () => {
        try {
            const hostPrefService = require('./hostPreferenceService');
            const nameMap = await hostPrefService.getPinnedModelsMap();
            const next = new Map();
            for (const [hostUrl, names] of nameMap) {
                for (const m of names) {
                    if (m && !next.has(m.toLowerCase())) {
                        next.set(m.toLowerCase(), hostUrl);
                    }
                }
            }
            _pinCache = next;
            _pinCacheLoadedAt = Date.now();
        } catch (_e) {
            // Silent — first call might fire before Mongo is connected.
            // Subsequent refresh ticks will succeed once DB is up.
        } finally {
            _pinCacheRefreshing = null;
        }
    })();
    return _pinCacheRefreshing;
}

function lookupPinnedHost(model) {
    if (!model) return null;
    return _pinCache.get(model.toLowerCase()) || null;
}

// Kick off an initial load + refresh every 60s. Guarded so a stale/missing
// Mongo connection doesn't crash the router.
//
// In NODE_ENV=test we skip the interval entirely. The live refresh only
// matters for long-running production processes; in tests it's a leaked
// timer that races Jest's per-file teardown — a tick firing mid-teardown
// hits an inner require('./hostPreferenceService') after Jest has emptied
// its module registry and throws "trying to import a file after the Jest
// environment has been torn down". afterAll-based clearInterval is racy
// because the tick can be queued before clearInterval runs (task 0192).
// Tests that need a populated cache call refreshPinCache() directly.
refreshPinCache();
let _pinCacheInterval = process.env.NODE_ENV === 'test'
    ? null
    : setInterval(refreshPinCache, 60_000);
if (_pinCacheInterval && typeof _pinCacheInterval.unref === 'function') _pinCacheInterval.unref();

// Stop hook for any caller that wants to settle pending work (used in tests
// to await the initial refresh kicked off above).
async function stopPinCacheRefresh() {
    if (_pinCacheInterval) {
        clearInterval(_pinCacheInterval);
        _pinCacheInterval = null;
    }
    if (_pinCacheRefreshing) {
        try { await _pinCacheRefreshing; } catch { /* ignore */ }
    }
}

function isClassifiableTask(taskType) {
    return Object.prototype.hasOwnProperty.call(CLASSIFIABLE_TASKS, taskType);
}

function isDirectInvokeTask(taskType) {
    return Object.prototype.hasOwnProperty.call(DIRECT_INVOKE_TASKS, taskType);
}

const TASK_MODELS = cloneTaskModels(DEFAULT_TASK_MODELS);
let taskModelOverrides = {};
let taskOverridesLoaded = false;
let taskOverridesLoadPromise = null;

function classifierRespectsHostPin() {
    return String(process.env.AGENTX_CLASSIFIER_RESPECT_PRIMARY_PIN || 'true').toLowerCase() !== 'false';
}

async function resolveClassificationConfig() {
    refreshHosts();
    const hostUrl = HOSTS[CLASSIFICATION_HOST] || null;
    const config = {
        model: CLASSIFICATION_MODEL,
        host: CLASSIFICATION_HOST,
        hostUrl,
        source: 'configured',
        prompt: CLASSIFICATION_PROMPT
    };

    if (!hostUrl || !classifierRespectsHostPin()) return config;

    try {
        const hostPrefService = require('./hostPreferenceService');
        const pref = await hostPrefService.getByHost(hostUrl);
        const primaryPin = hostPrefService.getPinnedEntries(pref)?.[0]?.model || null;
        if (primaryPin) {
            return {
                ...config,
                model: primaryPin,
                source: 'host_preference_pin',
                configuredModel: CLASSIFICATION_MODEL
            };
        }
    } catch (err) {
        logger.debug('[ModelRouterConfig] classifier pin lookup skipped', {
            host: hostUrl,
            error: err.message
        });
    }

    return config;
}

function cloneTaskModels(taskModels) {
    return Object.fromEntries(
        Object.entries(taskModels || {}).map(([taskType, entry]) => [taskType, {
            model: entry.model,
            host: entry.host
        }])
    );
}

function getDefaultTaskModels() {
    return cloneTaskModels(DEFAULT_TASK_MODELS);
}

function getTaskModelOverrides() {
    return cloneTaskModels(taskModelOverrides);
}

function getEffectiveTaskModels() {
    return cloneTaskModels(TASK_MODELS);
}

function isKnownTaskType(taskType) {
    return Object.prototype.hasOwnProperty.call(DEFAULT_TASK_MODELS, taskType);
}

function isKnownHost(host) {
    return Object.prototype.hasOwnProperty.call(HOSTS, host);
}

function rebuildTaskModels() {
    const merged = cloneTaskModels(DEFAULT_TASK_MODELS);

    Object.entries(taskModelOverrides).forEach(([taskType, entry]) => {
        if (isKnownTaskType(taskType)) {
            merged[taskType] = { model: entry.model, host: entry.host };
        }
    });

    Object.keys(TASK_MODELS).forEach((taskType) => delete TASK_MODELS[taskType]);
    Object.assign(TASK_MODELS, merged);
}

function normalizeTaskOverride(taskType, entry) {
    if (!isKnownTaskType(taskType)) {
        const error = new Error(`Unknown task type: ${taskType}`);
        error.statusCode = 404;
        throw error;
    }

    const model = typeof entry?.model === 'string' ? entry.model.trim() : '';
    const host = typeof entry?.host === 'string' ? entry.host.trim() : '';

    if (!model || !host) {
        const error = new Error('model and host are required');
        error.statusCode = 400;
        throw error;
    }

    if (!isKnownHost(host)) {
        const error = new Error(`Unknown host: ${host}`);
        error.statusCode = 400;
        throw error;
    }

    return { model, host };
}

function isDefaultMapping(taskType, entry) {
    const defaults = DEFAULT_TASK_MODELS[taskType];
    return defaults.model === entry.model && defaults.host === entry.host;
}

function getTaskModelConfigState() {
    return Object.fromEntries(Object.keys(DEFAULT_TASK_MODELS).map((taskType) => {
        const defaults = DEFAULT_TASK_MODELS[taskType];
        const override = taskModelOverrides[taskType] || null;
        const effective = TASK_MODELS[taskType];

        return [taskType, {
            default: { model: defaults.model, host: defaults.host },
            override: override ? { model: override.model, host: override.host } : null,
            effective: { model: effective.model, host: effective.host },
            isOverride: !!override
        }];
    }));
}

async function loadTaskModelOverridesFromDb() {
    const RouterTaskConfig = require('../../models/RouterTaskConfig');
    const docs = await RouterTaskConfig.find({}).lean();
    const nextOverrides = {};

    docs.forEach((doc) => {
        if (!isKnownTaskType(doc.taskType)) {
            logger.warn('[ModelRouterConfig] ignoring unknown task override', { taskType: doc.taskType });
            return;
        }

        try {
            nextOverrides[doc.taskType] = normalizeTaskOverride(doc.taskType, doc);
        } catch (err) {
            logger.warn('[ModelRouterConfig] ignoring invalid task override', {
                taskType: doc.taskType,
                error: err.message
            });
        }
    });

    taskModelOverrides = nextOverrides;
    taskOverridesLoaded = true;
    rebuildTaskModels();
    return getTaskModelOverrides();
}

async function ensureTaskModelOverridesLoaded(options = {}) {
    if (taskOverridesLoaded && options.force !== true) {
        return getTaskModelOverrides();
    }

    if (taskOverridesLoadPromise) {
        return taskOverridesLoadPromise;
    }

    taskOverridesLoadPromise = loadTaskModelOverridesFromDb()
        .catch((err) => {
            logger.warn('[ModelRouterConfig] failed to load task overrides, using defaults', {
                error: err.message
            });
            taskModelOverrides = {};
            taskOverridesLoaded = true;
            rebuildTaskModels();
            return getTaskModelOverrides();
        })
        .finally(() => {
            taskOverridesLoadPromise = null;
        });

    return taskOverridesLoadPromise;
}

async function saveTaskModelOverride(taskType, entry) {
    const RouterTaskConfig = require('../../models/RouterTaskConfig');
    const normalized = normalizeTaskOverride(taskType, entry);

    if (isDefaultMapping(taskType, normalized)) {
        await RouterTaskConfig.deleteOne({ taskType });
        delete taskModelOverrides[taskType];
    } else {
        await RouterTaskConfig.findOneAndUpdate(
            { taskType },
            { taskType, model: normalized.model, host: normalized.host },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        taskModelOverrides[taskType] = normalized;
    }

    taskOverridesLoaded = true;
    rebuildTaskModels();
    return getTaskModelConfigState()[taskType];
}

async function resetTaskModelOverride(taskType) {
    if (!isKnownTaskType(taskType)) {
        const error = new Error(`Unknown task type: ${taskType}`);
        error.statusCode = 404;
        throw error;
    }

    const RouterTaskConfig = require('../../models/RouterTaskConfig');
    await RouterTaskConfig.deleteOne({ taskType });
    delete taskModelOverrides[taskType];
    taskOverridesLoaded = true;
    rebuildTaskModels();
    return getTaskModelConfigState()[taskType];
}

async function resetAllTaskModelOverrides() {
    const RouterTaskConfig = require('../../models/RouterTaskConfig');
    await RouterTaskConfig.deleteMany({});
    taskModelOverrides = {};
    taskOverridesLoaded = true;
    rebuildTaskModels();
    return getTaskModelConfigState();
}

async function getAvailableRoutingModels() {
    const known = new Set();
    Object.values(TASK_MODELS).forEach((entry) => {
        if (entry?.model) known.add(entry.model);
    });

    try {
        const ModelRegistry = require('../../models/ModelRegistry');
        const docs = await ModelRegistry.find({
            isActive: true,
            status: { $ne: 'retired' }
        })
            .sort({ modelName: 1 })
            .select({ modelName: 1, _id: 0 })
            .lean();

        docs.forEach((doc) => {
            if (doc?.modelName) {
                known.add(doc.modelName);
            }
        });
    } catch (err) {
        logger.warn('[ModelRouterConfig] failed to load model registry entries for routing UI', {
            error: err.message
        });
    }

    return [...known].sort((left, right) => left.localeCompare(right));
}

async function buildRouterConfigPayload(options = {}) {
    await ensureTaskModelOverridesLoaded(options);
    refreshHosts();

    const classification = await resolveClassificationConfig();

    return {
        authority: {
            operational: 'routertaskconfigs',
            deploymentDefaults: 'environment_and_code',
            resetBehavior: 'delete_app_override'
        },
        taskModels: getEffectiveTaskModels(),
        hosts: { ...HOSTS },
        taskMetadata: TASK_TYPE_METADATA,
        explainerSteps: ROUTING_EXPLAINER_STEPS,
        classification,
        defaults: {
            taskModels: getDefaultTaskModels()
        },
        overrides: {
            taskModels: getTaskModelOverrides()
        },
        taskConfigState: getTaskModelConfigState(),
        availableModels: await getAvailableRoutingModels()
    };
}

function getTargetForModel(model) {
    refreshHosts();
    if (!model) return HOSTS.primary || HOSTS.secondary || HOSTS.tertiary;

    const normalizedModel = model.toLowerCase().trim();

    // Pin-aware lookup: if a host has this model pinned or listed as a
    // default, route there first. Prevents bare-model chat calls from
    // arbitrarily picking secondary and evicting a pinned model elsewhere.
    const pinnedHost = lookupPinnedHost(normalizedModel);
    if (pinnedHost) {
        return pinnedHost;
    }

    if (normalizedModel.includes('embed') || normalizedModel.includes('embedding') || normalizedModel.includes('nomic')) {
        const embeddingHost = DEFAULT_TASK_MODELS.embeddings.host;
        return HOSTS[embeddingHost] || HOSTS.secondary || HOSTS.tertiary || HOSTS.primary;
    }

    return HOSTS.secondary || HOSTS.tertiary || HOSTS.primary;
}

async function getAdvisoryTargetForModel(model, options = {}) {
    const fallbackUrl = getTargetForModel(model);
    const advisory = await resolveAdvisoryHost({
        model,
        caller: options.caller || 'model-router',
        durationMs: options.durationMs || 30000,
        priority: options.priority || 'normal',
        createSoftClaim: options.createSoftClaim === true,
        claimTtlMs: options.claimTtlMs || 30000,
        fallbackHostUrl: fallbackUrl,
        fallbackReason: 'Static model routing fallback'
    });
    const schedulerBlocked = advisory.source === 'scheduler-blocked'
        || advisory.recommendation?.blockedByBenchmarkClaim === true;

    return {
        model,
        host: schedulerBlocked ? null : advisory.hostId,
        url: schedulerBlocked ? null : (advisory.hostUrl || fallbackUrl),
        source: advisory.source,
        reason: advisory.reason,
        claimId: advisory.claimId,
        claimExpiresAt: advisory.claimExpiresAt,
        recommendation: advisory.recommendation
    };
}

function getModelForTask(taskType) {
    refreshHosts();
    const task = TASK_MODELS[taskType] || TASK_MODELS.general_chat;
    return {
        model: task.model,
        host: task.host,
        url: HOSTS[task.host]
    };
}

async function resolvePreferredTaskEntry(taskType, options = {}) {
    refreshHosts();
    const configured = TASK_MODELS[taskType] || TASK_MODELS.general_chat;

    if (STRICT_CONFIGURED_HOST_TASKS.has(taskType)) {
        return {
            model: configured.model,
            host: configured.host,
            url: HOSTS[configured.host],
            readiness: null,
            fallbackApplied: false
        };
    }

    const candidates = [];
    const seen = new Set();

    function pushCandidate(model, hostKey, reason) {
        if (!model || !hostKey || !HOSTS[hostKey]) return;
        const key = `${String(model).toLowerCase()}::${hostKey}`;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ model, host: hostKey, reason });
    }

    pushCandidate(configured.model, configured.host, 'configured');
    Object.keys(HOSTS).forEach((hostKey) => {
        pushCandidate(configured.model, hostKey, hostKey === configured.host ? 'configured' : 'same_model_other_host');
    });

    const evaluated = await Promise.all(candidates.map(async (candidate) => {
        const readinessState = await getModelReadiness(candidate.model, HOSTS[candidate.host]);
        return {
            ...candidate,
            readiness: readinessState.readiness
        };
    }));

    const readyCandidates = evaluated
        .filter((candidate) => candidate.readiness?.isReady === true)
        .sort((left, right) => {
            const readinessOrder = compareReadiness(left.readiness, right.readiness);
            if (readinessOrder !== 0) return readinessOrder;
            if (left.reason !== right.reason) {
                return left.reason === 'configured' ? -1 : 1;
            }
            return 0;
        });

    if (readyCandidates.length === 0) {
        return {
            model: configured.model,
            host: configured.host,
            url: HOSTS[configured.host],
            readiness: null,
            fallbackApplied: false
        };
    }

    let selected = readyCandidates[0];

    const fallbackApplied = selected.host !== configured.host;

    if (fallbackApplied) {
        logger.info('[ModelRouterConfig] preferring profiled host for task model', {
            taskType,
            model: configured.model,
            fromHost: configured.host,
            toHost: selected.host,
            stage: selected.readiness?.stage || 'available'
        });
    }

    return {
        model: selected.model,
        host: selected.host,
        url: HOSTS[selected.host],
        readiness: selected.readiness,
        fallbackApplied
    };
}

async function getAdvisoryModelForTask(taskType, options = {}) {
    refreshHosts();
    const task = await resolvePreferredTaskEntry(taskType);

    if (STRICT_CONFIGURED_HOST_TASKS.has(taskType)) {
        return {
            model: task.model,
            host: task.host,
            url: HOSTS[task.host],
            source: 'configured_host',
            reason: 'Task is pinned to its configured lightweight host to avoid model swaps.',
            claimId: null,
            claimExpiresAt: null,
            recommendation: null,
            readiness: task.readiness || null
        };
    }

    const advisory = await resolveAdvisoryHost({
        model: task.model,
        caller: options.caller || 'model-router',
        durationMs: options.durationMs || 30000,
        priority: options.priority || 'normal',
        createSoftClaim: options.createSoftClaim === true,
        claimTtlMs: options.claimTtlMs || 30000,
        fallbackHostId: task.host,
        fallbackHostUrl: HOSTS[task.host],
        fallbackReason: 'Static task routing fallback'
    });
    const schedulerBlocked = advisory.source === 'scheduler-blocked'
        || advisory.recommendation?.blockedByBenchmarkClaim === true;

    return {
        model: task.model,
        host: schedulerBlocked ? null : (advisory.hostId || task.host),
        url: schedulerBlocked ? null : (advisory.hostUrl || HOSTS[task.host]),
        source: advisory.source,
        reason: advisory.reason,
        claimId: advisory.claimId,
        claimExpiresAt: advisory.claimExpiresAt,
        recommendation: advisory.recommendation,
        readiness: task.readiness || null
    };
}

module.exports = {
    HOSTS,
    PRODUCT_DEFAULT_MODEL,
    PRODUCT_MASTER_BRAIN_MODEL,
    refreshHosts,
    DEFAULT_TASK_MODELS,
    CLASSIFIABLE_TASKS,
    DIRECT_INVOKE_TASKS,
    isClassifiableTask,
    isDirectInvokeTask,
    TASK_MODELS,
    TASK_TYPE_METADATA,
    ROUTING_EXPLAINER_STEPS,
    CLASSIFICATION_MODEL,
    CLASSIFICATION_HOST,
    CLASSIFICATION_PROMPT,
    resolveClassificationConfig,
    getDefaultTaskModels,
    getTaskModelOverrides,
    getEffectiveTaskModels,
    getTaskModelConfigState,
    ensureTaskModelOverridesLoaded,
    saveTaskModelOverride,
    resetTaskModelOverride,
    resetAllTaskModelOverrides,
    buildRouterConfigPayload,
    getTargetForModel,
    getAdvisoryTargetForModel,
    getModelForTask,
    getAdvisoryModelForTask,
    resolvePreferredTaskEntry,
    // pin-cache surface for tests and diagnostics
    refreshPinCache,
    stopPinCacheRefresh,
    lookupPinnedHost,
    _setPinCacheForTests: (entries) => {
        _pinCache = new Map(Object.entries(entries || {}).map(([k, v]) => [k.toLowerCase(), v]));
    }
};
