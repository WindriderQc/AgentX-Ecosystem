/**
 * Benchmark Routes - Core
 * Config, prompts, single test, start batch, stop batch
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const mongoose = require('mongoose');
const benchmarkService = require('../../src/services/benchmark');
const { JUDGE_CONFIG, ENHANCED_SCORING_CONFIGS } = require('../../src/services/qualityScorer');
const { stopJudging } = require('../../src/services/benchmark/judging');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkResult = require('../../models/BenchmarkResult');
const BenchmarkPrompt = require('../../models/BenchmarkPrompt');
const { validateJudgeModel, probeJudgeCapability } = require('../../src/services/benchmark/judgeModelValidator');
const { callJudge } = require('../../src/services/scoring/judgeCall');
const { validateExecutionHost } = require('../../src/services/benchmark/executionHostValidator');
const { runPreflight } = require('../../src/services/benchmark/preflight');
const {
    resolveReadyJudgeTarget,
    judgeUnavailablePayload
} = require('../../src/services/benchmark/judgeReadiness');
const buddySurface = require('../../src/services/benchmark/buddySurfaceEvents');
const { resolveJudgeHost } = require('../../src/services/benchmark/judgeHostResolution');
const { resolveMultiJudge } = require('../../src/services/benchmark/resolveMultiJudge');
const { releaseBenchmarkClaim } = require('../../src/clients/coreApiClient');
const {
    filterJudgeDefaultsForExecutionHost,
    resolveBatchMultiJudgeInput
} = require('../../src/services/benchmark/multiJudgeDefaults');
const { normalizeHostUrl } = require('../../src/helpers/ollamaHostConfig');
const { validateObjectId } = require('../../src/helpers/objectIdValidator');
const { findActiveProfilingForHost } = require('../../src/services/profiler/activeProfileState');
const {
    buildOllamaTarget,
    normalizeBatchTargets,
    normalizeBenchmarkTarget
} = require('../../../shared/benchmarkTargetContract');
const { resolveHarnessTarget } = require('../../src/services/benchmark/harnessBrokerClient');
const {
    getQuickJudgeCalibrationCases,
    getQuickJudgeCalibrationProtocol,
    evaluateQuickJudgeCalibrationCase
} = require('../../src/services/benchmark/quickJudgeCalibration');
const path = require('path');
const fs = require('fs');

// An operator may explicitly configure a secondary judge artifact. There is no
// product-wide fallback model because installed inventory is deployment state.
const JUDGE_FALLBACK_MODEL = String(process.env.JUDGE_FALLBACK_MODEL || '').trim() || null;

function readJudgeDefaults() {
    try {
        const p = process.env.JUDGE_DEFAULTS_PATH
            || path.join(process.cwd(), 'config', 'judge-host-defaults.json');
        if (!fs.existsSync(p)) return {};
        return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
    } catch { return {}; }
}

function isDuplicateKeyError(err) {
    return !!(err && (err.code === 11000 || String(err.message || '').includes('E11000')));
}

function judgeValidationAdmissionFailure(check) {
    const policy = {
        invalid_judge_target: { statusCode: 400, code: 'JUDGE_TARGET_REJECTED' },
        incomplete_judge_target: { statusCode: 400, code: 'JUDGE_TARGET_INCOMPLETE' },
        judge_host_not_configured: { statusCode: 400, code: 'JUDGE_HOST_NOT_CONFIGURED' },
        judge_model_unavailable: { statusCode: 409, code: 'JUDGE_MODEL_UNAVAILABLE' },
        selected_models_unavailable: { statusCode: 409, code: 'JUDGE_MODEL_UNAVAILABLE' },
        judge_host_unreachable: { statusCode: 503, code: 'JUDGE_HOST_UNREACHABLE' },
        hosts_unreachable: { statusCode: 503, code: 'JUDGE_HOST_UNREACHABLE' }
    }[check?.code] || { statusCode: 503, code: 'JUDGE_NOT_READY' };
    const payload = judgeUnavailablePayload(check, 'Judge validation');
    return {
        statusCode: policy.statusCode,
        payload: {
            ...payload,
            code: policy.code,
            admission_code: check?.code || 'unknown'
        }
    };
}

// Look up the per-host stored default judge model for a given judge host,
// matching the same way the judge-defaults store/endpoint does (by normalized
// host URL). Returns undefined when no default is recorded for that host.
function lookupHostJudgeDefault(judgeDefaults, judgeHost) {
    if (!judgeHost) return undefined;
    const normalizedTarget = normalizeHostUrl(judgeHost);
    for (const [host, model] of Object.entries(judgeDefaults || {})) {
        if (!host || !model) continue;
        if (normalizeHostUrl(host) === normalizedTarget) return model;
    }
    return undefined;
}

async function resolveBatchJudgeTarget(executionHost, judgeConfig = {}, { judgeDefaults } = {}) {
    // When the caller did not pin judge.host, prefer the env-driven JUDGE_CONFIG.host
    // (set via JUDGE_HOST in .env) over collapsing onto the execution host. This
    // keeps generation and judging on different GPUs by default.
    const effectiveHost = judgeConfig.host || JUDGE_CONFIG.host || undefined;
    const { judgeHost: resolvedJudgeHost } = resolveJudgeHost(executionHost, {
        ...judgeConfig,
        host: effectiveHost
    });

    // Judge model precedence:
    //   1. explicit judgeConfig.model (caller pinned it)
    //   2. per-host stored default for the resolved judge host (judge-defaults store)
    //   3. env-driven JUDGE_CONFIG.model fallback
    // Without step 2, a batch submitted with no judge_config.model would silently
    // be judged by the env default model even when the host-defaults UI/store says
    // otherwise — breaking drift comparability against the ratified judge baseline.
    const storedDefaults = judgeDefaults || readJudgeDefaults();
    const hostDefaultModel = judgeConfig.model
        ? undefined
        : lookupHostJudgeDefault(storedDefaults, resolvedJudgeHost);
    const effectiveModel = judgeConfig.model || hostDefaultModel || JUDGE_CONFIG.model || undefined;

    const effectiveJudgeConfig = {
        ...judgeConfig,
        host: effectiveHost,
        model: effectiveModel
    };

    return {
        normalizedJudgeConfig: effectiveJudgeConfig,
        validationHost: effectiveJudgeConfig.host || resolvedJudgeHost || null,
        validationModel: effectiveJudgeConfig.model || null
    };
}

function buildActiveBatchConflict(active) {
    const STUCK_THRESHOLD_SECONDS = 300;
    const inactiveSeconds = active.last_activity_at
        ? Math.floor((Date.now() - new Date(active.last_activity_at).getTime()) / 1000)
        : 0;

    return {
        status: 'error',
        error: 'Another batch is already running',
        active_batch: {
            id: active._id,
            run_name: active.run_name,
            status: active.status,
            progress: active.progress,
            inactive_seconds: inactiveSeconds,
            is_stuck: inactiveSeconds > STUCK_THRESHOLD_SECONDS,
            started_at: active.started_at
        },
        message: inactiveSeconds > STUCK_THRESHOLD_SECONDS
            ? 'The active batch appears stuck. Use the "Recover" button to stop it before starting a new batch.'
            : `Batch "${active.run_name}" is currently running (${active.progress}% complete). Please wait for it to finish or stop it first.`
    };
}

function buildActiveProfilingConflict(host, activeProfiling) {
    const first = activeProfiling[0] || {};
    const label = first.type === 'profile-host'
        ? `profile queue ${first.queueId || ''}`.trim()
        : `profile job ${first.profileId || ''}`.trim();
    return {
        status: 'error',
        code: 'EXECUTION_HOST_PROFILING',
        error: 'Execution host is currently profiling',
        host,
        active_profiling: activeProfiling,
        message: `Host ${host} has an active ${label}. Wait for profiling to finish or cancel it before starting a benchmark batch.`
    };
}

function batchClaimHosts(batch) {
    const hosts = new Set();
    const add = (host) => {
        const normalized = String(host || '').trim().replace(/\/+$/, '');
        if (normalized) hosts.add(normalized);
    };

    add(batch?.host);
    for (const entry of batch?.plan?.exec_hosts || []) {
        add(entry?.exec_host);
        add(entry?.judge_host);
    }
    return [...hosts];
}

function releaseStoppedBatchClaims(batch) {
    const batchId = String(batch?._id || '');
    const hosts = batchClaimHosts(batch);
    if (!batchId || hosts.length === 0) return hosts;

    setImmediate(async () => {
        for (const hostUrl of hosts) {
            try {
                await releaseBenchmarkClaim(hostUrl, batchId);
                logger.info('Released benchmark claim after stop', { batchId, hostUrl });
            } catch (err) {
                logger.warn('Failed to release benchmark claim after stop', {
                    batchId,
                    hostUrl,
                    error: err.message
                });
            }
        }
    });

    return hosts;
}

/**
 * GET /api/benchmark/config
 * Get benchmark configuration including judge settings
 */
router.get('/config', async (req, res) => {
    const judgeDefaults = readJudgeDefaults();

    // Merge judge settings from config file (setup wizard) if available
    const { readConfigFile } = require('../../src/helpers/ollamaHostConfig');
    const fileConfig = readConfigFile();
    const baseJudge = { ...JUDGE_CONFIG, concurrency: 2 };
    if (fileConfig?.judge) {
        if (fileConfig.judge.model) baseJudge.model = fileConfig.judge.model;
        if (fileConfig.judge.host) baseJudge.host = fileConfig.judge.host;
    }

    res.json({
        status: 'success',
        data: {
            judge_config: baseJudge,
            execution_config: benchmarkService.getExecutionConfigDefaults(),
            scoring_configs: ENHANCED_SCORING_CONFIGS,
            judge_host_defaults: judgeDefaults
        }
    });
});

/**
 * GET /api/benchmark/prompts
 * Get all prompts grouped by level
 */
router.get('/prompts', async (req, res) => {
    try {
        const data = await benchmarkService.getPrompts();

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch prompts', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/prompts/sync
 * Explicitly synchronize the product-owned prompt library.
 */
router.post('/prompts/sync', async (req, res) => {
    try {
        const total = await benchmarkService.seedPrompts();
        const data = await benchmarkService.getPrompts();
        res.json({
            status: 'success',
            data: {
                ...data,
                synchronized_total: total
            }
        });
    } catch (err) {
        logger.error('Failed to synchronize prompts', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/test
 * Run a single benchmark test
 */
router.post('/test', async (req, res) => {
    const { model, host, prompt } = req.body;

    // Validation
    if (!model || !host || !prompt) {
        return res.status(400).json({
            status: 'error',
            error: 'model, host, and prompt are required'
        });
    }

    try {
        const result = await benchmarkService.runTest({
            model,
            host,
            prompt
        });

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Benchmark test failed', { model, host, error: err.message });

        res.status(500).json({
            status: 'error',
            error: err.message
        });
    }
});

/**
 * POST /api/benchmark/batch
 * Start a batch benchmark test with quality scoring
 */
router.post('/batch', async (req, res) => {
    let { host, models, targets, levels, prompt_ids, run_name, judge_config, execution_config, execution_mode, depth_config, tags, description, multi_judge, paid_approval, campaign_kind } = req.body;

    // Validation
    if ((!Array.isArray(targets) || targets.length === 0) && (!host || !models || !Array.isArray(models))) {
        return res.status(400).json({
            status: 'error',
            error: 'targets (array), or legacy host + models (array), are required'
        });
    }
    if (!levels || !Array.isArray(levels)) {
        return res.status(400).json({ status: 'error', error: 'levels (array) are required' });
    }

    let normalizedTargets;
    try {
        normalizedTargets = normalizeBatchTargets({ host, models, targets });
    } catch (error) {
        return res.status(error.statusCode || 400).json({ status: 'error', code: error.code, error: error.message });
    }
    const localTargets = normalizedTargets.filter((target) => target.executionKind === 'ollama');
    const harnessTargets = normalizedTargets.filter((target) => target.executionKind === 'harness');
    host = localTargets[0]?.host || 'harness';
    models = normalizedTargets.map((target) => target.model);

    // Input length limits
    if (run_name && String(run_name).length > 200) {
        return res.status(400).json({ status: 'error', error: 'run_name must be 200 characters or less' });
    }
    if (description && String(description).length > 2000) {
        return res.status(400).json({ status: 'error', error: 'description must be 2000 characters or less' });
    }
    if (tags && Array.isArray(tags)) {
        if (tags.length > 20) {
            return res.status(400).json({ status: 'error', error: 'Maximum 20 tags allowed' });
        }
        if (tags.some(t => String(t).length > 50)) {
            return res.status(400).json({ status: 'error', error: 'Each tag must be 50 characters or less' });
        }
    }
    if (normalizedTargets.length > 50) {
        return res.status(400).json({ status: 'error', error: 'Maximum 50 models allowed per batch' });
    }
    if (levels.length > 5) {
        return res.status(400).json({ status: 'error', error: 'Maximum 5 levels allowed' });
    }
    if (prompt_ids !== undefined) {
        if (!Array.isArray(prompt_ids)) {
            return res.status(400).json({ status: 'error', error: 'prompt_ids must be an array when provided' });
        }
        if (prompt_ids.length > 100) {
            return res.status(400).json({ status: 'error', error: 'Maximum 100 prompt_ids allowed per batch' });
        }
        const invalidPromptIds = prompt_ids
            .map(id => String(id))
            .filter(id => !mongoose.Types.ObjectId.isValid(id));
        if (invalidPromptIds.length > 0) {
            return res.status(400).json({
                status: 'error',
                error: `Invalid prompt_ids: ${invalidPromptIds.join(', ')}`
            });
        }
    }

    // Validate advanced judge_config fields if provided
    if (judge_config && typeof judge_config === 'object') {
        const jc = judge_config;
        if (jc.temperature !== undefined && (typeof jc.temperature !== 'number' || jc.temperature < 0 || jc.temperature > 1)) {
            return res.status(400).json({ status: 'error', error: 'judge_config.temperature must be a number between 0 and 1' });
        }
        if (jc.num_predict !== undefined && (typeof jc.num_predict !== 'number' || jc.num_predict < 100 || jc.num_predict > 4096)) {
            return res.status(400).json({ status: 'error', error: 'judge_config.num_predict must be a number between 100 and 4096' });
        }
        if (jc.num_ctx != null && (typeof jc.num_ctx !== 'number' || jc.num_ctx < 512)) {
            return res.status(400).json({ status: 'error', error: 'judge_config.num_ctx must be a number of at least 512' });
        }
        if (jc.max_retries !== undefined && (typeof jc.max_retries !== 'number' || jc.max_retries < 0 || jc.max_retries > 5)) {
            return res.status(400).json({ status: 'error', error: 'judge_config.max_retries must be a number between 0 and 5' });
        }
        if (jc.timeout !== undefined && (typeof jc.timeout !== 'number' || jc.timeout < 5000 || jc.timeout > 120000)) {
            return res.status(400).json({ status: 'error', error: 'judge_config.timeout must be a number between 5000 and 120000' });
        }
        if (jc.voting_count !== undefined && (typeof jc.voting_count !== 'number' || ![1, 3, 5].includes(jc.voting_count))) {
            return res.status(400).json({ status: 'error', error: 'judge_config.voting_count must be 1, 3, or 5' });
        }
        if (jc.think !== undefined && jc.think !== false) {
            return res.status(400).json({ status: 'error', error: 'judge_config.think must be false; judges always score visible final answers with thinking disabled' });
        }
    }

    // Validate advanced execution_config fields if provided
    if (execution_config && typeof execution_config === 'object') {
        const ec = execution_config;
        if (ec.per_test_timeout_ms !== undefined && (typeof ec.per_test_timeout_ms !== 'number' || ec.per_test_timeout_ms < 30000 || ec.per_test_timeout_ms > 1200000)) {
            return res.status(400).json({ status: 'error', error: 'execution_config.per_test_timeout_ms must be between 30000 and 1200000' });
        }
        if (ec.warmup_timeout_cold !== undefined && (typeof ec.warmup_timeout_cold !== 'number' || ec.warmup_timeout_cold < 30000 || ec.warmup_timeout_cold > 600000)) {
            return res.status(400).json({ status: 'error', error: 'execution_config.warmup_timeout_cold must be between 30000 and 600000' });
        }
        if (ec.warmup_timeout_loaded !== undefined && (typeof ec.warmup_timeout_loaded !== 'number' || ec.warmup_timeout_loaded < 10000 || ec.warmup_timeout_loaded > 180000)) {
            return res.status(400).json({ status: 'error', error: 'execution_config.warmup_timeout_loaded must be between 10000 and 180000' });
        }
        if (ec.judge_drain_timeout_ms !== undefined && (typeof ec.judge_drain_timeout_ms !== 'number' || ec.judge_drain_timeout_ms < 300000 || ec.judge_drain_timeout_ms > 3600000)) {
            return res.status(400).json({ status: 'error', error: 'execution_config.judge_drain_timeout_ms must be between 300000 and 3600000' });
        }
        if (ec.judge_stall_timeout_ms !== undefined && (typeof ec.judge_stall_timeout_ms !== 'number' || ec.judge_stall_timeout_ms < 30000 || ec.judge_stall_timeout_ms > 600000)) {
            return res.status(400).json({ status: 'error', error: 'execution_config.judge_stall_timeout_ms must be between 30000 and 600000' });
        }
        if (ec.think !== undefined) {
            const validThink = typeof ec.think === 'boolean'
                || ['auto', 'on', 'off', 'true', 'false', 'enabled', 'disabled', 'force', 'forced', 'never'].includes(String(ec.think).trim().toLowerCase());
            if (!validThink) {
                return res.status(400).json({ status: 'error', error: 'execution_config.think must be a boolean or one of: auto, on, off' });
            }
        }
        if (ec.response_mode !== undefined) {
            const validMode = ['final_only', 'native', 'explicit_thinking', 'profile_auto'].includes(
                String(ec.response_mode).trim().toLowerCase()
            );
            if (!validMode) {
                return res.status(400).json({ status: 'error', error: 'execution_config.response_mode must be one of: final_only, native, explicit_thinking, profile_auto' });
            }
        }
    }

    if (campaign_kind === 'native_agent' || normalizedTargets.some((target) => target.mode === 'native_agent')) {
        return res.status(422).json({
            status: 'error',
            code: 'NATIVE_AGENT_CAMPAIGN_SEPARATE',
            error: 'Native-agent harness campaigns use /api/benchmark/harness-campaigns and never create model leaderboard rows'
        });
    }

    let readyJudgeConfig;
    let harnessJudgeTarget = null;
    try {
        normalizedTargets = await Promise.all(normalizedTargets.map(async (target) => (
            target.executionKind === 'harness'
                ? resolveHarnessTarget(target, { force: true })
                : target
        )));
        const unavailableCandidate = normalizedTargets.find((target) => target.capabilities.candidate !== true);
        if (unavailableCandidate) {
            return res.status(422).json({
                status: 'error', code: 'TARGET_CANDIDATE_NOT_ALLOWED',
                error: `Target ${unavailableCandidate.id} is not catalogued for candidate execution`
            });
        }

        if (judge_config?.target?.executionKind === 'harness') {
            harnessJudgeTarget = await resolveHarnessTarget(
                normalizeBenchmarkTarget(judge_config.target),
                { force: true }
            );
            if (harnessJudgeTarget.mode !== 'isolated_model' || harnessJudgeTarget.capabilities.judge !== true) {
                return res.status(422).json({
                    status: 'error',
                    code: 'HARNESS_JUDGE_NOT_ALLOWED',
                    error: 'Only isolated_model harness targets with judge capability may judge'
                });
            }
            readyJudgeConfig = {
                ...(judge_config || {}),
                target: harnessJudgeTarget,
                host: `harness:${harnessJudgeTarget.harness.name}`,
                model: harnessJudgeTarget.model
            };
        } else {
            // Resolve local judges through the same readiness authority used by
            // Courthouse. Cloud judges are catalog-bound above instead.
            const judgeReadiness = await resolveReadyJudgeTarget({
                host: judge_config?.host,
                model: judge_config?.model
            });
            if (!judgeReadiness.ready) {
                return res.status(503).json(judgeUnavailablePayload(judgeReadiness, 'Benchmark launch'));
            }
            readyJudgeConfig = {
                ...(judge_config || {}),
                target: buildOllamaTarget(judgeReadiness.target.host, judgeReadiness.target.model),
                host: judgeReadiness.target.host,
                model: judgeReadiness.target.model
            };
        }

        // Ollama keeps its existing host/model validation. Harness targets are
        // validated against the broker catalog and never sent to /api/tags.
        const localGroups = new Map();
        for (const target of normalizedTargets.filter((entry) => entry.executionKind === 'ollama')) {
            const group = localGroups.get(target.host) || [];
            group.push(target.model);
            localGroups.set(target.host, group);
        }
        for (const [localHost, localModels] of localGroups.entries()) {
            const hostCheck = await validateExecutionHost(localHost, localModels);
            if (!hostCheck.valid) {
                return res.status(422).json({
                    status: 'error',
                    error: hostCheck.error,
                    ...(hostCheck.available_models && { available_models: hostCheck.available_models })
                });
            }
        }
    } catch (error) {
        return res.status(error.statusCode || 422).json({ status: 'error', code: error.code, error: error.message });
    }

    // Dedication check removed — the batch orchestrator handles dedication
    // lifecycle automatically (detect pins → run batch → restore pins).

    try {
        // ENFORCE SINGLE BATCH: Check for existing active batches
        const activeBatches = await BenchmarkBatch.getActive();

        if (activeBatches.length > 0) {
            return res.status(409).json(buildActiveBatchConflict(activeBatches[0]));
        }

        for (const localHost of new Set(localTargets.map((target) => target.host))) {
            const activeProfiling = findActiveProfilingForHost({ hostUrl: localHost });
            if (activeProfiling.length > 0) {
                return res.status(409).json(buildActiveProfilingConflict(localHost, activeProfiling));
            }
        }

        // Multi-judge is opt-in. Hard L4/L5 suites still preserve explicit
        // off/custom choices, but omission resolves to the global default.
        const multiJudgeHostDefaults = harnessJudgeTarget
            ? {}
            : filterJudgeDefaultsForExecutionHost(readJudgeDefaults(), host);
        const resolvedMultiJudge = resolveMultiJudge(
            resolveBatchMultiJudgeInput(levels, multi_judge),
            { hostDefaults: multiJudgeHostDefaults }
        );
        if (harnessJudgeTarget && resolvedMultiJudge.enabled) {
            return res.status(422).json({
                status: 'error',
                code: 'HARNESS_MULTI_JUDGE_NOT_SUPPORTED',
                error: 'A harness judge must run as one exact isolated target; disable multi-judge for this batch'
            });
        }
        const judgeConfigWithMulti = {
            ...readyJudgeConfig,
            multi_judge: resolvedMultiJudge
        };

        let normalizedJudgeConfig;
        let actualJudgeHost;
        let judgeModel;
        if (harnessJudgeTarget) {
            normalizedJudgeConfig = judgeConfigWithMulti;
            actualJudgeHost = `harness:${harnessJudgeTarget.harness.name}`;
            judgeModel = harnessJudgeTarget.model;
        } else {
            ({
                normalizedJudgeConfig,
                validationHost: actualJudgeHost,
                validationModel: judgeModel
            } = await resolveBatchJudgeTarget(host, judgeConfigWithMulti));
        }

        if (!harnessJudgeTarget && actualJudgeHost && judgeModel) {
            let validation = await validateJudgeModel(actualJudgeHost, judgeModel);

            // 0219 tiered judge: if the resolved default judge isn't on this host
            // and the caller did NOT pin a model, fall back to the lighter judge
            // instead of failing the batch. An explicit judge_config.model is
            // never silently downgraded. On a host with both models present this
            // path is dead (14b validates), so it changes nothing on the current
            // cluster — it only rescues 7b-only hosts. No judge-mixing risk: the
            // host runs all-14b or all-7b, never both in one batch.
            const callerPinnedModel = !!(judge_config && judge_config.model);
            if (!validation.valid && !callerPinnedModel
                && JUDGE_FALLBACK_MODEL && JUDGE_FALLBACK_MODEL !== judgeModel) {
                const fallbackValidation = await validateJudgeModel(actualJudgeHost, JUDGE_FALLBACK_MODEL);
                if (fallbackValidation.valid) {
                    logger.warn('Judge model unavailable on host; falling back to lighter judge (0219)', {
                        host: actualJudgeHost,
                        requested: judgeModel,
                        fallback: JUDGE_FALLBACK_MODEL
                    });
                    judgeModel = JUDGE_FALLBACK_MODEL;
                    normalizedJudgeConfig = { ...normalizedJudgeConfig, model: JUDGE_FALLBACK_MODEL };
                    validation = fallbackValidation;
                }
            }

            if (!validation.valid) {
                return res.status(422).json({
                    status: 'error',
                    error: `Judge model validation failed on ${actualJudgeHost}: ${validation.error}`,
                    available_models: validation.available_models || [],
                    latency_ms: validation.latency_ms
                });
            }
        }

        const preflightJudgeConfig = {
            ...normalizedJudgeConfig,
            host: actualJudgeHost || normalizedJudgeConfig.host,
            model: judgeModel || normalizedJudgeConfig.model
        };

        buddySurface.emitLifecycle('preflight_start', `Preflight: validating ${normalizedTargets.length} target(s) before launch…`);
        const localPreflightTargets = normalizedTargets
            .filter((target) => target.executionKind === 'ollama')
            .map((target) => ({ host: target.host, model: target.model }));
        const preflight = await runPreflight({
            targets: localPreflightTargets,
            judgeConfig: harnessJudgeTarget
                ? { ...preflightJudgeConfig, target: harnessJudgeTarget }
                : preflightJudgeConfig,
            levels,
            prompt_ids,
            executionConfig: execution_config || null
        });
        preflight.checks.harness = {
            targets: normalizedTargets.length - localPreflightTargets.length,
            judge: Boolean(harnessJudgeTarget),
            catalog_revalidated: true
        };

        if (!preflight.ready) {
            buddySurface.emitLifecycle(
                'preflight_blocked',
                `Preflight blocked launch: ${(preflight.issues || []).slice(0, 2).join('; ') || 'requirements not met'}`
            );
            return res.status(422).json({
                status: 'error',
                error: 'Benchmark preflight failed',
                issues: preflight.issues,
                preflight
            });
        }
        // Pre-run only: no judge/scoring active yet, so a suggesting intent is allowed.
        buddySurface.emitLifecycle('preflight_ok', `Preflight passed — ready to launch ${normalizedTargets.length} target(s).`);

        const data = await benchmarkService.startBatch({
            host,
            models,
            targets: normalizedTargets,
            levels,
            prompt_ids,
            run_name,
            judge_config: normalizedJudgeConfig,
            execution_config,
            execution_mode: execution_mode || 'latency',
            depth_config: depth_config || null,
            tags,
            description,
            paid_approval,
            campaign_kind: 'model'
        });

        res.json({
            status: 'success',
            data: {
                ...data,
                preflight,
                message: 'Batch test started with quality scoring'
            }
        });
    } catch (err) {
        if (String(err.message || '').startsWith('Prompt IDs not found:')) {
            return res.status(422).json({ status: 'error', error: err.message });
        }
        if (isDuplicateKeyError(err)) {
            // Atomic backstop for start-race collisions (two clients pass pre-check simultaneously).
            const activeBatches = await BenchmarkBatch.getActive();
            if (activeBatches.length > 0) {
                return res.status(409).json(buildActiveBatchConflict(activeBatches[0]));
            }
            return res.status(409).json({
                status: 'error',
                error: 'Another batch is already running'
            });
        }

        logger.error('Failed to start batch test', { error: err.message });
        res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
    }
});

/**
 * POST /api/benchmark/batch/:id/stop
 * Stop a running batch
 */
router.post('/batch/:id/stop', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;
        const { batch, alreadyStopped, managedLocally } = await benchmarkService.stopBatch(req.params.id);

        // Also stop any active judging
        stopJudging(req.params.id);
        // A live in-process orchestrator owns its claim/dedication teardown and
        // releases them only after every cancelled task has settled. Direct
        // release remains the recovery path for an orphaned/non-local batch.
        const claimReleaseHosts = managedLocally ? [] : releaseStoppedBatchClaims(batch);

        res.json({
            status: 'success',
            message: alreadyStopped ? `Batch already ${batch.status}` : 'Batch stopped',
            data: {
                batch_id: batch._id,
                status: batch.status,
                already_stopped: alreadyStopped,
                cleanup_managed_by_runner: managedLocally === true,
                claim_release_started: claimReleaseHosts.length > 0,
                claim_release_hosts: claimReleaseHosts
            }
        });
    } catch (err) {
        logger.error('Failed to stop batch', { error: err.message });

        const statusCode = err.message.includes('not found') ? 404 : 500;
        res.status(statusCode).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/batch/:id/resume
 * Resume a stopped/failed/interrupted batch from its checkpoint
 */
router.post('/batch/:id/resume', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;
        const batch = await BenchmarkBatch.findById(req.params.id)
            .select('judge_config plan.judge_model plan.exec_hosts')
            .lean();
        if (!batch) {
            return res.status(404).json({ status: 'error', error: 'Batch not found' });
        }
        let resumedJudgeConfig = { ...(batch.judge_config || {}) };
        if (batch.judge_config?.target?.executionKind === 'harness') {
            const currentTarget = await resolveHarnessTarget(batch.judge_config.target, { force: true });
            resumedJudgeConfig = {
                ...resumedJudgeConfig,
                target: currentTarget,
                host: `harness:${currentTarget.harness.name}`,
                model: currentTarget.model
            };
        } else {
            const readiness = await resolveReadyJudgeTarget({
                host: batch.judge_config?.host || batch.plan?.exec_hosts?.[0]?.judge_host,
                model: batch.judge_config?.model || batch.plan?.judge_model
            });
            if (!readiness.ready) {
                return res.status(503).json(judgeUnavailablePayload(readiness, 'Batch resume'));
            }
            resumedJudgeConfig = {
                ...resumedJudgeConfig,
                target: buildOllamaTarget(readiness.target.host, readiness.target.model),
                host: readiness.target.host,
                model: readiness.target.model
            };
        }
        const data = await benchmarkService.resumeBatch(req.params.id, {
            judgeConfig: resumedJudgeConfig,
            paidApproval: req.body?.paid_approval || null
        });
        res.json({ status: 'success', data });
    } catch (err) {
        logger.error('Failed to resume batch', { error: err.message });
        const statusCode = err.statusCode || (err.message.includes('not found') ? 404
            : err.message.includes('Cannot resume') ? 409 : 500);
        res.status(statusCode).json({ status: 'error', code: err.code, error: err.message });
    }
});

/**
 * POST /api/benchmark/batch/:id/rerun-invalid
 * Build or launch an exact rerun for rows excluded from leaderboard.
 * Body: { launch?: boolean, allow_superset?: boolean, execution_config?: object }
 */
router.post('/batch/:id/rerun-invalid', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;

        const batch = await BenchmarkBatch.findById(req.params.id).lean();
        if (!batch) {
            return res.status(404).json({ status: 'error', error: 'Batch not found' });
        }

        const invalidRows = await BenchmarkResult.find({
            batch_id: batch._id,
            excluded_from_leaderboard: true
        }).select('model prompt_name prompt_level prompt_category').lean();

        if (invalidRows.length === 0) {
            return res.status(404).json({
                status: 'error',
                error: 'No excluded/invalid rows found for this batch'
            });
        }

        const promptNames = [...new Set(invalidRows.map(r => r.prompt_name).filter(Boolean))];
        const prompts = await BenchmarkPrompt.find({ name: { $in: promptNames } })
            .select('_id name level category')
            .lean();
        const promptByName = new Map(prompts.map(p => [p.name, p]));
        const missingPromptNames = promptNames.filter(name => !promptByName.has(name));
        if (missingPromptNames.length > 0) {
            return res.status(422).json({
                status: 'error',
                error: `Cannot map invalid rows back to prompt ids: ${missingPromptNames.join(', ')}`
            });
        }

        const models = [...new Set(invalidRows.map(r => r.model).filter(Boolean))];
        const promptIds = prompts.map(p => String(p._id));
        const levels = [...new Set(prompts.map(p => Number(p.level)).filter(Boolean))].sort((a, b) => a - b);
        const rectangularCount = models.length * promptIds.length;
        const isExactRectangularRerun = rectangularCount === invalidRows.length;
        const allowSuperset = req.body?.allow_superset === true;

        const executionOverrides = req.body?.execution_config;
        if (executionOverrides != null
            && (typeof executionOverrides !== 'object' || Array.isArray(executionOverrides))) {
            return res.status(400).json({
                status: 'error',
                error: 'execution_config must be an object when provided'
            });
        }
        const executionConfig = {
            ...(batch.execution_config || {}),
            ...(executionOverrides || {})
        };

        const payload = {
            host: batch.host,
            models,
            levels,
            prompt_ids: promptIds,
            run_name: `Rerun invalid - ${batch.run_name || batch._id}`,
            judge_config: batch.judge_config || undefined,
            execution_config: executionConfig,
            execution_mode: batch.execution_mode || 'latency',
            depth_config: null,
            tags: [...new Set([...(batch.tags || []), 'rerun-invalid', `source:${batch._id}`])],
            description: `Exact rerun for ${invalidRows.length} invalid/excluded row(s) from batch ${batch._id}${executionOverrides ? ' with explicit execution overrides' : ''}.`
        };

        if (!req.body?.launch) {
            return res.json({
                status: 'success',
                data: {
                    launchable: isExactRectangularRerun,
                    exact_rectangular_rerun: isExactRectangularRerun,
                    invalid_rows: invalidRows.length,
                    would_run_tests: rectangularCount,
                    payload
                }
            });
        }

        if (!isExactRectangularRerun && !allowSuperset) {
            return res.status(409).json({
                status: 'error',
                error: 'Invalid rows do not form an exact model x prompt rectangle; refusing to auto-launch a superset rerun',
                data: {
                    invalid_rows: invalidRows.length,
                    would_run_tests: rectangularCount,
                    payload
                }
            });
        }

        const readiness = await resolveReadyJudgeTarget({
            host: payload.judge_config?.host,
            model: payload.judge_config?.model
        });
        if (!readiness.ready) {
            return res.status(503).json(judgeUnavailablePayload(readiness, 'Corrected rerun'));
        }
        payload.judge_config = {
            ...(payload.judge_config || {}),
            host: readiness.target.host,
            model: readiness.target.model
        };

        const activeBatches = await BenchmarkBatch.getActive();
        if (activeBatches.length > 0) {
            return res.status(409).json(buildActiveBatchConflict(activeBatches[0]));
        }

        const activeProfiling = findActiveProfilingForHost({ hostUrl: payload.host });
        if (activeProfiling.length > 0) {
            return res.status(409).json(buildActiveProfilingConflict(payload.host, activeProfiling));
        }

        const preflightJudgeConfig = payload.judge_config || {};
        buddySurface.emitLifecycle('preflight_start', `Preflight: validating ${payload.models.length} model(s) for corrected rerun…`);
        const preflightResult = await runPreflight({
            targets: payload.models.map((modelName) => ({ host: payload.host, model: modelName })),
            judgeConfig: preflightJudgeConfig,
            levels: payload.levels,
            prompt_ids: payload.prompt_ids,
            executionConfig: payload.execution_config
        });
        if (!preflightResult.ready) {
            buddySurface.emitLifecycle(
                'preflight_blocked',
                `Corrected rerun blocked: ${(preflightResult.issues || []).slice(0, 2).join('; ') || 'requirements not met'}`
            );
            return res.status(422).json({
                status: 'error',
                error: 'Corrected rerun preflight failed',
                issues: preflightResult.issues,
                preflight: preflightResult,
                payload
            });
        }
        buddySurface.emitLifecycle('preflight_ok', `Corrected rerun preflight passed — relaunching ${payload.models.length} model(s).`);

        const data = await benchmarkService.startBatch(payload);
        return res.json({
            status: 'success',
            data: {
                ...data,
                preflight: preflightResult,
                source_batch_id: batch._id,
                invalid_rows: invalidRows.length,
                exact_rectangular_rerun: isExactRectangularRerun
            }
        });
    } catch (err) {
        logger.error('Failed to rerun invalid batch rows', { error: err.message, batchId: req.params.id });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/validate-judge
 * Pre-flight check: validate judge model availability and output capability
 */
router.post('/validate-judge', async (req, res) => {
    const { host, model } = req.body || {};

    try {
        const admission = await resolveReadyJudgeTarget({ host, model });
        if (!admission.ready) {
            const failure = judgeValidationAdmissionFailure(admission);
            return res.status(failure.statusCode).json(failure.payload);
        }

        // Only the canonical target returned by the configured-judge
        // admission authority may reach the outbound validation sinks.
        const judgeHost = admission.target.host;
        const judgeModel = admission.target.model;
        const validation = await validateJudgeModel(judgeHost, judgeModel);
        if (validation.valid) {
            const probe = await probeJudgeCapability(judgeHost, judgeModel);
            res.json({
                status: 'success',
                data: {
                    valid: true,
                    host: judgeHost,
                    model: judgeModel,
                    context_length: probe.context_length || null,
                    parameter_size: probe.parameter_size || null,
                    warning: validation.warning || null,
                    latency_ms: validation.latency_ms
                }
            });
        } else {
            const statusCode = validation.code === 'JUDGE_MODEL_UNAVAILABLE' ? 409 : 503;
            res.status(statusCode).json({
                status: 'error',
                code: validation.code || 'JUDGE_VALIDATION_UNAVAILABLE',
                error: validation.error,
                available_models: validation.available_models || [],
                latency_ms: validation.latency_ms
            });
        }
    } catch (err) {
        logger.error('Judge validation failed', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/judge/calibration-protocol
 * Shared metadata for the quick live judge calibration flow.
 */
router.get('/judge/calibration-protocol', (req, res) => {
    return res.json({
        status: 'success',
        data: {
            protocol: getQuickJudgeCalibrationProtocol()
        }
    });
});

/**
 * POST /api/benchmark/judge/calibrate
 * Quick calibration of judge model JSON reliability, consistency, and latency.
 */
router.post('/judge/calibrate', async (req, res) => {
    const { host, model } = req.body || {};
    const readiness = await resolveReadyJudgeTarget({ host, model });
    if (!readiness.ready) {
        return res.status(503).json(judgeUnavailablePayload(readiness, 'Judge calibration'));
    }
    const judgeHost = readiness.target.host;
    const judgeModel = readiness.target.model;

    const calibrationCases = getQuickJudgeCalibrationCases();

    try {
        const details = [];

        for (const testCase of calibrationCases) {
            const startedAt = Date.now();
            const judgeRes = await callJudge(testCase.prompt, {
                host: judgeHost,
                model: judgeModel,
                timeout: 20000,
                max_retries: 1,
                temperature: 0.1,
                num_predict: 120
            });
            const latencyMs = Date.now() - startedAt;

            const passed = !!(judgeRes.success && evaluateQuickJudgeCalibrationCase(testCase, judgeRes.scores));
            details.push({
                id: testCase.id,
                title: testCase.title,
                purpose: testCase.purpose,
                pass_criteria: testCase.passCriteria,
                passed,
                latency_ms: latencyMs,
                overall: typeof judgeRes?.scores?.overall === 'number' ? judgeRes.scores.overall : null,
                error: judgeRes.success ? null : judgeRes.error
            });
        }

        const consistencyA = details.find((d) => d.id === 'consistency_a');
        const consistencyB = details.find((d) => d.id === 'consistency_b');
        if (consistencyA && consistencyB && consistencyA.overall !== null && consistencyB.overall !== null) {
            const drift = Math.abs(consistencyA.overall - consistencyB.overall);
            if (drift > 2.0) {
                consistencyA.passed = false;
                consistencyA.error = `consistency drift=${drift.toFixed(2)}`;
            }
        }

        const testsTotal = details.length;
        const testsPassed = details.filter((d) => d.passed).length;
        const reliability = testsTotal > 0 ? testsPassed / testsTotal : 0;
        const avgLatencyMs = Math.round(details.reduce((sum, d) => sum + d.latency_ms, 0) / Math.max(1, details.length));

        return res.json({
            status: 'success',
            data: {
                protocol: getQuickJudgeCalibrationProtocol(),
                host: judgeHost,
                model: judgeModel,
                passed: reliability >= 0.70,
                reliability,
                avg_latency_ms: avgLatencyMs,
                tests_total: testsTotal,
                tests_passed: testsPassed,
                details
            }
        });
    } catch (err) {
        logger.error('Judge calibration failed', { error: err.message, host: judgeHost, model: judgeModel });
        return res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/judge/calibrate-accuracy
 * Test judge accuracy against gold-standard scored responses.
 * Returns Pearson correlation, MAE, and per-tier breakdown.
 */
router.post('/judge/calibrate-accuracy', async (req, res) => {
    const { host, model } = req.body || {};
    const readiness = await resolveReadyJudgeTarget({ host, model });
    if (!readiness.ready) {
        return res.status(503).json(judgeUnavailablePayload(readiness, 'Judge accuracy calibration'));
    }
    const judgeHost = readiness.target.host;
    const judgeModel = readiness.target.model;

    try {
        const calibrationSet = require('../../data/judge-calibration-set.json');
        const { scoreResponse } = require('../../src/services/qualityScorer');
        const results = [];

        for (const item of calibrationSet) {
            const start = Date.now();
            try {
                const scores = await scoreResponse({
                    response: item.response,
                    prompt: {
                        prompt: item.prompt,
                        category: item.category,
                        expected_answer: item.expected_answer
                    },
                    judgeConfig: { host: judgeHost, model: judgeModel }
                });

                results.push({
                    id: item.id,
                    category: item.category,
                    tier: item.tier,
                    gold_score: item.gold_score,
                    judge_score: scores.quality_score,
                    diff: Math.round((scores.quality_score - item.gold_score) * 10) / 10,
                    abs_diff: Math.round(Math.abs(scores.quality_score - item.gold_score) * 10) / 10,
                    latency_ms: Date.now() - start,
                    success: true
                });
            } catch (err) {
                results.push({
                    id: item.id,
                    category: item.category,
                    tier: item.tier,
                    gold_score: item.gold_score,
                    judge_score: null,
                    diff: null,
                    abs_diff: null,
                    latency_ms: Date.now() - start,
                    success: false,
                    error: err.message
                });
            }
        }

        const successful = results.filter(r => r.success && r.judge_score !== null);
        const n = successful.length;

        // Mean Absolute Error
        const mae = n > 0
            ? Math.round((successful.reduce((s, r) => s + r.abs_diff, 0) / n) * 100) / 100
            : null;

        // Bias (positive = judge scores higher than gold)
        const bias = n > 0
            ? Math.round((successful.reduce((s, r) => s + r.diff, 0) / n) * 100) / 100
            : null;

        // Agreement rate (within +/- 1 point)
        const agreements = successful.filter(r => r.abs_diff <= 1).length;
        const agreementRate = n > 0 ? Math.round((agreements / n) * 100) : 0;

        // Pearson correlation
        let correlation = null;
        if (n >= 3) {
            const goldScores = successful.map(r => r.gold_score);
            const judgeScores = successful.map(r => r.judge_score);
            const meanGold = goldScores.reduce((a, b) => a + b, 0) / n;
            const meanJudge = judgeScores.reduce((a, b) => a + b, 0) / n;
            let num = 0, denGold = 0, denJudge = 0;
            for (let i = 0; i < n; i++) {
                const dg = goldScores[i] - meanGold;
                const dj = judgeScores[i] - meanJudge;
                num += dg * dj;
                denGold += dg * dg;
                denJudge += dj * dj;
            }
            const den = Math.sqrt(denGold * denJudge);
            correlation = den > 0 ? Math.round((num / den) * 1000) / 1000 : 0;
        }

        // Per-tier breakdown
        const byTier = {};
        for (const r of successful) {
            if (!byTier[r.tier]) byTier[r.tier] = { count: 0, totalError: 0, totalBias: 0 };
            byTier[r.tier].count++;
            byTier[r.tier].totalError += r.abs_diff;
            byTier[r.tier].totalBias += r.diff;
        }
        const tierBreakdown = {};
        for (const [tier, stats] of Object.entries(byTier)) {
            tierBreakdown[tier] = {
                count: stats.count,
                mae: Math.round((stats.totalError / stats.count) * 100) / 100,
                bias: Math.round((stats.totalBias / stats.count) * 100) / 100
            };
        }

        const valid = correlation !== null && correlation >= 0.8;

        return res.json({
            status: 'success',
            data: {
                host: judgeHost,
                model: judgeModel,
                valid,
                correlation,
                mae,
                bias,
                agreement_rate: agreementRate,
                total: calibrationSet.length,
                scored: n,
                failed: calibrationSet.length - n,
                tier_breakdown: tierBreakdown,
                results
            }
        });
    } catch (err) {
        logger.error('Judge accuracy calibration failed', { error: err.message, host: judgeHost, model: judgeModel });
        return res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/preflight
 * Run pre-flight validation checks before starting a batch.
 * Body: { targets: [{host, model}], judge_config: {host, model}, levels: [1,2,3,4,5] }
 */
router.post('/preflight', async (req, res) => {
    try {
        const { targets = [], judge_config = {}, levels, prompt_ids = null, execution_config = null } = req.body || {};
        const readiness = await resolveReadyJudgeTarget({
            host: judge_config.host,
            model: judge_config.model
        });
        if (!readiness.ready) {
            const issue = readiness.error || 'No selected, reachable judge is ready.';
            return res.json({
                status: 'success',
                data: {
                    ready: false,
                    issues: [`Judge: ${issue}`],
                    checks: {
                        judge: {
                            ok: false,
                            host: judge_config.host || null,
                            model: judge_config.model || null,
                            warnings: [],
                            blockers: [issue],
                            readiness: readiness.readiness
                        }
                    }
                }
            });
        }
        const result = await runPreflight({
            targets,
            judgeConfig: {
                ...judge_config,
                host: readiness.target.host,
                model: readiness.target.model
            },
            levels: Array.isArray(levels) ? levels : [1, 2, 3, 4, 5],
            prompt_ids,
            executionConfig: execution_config
        });

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Pre-flight check failed', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;

// Exposed for unit tests — internal judge-target resolution helpers.
module.exports.resolveBatchJudgeTarget = resolveBatchJudgeTarget;
module.exports.lookupHostJudgeDefault = lookupHostJudgeDefault;
module.exports.judgeValidationAdmissionFailure = judgeValidationAdmissionFailure;
