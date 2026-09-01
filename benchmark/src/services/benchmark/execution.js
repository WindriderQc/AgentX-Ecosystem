/**
 * Benchmark Execution Module
 * Core batch management, orchestration, and progress tracking
 */

const logger = require('../../../config/logger');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkTimelineEntry = require('../../../models/BenchmarkTimelineEntry');
const { JUDGE_CONFIG } = require('../qualityScorer');
const { SCORER_VERSION } = require('../scoring/scorerVersion');
const { normalizeExecutionConfig } = require('./config');
const { seedPrompts } = require('./init');

const { samplePromptsByDepth } = require('./promptSampling');
const { runTest } = require('./testExecution');
const { buildExecutionPlan } = require('./batchPlanner');
const { runBatchOrchestrator, abortActiveBatchRequests } = require('./batchOrchestrator');
const {
    buildIdleCurrentTest,
    deriveTerminalBatchOutcome,
    setBatchPhase: _setBatchPhase
} = require('./batchHelpers');
const { emitBuddyEvent } = require('../../clients/buddyEventClient');
const {
    buildOllamaTarget,
    buildQualityCohortFingerprint,
    normalizeBatchTargets,
    normalizeBenchmarkTarget
} = require('../../../../shared/benchmarkTargetContract');
const { createSpendGrant, resolveHarnessTarget } = require('./harnessBrokerClient');
const { fingerprint } = require('../../../../shared/workerContract');
const {
    assertConfiguredProductManifest,
    buildTrustSourceContext,
    loadCampaignSpec
} = require('./benchmarkTrustCampaignRuntime');

let activeBatchId = null;
let activeHeartbeatInterval = null;
const TRUST_LAUNCH_AUTHORITY = Symbol('benchmark-trust-launch-authority');
const TRUST_CAMPAIGN_SPEC_INDEX_NAME = 'uniq_benchmark_batch_trust_campaign_spec_id';

async function assertTrustCampaignSpecOneShotIndex() {
    let indexes;
    try {
        indexes = await BenchmarkBatch.collection.indexes();
    } catch (error) {
        const unavailable = new Error('strict Benchmark Trust launch cannot verify its one-shot database index');
        unavailable.code = 'BENCHMARK_TRUST_CAMPAIGN_SPEC_INDEX_UNAVAILABLE';
        unavailable.statusCode = 503;
        unavailable.cause = error;
        throw unavailable;
    }
    const index = indexes.find(entry => entry?.name === TRUST_CAMPAIGN_SPEC_INDEX_NAME);
    const partialFilter = index?.partialFilterExpression;
    const partial = partialFilter?.trust_campaign_spec_id;
    if (!index
        || index.unique !== true
        || Object.keys(index.key || {}).length !== 1
        || index.key?.trust_campaign_spec_id !== 1
        || !partialFilter
        || Object.keys(partialFilter).length !== 1
        || Object.keys(partial || {}).length !== 1
        || partial?.$type !== 'string') {
        const missing = new Error('strict Benchmark Trust launch requires the verified unique CampaignSpec index');
        missing.code = 'BENCHMARK_TRUST_CAMPAIGN_SPEC_INDEX_MISSING';
        missing.statusCode = 503;
        throw missing;
    }
    return index;
}

function getActiveBatchId() {
    return activeBatchId;
}

function getActiveHeartbeatInterval() {
    return activeHeartbeatInterval;
}

function clearActiveBatch() {
    if (activeHeartbeatInterval) {
        clearInterval(activeHeartbeatInterval);
        activeHeartbeatInterval = null;
    }
    activeBatchId = null;
}

async function startBatch({
    host,
    models,
    targets = null,
    levels,
    prompt_ids = null,
    run_name,
    judge_config = {},
    execution_config = {},
    tags = [],
    description = '',
    execution_mode = 'latency',
    depth_config = null,
    paid_approval = null,
    campaign_kind = 'model',
    trust_campaign_spec = null,
    trust_runtime_env = process.env,
    trust_launch_authority = null
}) {
    if (trust_campaign_spec && trust_launch_authority !== TRUST_LAUNCH_AUTHORITY) {
        const error = new Error('strict Benchmark Trust campaigns must be loaded through startTrustBatch');
        error.code = 'BENCHMARK_TRUST_LAUNCH_AUTHORITY_REQUIRED';
        error.statusCode = 403;
        throw error;
    }
    if (!levels || !Array.isArray(levels)) {
        throw new Error('levels (array) are required');
    }
    let normalizedTargets = normalizeBatchTargets({ host, models, targets });
    if (campaign_kind === 'model' && normalizedTargets.some((target) => target.mode === 'native_agent')) {
        throw new Error('native_agent targets require campaign_kind native_agent');
    }
    if (campaign_kind === 'native_agent' && normalizedTargets.some((target) => target.mode !== 'native_agent')) {
        throw new Error('native_agent campaigns accept only native_agent targets');
    }
    const defaultHost = normalizedTargets.find((target) => target.executionKind === 'ollama')?.host || 'harness';
    const displayModels = normalizedTargets.map((target) => target.model);
    judge_config = { ...(judge_config || {}), think: false };
    let judgeTarget = judge_config.target
        ? normalizeBenchmarkTarget(judge_config.target, { allowMissingCatalogFingerprint: judge_config.target.executionKind === 'ollama' })
        : buildOllamaTarget(judge_config.host || defaultHost, judge_config.model || JUDGE_CONFIG.model);
    if (judgeTarget.mode === 'native_agent' || !judgeTarget.capabilities.judge) {
        throw new Error('Only direct_model or isolated_model targets may be used as judge');
    }
    if (trust_campaign_spec) {
        assertConfiguredProductManifest(trust_campaign_spec, trust_runtime_env);
        normalizedTargets = await Promise.all(
            normalizedTargets.map(target => resolveHarnessTarget(target, { force: true }))
        );
        judgeTarget = await resolveHarnessTarget(judgeTarget, { force: true });
    }
    judge_config = { ...judge_config, target: judgeTarget, host: judgeTarget.host || `harness:${judgeTarget.harness.name}`, model: judgeTarget.model };

    await seedPrompts();

    const explicitPromptIds = Array.isArray(prompt_ids)
        ? [...new Set(prompt_ids.map(id => String(id)).filter(Boolean))]
        : [];

    let selectedPrompts = [];
    if (explicitPromptIds.length > 0) {
        const docs = await BenchmarkPrompt.find({ _id: { $in: explicitPromptIds } });
        const byId = new Map(docs.map(doc => [doc._id.toString(), doc]));
        const missing = explicitPromptIds.filter(id => !byId.has(id));
        if (missing.length > 0) {
            throw new Error(`Prompt IDs not found: ${missing.join(', ')}`);
        }
        selectedPrompts = explicitPromptIds.map(id => byId.get(id));
    } else {
        selectedPrompts = await BenchmarkPrompt.getByLevels(levels);
    }

    if (explicitPromptIds.length === 0 && depth_config && typeof depth_config === 'object') {
        selectedPrompts = samplePromptsByDepth(selectedPrompts, depth_config);
    }

    if (explicitPromptIds.length === 0) {
        selectedPrompts.sort((a, b) => (a.level || 0) - (b.level || 0));
    }

    if (selectedPrompts.length === 0) {
        throw new Error('No prompts found for selected levels');
    }
    const persistedLevels = explicitPromptIds.length > 0
        ? [...new Set(selectedPrompts
            .map(prompt => Number(prompt.level))
            .filter(level => Number.isSafeInteger(level) && level >= 1 && level <= 5))]
            .sort((left, right) => left - right)
        : [...levels];
    if (persistedLevels.length === 0) {
        throw new Error('Selected prompts require at least one valid level between 1 and 5');
    }

    const { plan, normalizedExecutionConfig } = buildExecutionPlan(
        defaultHost,
        displayModels,
        selectedPrompts,
        { judge_config, execution_config }
    );
    plan.targets = normalizedTargets;

    const repeats = Math.max(1, Math.min(5, Number(normalizedExecutionConfig.repeats) || 1));
    const qualityCohortFingerprint = buildQualityCohortFingerprint({
        prompts: selectedPrompts,
        scorerVersion: SCORER_VERSION,
        judgeTarget,
        executionConfig: normalizedExecutionConfig,
        profileContract: campaign_kind === 'native_agent' ? 'native-agent-v1' : 'isolated-model-v1'
    });
    const batchContractFingerprint = fingerprint({
        schema: 'agentx.benchmark-batch-contract/v1',
        qualityCohortFingerprint,
        targetFingerprints: normalizedTargets.map((target) => target.fingerprint).sort(),
        repeats,
        campaignKind: campaign_kind,
        executionMode: execution_mode || 'latency'
    });
    plan.batch_contract_fingerprint = batchContractFingerprint;
    let batch = new BenchmarkBatch({
        host: defaultHost,
        models: displayModels,
        targets: normalizedTargets,
        campaign_kind,
        levels: persistedLevels,
        prompt_ids: explicitPromptIds,
        judge_config,
        execution_config: normalizedExecutionConfig,
        depth_config: (depth_config && typeof depth_config === 'object') ? depth_config : null,
        run_name: run_name || description || `Batch ${new Date().toLocaleString()}`,
        active_slot: 'benchmark_singleton',
        total_tests: normalizedTargets.length * selectedPrompts.length * repeats,
        plan,
        status: trust_campaign_spec ? 'pending' : 'running',
        started_at: trust_campaign_spec ? null : new Date(),
        tags: Array.isArray(tags) ? tags : [],
        description: typeof description === 'string' ? description : '',
        execution_mode: execution_mode || 'latency',
        quality_cohort_fingerprint: qualityCohortFingerprint,
        batch_contract_fingerprint: batchContractFingerprint,
        trust_campaign_spec_id: trust_campaign_spec?.specId || null
    });

    const spendGrant = await createSpendGrant({
        batchId: batch._id.toString(),
        batchFingerprint: batchContractFingerprint,
        targets: normalizedTargets,
        judgeTarget,
        judgeConfig: judge_config,
        promptCount: selectedPrompts.length,
        repeats,
        executionConfig: normalizedExecutionConfig,
        approval: paid_approval
    });
    batch.spend_grant = spendGrant;

    batch.captureSystemSnapshot();
    try {
        await batch.save();
    } catch (error) {
        if (trust_campaign_spec && error?.code === 11000
            && (error?.keyPattern?.trust_campaign_spec_id || error?.keyValue?.trust_campaign_spec_id)) {
            const consumed = new Error('Benchmark Trust CampaignSpec has already been consumed');
            consumed.code = 'BENCHMARK_TRUST_CAMPAIGN_SPEC_ALREADY_CONSUMED';
            consumed.statusCode = 409;
            throw consumed;
        }
        throw error;
    }
    const batchId = batch._id.toString();
    let trustEvidenceContext = null;
    if (trust_campaign_spec) {
        try {
            trustEvidenceContext = buildTrustSourceContext({
                batch,
                targets: normalizedTargets,
                prompts: selectedPrompts,
                judgeTarget,
                executionConfig: normalizedExecutionConfig,
                spendGrant,
                qualityCohortFingerprint,
                campaignSpec: trust_campaign_spec,
                env: trust_runtime_env
            });
            await BenchmarkBatch.commitAndStartTrustEvidenceBatch(batch._id, trustEvidenceContext);
            batch = await BenchmarkBatch.findById(batch._id).select('+trust_evidence_context');
        } catch (error) {
            await BenchmarkBatch.updateOne({
                _id: batch._id,
                status: 'pending',
                trust_evidence_context: null,
                trust_evidence_committed_at: null
            }, {
                $set: {
                    status: 'failed',
                    failure_reason: 'trust_preregistration_failed',
                    completed_at: new Date(),
                    last_activity_at: new Date()
                },
                $unset: { active_slot: 1 }
            }).catch(() => {});
            throw error;
        }
    }

    if (process.env.NODE_ENV !== 'test') {
        executeBatch(batchId, defaultHost, displayModels, selectedPrompts, {
            targets: normalizedTargets,
            spend_grant: spendGrant,
            quality_cohort_fingerprint: qualityCohortFingerprint,
            batch_contract_fingerprint: batchContractFingerprint,
            judge_config,
            execution_config: normalizedExecutionConfig,
            execution_mode,
            trust_evidence_context: trustEvidenceContext
        }).catch((err) => {
            logger.error('Batch execution failed', { batchId, error: err.message });
        });
    }

    return {
        batch_id: batchId,
        total_tests: batch.total_tests,
        plan,
        ...(trustEvidenceContext ? {
            trust_campaign_spec_id: trust_campaign_spec.specId,
            trust_source_batch_id: batch.trust_batch_id
        } : {})
    };
}

async function startTrustBatch(specId, options = {}) {
    const spec = await loadCampaignSpec(specId, options);
    assertConfiguredProductManifest(spec, options.env || process.env);
    await assertTrustCampaignSpecOneShotIndex();
    return startBatch({
        host: 'harness',
        models: spec.launch.targets.map(target => target.model),
        targets: spec.launch.targets,
        levels: [],
        prompt_ids: spec.launch.promptIds,
        run_name: spec.launch.runName,
        judge_config: {
            target: spec.launch.judgeTarget,
            require_trust_worker_receipt: true,
            temperature: spec.launch.judgeConfig.temperature,
            seed: spec.launch.judgeConfig.seed,
            num_predict: spec.launch.judgeConfig.maxTokens,
            timeout: spec.launch.judgeConfig.timeoutMs,
            max_retries: 0
        },
        execution_config: spec.launch.executionConfig,
        tags: spec.launch.tags,
        description: spec.launch.description,
        execution_mode: spec.launch.executionMode,
        campaign_kind: spec.launch.campaignKind,
        trust_campaign_spec: spec,
        trust_runtime_env: options.env || process.env,
        trust_launch_authority: TRUST_LAUNCH_AUTHORITY
    });
}

async function updateHardwareProfiles(batchId) {
    // Hardware profile updates are handled by the Model Profiler service
    logger.debug('Hardware profile update skipped — use Model Profiler routes', { batchId });
}

async function executeBatch(batchId, defaultHost, models, prompts, options = {}) {
    const judgeConfig = { ...(options.judge_config || {}), think: false };
    const executionMode = options.execution_mode || 'latency';

    const now = new Date();
    const lockTimeoutMs = 10 * 60 * 1000;  // 10 minutes
    const activityTimeoutMs = 5 * 60 * 1000; // 5 minutes
    const lockTimeout = new Date(now - lockTimeoutMs);
    const activityTimeout = new Date(now - activityTimeoutMs);

    const batch = await BenchmarkBatch.findOneAndUpdate(
        {
            _id: batchId,
            $or: [
                { execution_started_at: null },
                {
                    execution_started_at: { $lt: lockTimeout },
                    last_activity_at: { $lt: activityTimeout }
                }
            ]
        },
        {
            $set: {
                execution_started_at: now,
                execution_pid: process.pid,
                last_activity_at: now
            }
        },
        { new: true, select: '+trust_evidence_context' }
    );

    if (!batch) {
        const existingBatch = await BenchmarkBatch.findById(batchId);
        if (!existingBatch) {
            logger.error('Batch not found', { batchId });
        } else {
            logger.warn('Skipping duplicate batch execution - already locked', {
                batchId,
                pid: process.pid,
                lockedBy: existingBatch.execution_pid
            });
        }
        return;
    }

    if (batch.execution_pid && batch.execution_pid !== process.pid) {
        logger.warn('Re-acquiring execution lock for abandoned batch', {
            batchId,
            previousPid: batch.execution_pid,
            pid: process.pid
        });
    }

    logger.info('Batch execution lock acquired', { batchId, pid: process.pid });

    emitBuddyEvent(
        'batch_started',
        'benchmark',
        `Benchmark batch started: ${models.length} models, ${prompts.length} prompts`
    );

    const executionConfig = normalizeExecutionConfig(options.execution_config || batch.execution_config || {});
    const trustEvidenceContext = options.trust_evidence_context || batch.trust_evidence_context || null;
    activeBatchId = batchId;
    let heartbeatInterval = null;

    const stopHeartbeat = () => {
        const interval = heartbeatInterval;
        if (!interval) {
            return;
        }

        clearInterval(interval);
        if (activeHeartbeatInterval === interval) {
            activeHeartbeatInterval = null;
        }
        heartbeatInterval = null;
    };

    const clearActiveState = () => {
        stopHeartbeat();
        if (activeBatchId === batchId) {
            activeBatchId = null;
        }
    };

    const recordBatchTimelineEvent = async (event, data = {}) => {
        try {
            // Separate known schema fields from ad-hoc details
            const { model, host, prompt_id, prompt_level, duration_ms, tokens_per_sec, time_to_first_token_ms, success, error, ...extras } = data;
            const entry = {
                batchId,
                timestamp: new Date(),
                event,
                model: model ?? null,
                host: host ?? null,
                prompt_id: prompt_id ?? null,
                prompt_level: prompt_level ?? null,
                duration_ms: duration_ms ?? null,
                tokens_per_sec: tokens_per_sec ?? null,
                time_to_first_token_ms: time_to_first_token_ms ?? null,
                success: success ?? null,
                error: error ?? null
            };
            if (Object.keys(extras).length > 0) {
                entry.details = extras;
            }
            await BenchmarkTimelineEntry.create(entry);
            await BenchmarkBatch.updateOne(
                { _id: batchId },
                { $set: { last_activity_at: new Date() } }
            );
        } catch (err) {
            logger.debug('Failed to record timeline event', {
                batchId,
                event,
                error: err.message
            });
        }
    };

    const progressFlushThreshold = executionMode === 'throughput' ? 8 : 4;
    const progressFlushIntervalMs = 1500;
    const pendingBatchProgress = {
        completed: 0,
        failed: 0,
        results: [],
        dirtySince: 0
    };

    function queueBatchProgress(resultSummary, { failed = false } = {}) {
        pendingBatchProgress.completed += 1;
        if (failed) {
            pendingBatchProgress.failed += 1;
        }
        pendingBatchProgress.results.push(resultSummary);
        if (!pendingBatchProgress.dirtySince) {
            pendingBatchProgress.dirtySince = Date.now();
        }
    }

    async function flushBatchProgress(force = false) {
        if (pendingBatchProgress.completed === 0 && pendingBatchProgress.results.length === 0) {
            return;
        }

        const ageMs = pendingBatchProgress.dirtySince
            ? (Date.now() - pendingBatchProgress.dirtySince)
            : 0;

        if (!force && pendingBatchProgress.results.length < progressFlushThreshold && ageMs < progressFlushIntervalMs) {
            return;
        }

        const results = pendingBatchProgress.results.slice();
        const completed = pendingBatchProgress.completed;
        const failed = pendingBatchProgress.failed;
        const update = {
            $inc: { completed },
            $set: { last_activity_at: new Date() }
        };

        if (failed > 0) {
            update.$inc.failed = failed;
        }
        if (results.length > 0) {
            update.$push = {
                results: {
                    $each: results,
                    $slice: -1000
                }
            };
        }

        await BenchmarkBatch.updateOne({ _id: batchId }, update);

        pendingBatchProgress.completed = 0;
        pendingBatchProgress.failed = 0;
        pendingBatchProgress.results = [];
        pendingBatchProgress.dirtySince = 0;
    }

    try {
        await recordBatchTimelineEvent('prep_start', {
            model: judgeConfig.model || JUDGE_CONFIG.model,
            success: true
        });

        const setBatchPhase = (phase, detail = null) =>
            _setBatchPhase(BenchmarkBatch, batchId, phase, detail);
        await setBatchPhase('preparing', 'Building host plan and resolving prompts…');

        heartbeatInterval = setInterval(async () => {
            try {
                const heartbeatUpdate = await BenchmarkBatch.updateOne(
                    { _id: batchId, status: { $in: ['running', 'judging', 'completed'] } },
                    { $set: { last_activity_at: new Date() } }
                );
                if ((heartbeatUpdate && heartbeatUpdate.matchedCount) === 0) {
                    stopHeartbeat();
                }
            } catch (err) {
                logger.warn('Heartbeat failed', { batchId, error: err.message });
            }
        }, 10000);
        activeHeartbeatInterval = heartbeatInterval;

        const plannedRepeats = Math.max(1, Math.min(5, Number(executionConfig.repeats) || 1));
        const plannedTotalTests = models.length * prompts.length * plannedRepeats;
        if (plannedTotalTests > 0) {
            batch.total_tests = plannedTotalTests;
            await batch.save();
        }

        const orchestrationOutcome = await runBatchOrchestrator({
            batchId,
            defaultHost,
            models,
            targets: options.targets || batch.targets || [],
            spendGrant: options.spend_grant || batch.spend_grant || null,
            qualityCohortFingerprint: options.quality_cohort_fingerprint || batch.quality_cohort_fingerprint || null,
            batchContractFingerprint: options.batch_contract_fingerprint || batch.batch_contract_fingerprint || null,
            trustEvidenceContext,
            prompts,
            judgeConfig,
            executionConfig,
            executionMode,
            recordBatchTimelineEvent,
            queueBatchProgress,
            flushBatchProgress,
            setBatchPhase,
            handleGracefulStop: clearActiveState
        });

        await flushBatchProgress(true);

        if (orchestrationOutcome?.stopped) {
            return orchestrationOutcome;
        }

        const finalSnapshot = await BenchmarkBatch.findById(batchId, '+trust_evidence_context');
        if (finalSnapshot) {
            const outcome = deriveTerminalBatchOutcome({
                totalTests: finalSnapshot.total_tests,
                completed: finalSnapshot.completed,
                failed: finalSnapshot.failed
            });
            if (finalSnapshot.trust_evidence_context) {
                await finalSnapshot.calculateMetrics();
                const finalBatch = await BenchmarkBatch.finalizeTrustEvidenceBatch(batchId, {
                    status: outcome.status,
                    failureReason: outcome.failureReason || null
                });
                logger.info('Strict Trust batch finalized with immutable evidence', {
                    batchId,
                    status: finalBatch.status,
                    completed: finalBatch.completed,
                    failed: finalBatch.failed
                });
                emitBuddyEvent(
                    'batch_completed',
                    'benchmark',
                    `Benchmark Trust batch done: ${finalBatch.completed || 0} tests, ${finalBatch.failed || 0} failed`
                );
                return finalBatch;
            }
            const completedAt = new Date();
            // Finalization is one conditional transition. A stop that wins
            // before this write cannot be overwritten by a stale document
            // save; a completion that wins first makes a later stop idempotent.
            const finalBatch = await BenchmarkBatch.findOneAndUpdate(
                {
                    _id: batchId,
                    status: { $in: ['pending', 'running', 'judging'] }
                },
                {
                    $set: {
                        status: outcome.status,
                        failure_reason: outcome.failureReason || null,
                        completed_at: completedAt,
                        last_activity_at: completedAt,
                        current_test: buildIdleCurrentTest(),
                        active_slot: null,
                        execution_pid: null
                    }
                },
                { new: true }
            );

            if (!finalBatch) {
                logger.info('Skipped batch finalization because a terminal transition already won', {
                    batchId
                });
                return;
            }

            if (outcome.failureReason === 'zero_cells_executed') {
                logger.error('Batch finalized with zero cells executed — host or model orchestration silently failed (0212 root cause)', {
                    batchId,
                    totalTests: finalBatch.total_tests
                });
            }
            await finalBatch.calculateMetrics();

            logger.info('Batch completed with metrics', {
                batchId,
                total_duration: finalBatch.execution_metrics?.total_duration_ms,
                tests_per_minute: finalBatch.execution_metrics?.tests_per_minute
            });

            const completedTests = finalBatch.completed || 0;
            const failedTests = finalBatch.failed || 0;
            emitBuddyEvent(
                'batch_completed',
                'benchmark',
                `Benchmark batch done: ${completedTests} tests, ${failedTests} failed`
            );

            try {
                await updateHardwareProfiles(batchId);
            } catch (err) {
                logger.warn('Failed to update hardware profiles', {
                    batchId,
                    error: err.message
                });
            }
        }
    } catch (err) {
        await flushBatchProgress(true).catch((flushErr) => {
            logger.warn('Failed to flush pending batch progress after crash', {
                batchId,
                error: flushErr.message
            });
        });

        const failedAt = new Date();
        let crashSnapshot = null;
        try {
            crashSnapshot = await BenchmarkBatch.findById(batchId)
                .select('status +trust_evidence_context +trust_evidence_finalized_at trust_evidence_sealed')
                .lean();
        } catch (_lookupError) {
            crashSnapshot = null;
        }
        let failureTransition;
        if (crashSnapshot?.trust_evidence_context
            && crashSnapshot.trust_evidence_sealed !== true
            && crashSnapshot.trust_evidence_finalized_at == null
            && ['pending', 'running', 'judging'].includes(crashSnapshot.status)) {
            failureTransition = await BenchmarkBatch.finalizeTrustEvidenceBatch(batchId, {
                status: 'failed',
                failureReason: 'execution_crash',
                allowUnstarted: true
            }).then(() => ({ matchedCount: 1 })).catch((persistErr) => {
                logger.error('Failed to preserve strict Trust crash evidence', {
                    batchId,
                    error: persistErr.message
                });
                return null;
            });
        } else {
            failureTransition = await BenchmarkBatch.updateOne(
            {
                _id: batchId,
                status: { $in: ['pending', 'running', 'judging'] }
            },
            {
                $set: {
                    status: 'failed',
                    judge_status: 'failed',
                    completed_at: failedAt,
                    last_activity_at: failedAt,
                    current_test: buildIdleCurrentTest(),
                    active_slot: null,
                    execution_pid: null
                }
            }
            ).catch((persistErr) => {
                logger.error('Failed to persist batch crash state', {
                    batchId,
                    error: persistErr.message
                });
                return null;
            });
        }

        // A concurrent user stop is a successful terminal transition, not a
        // crash. Never overwrite it or emit misleading failure telemetry.
        if (failureTransition && failureTransition.matchedCount === 0) {
            let terminalBatch = null;
            try {
                terminalBatch = await BenchmarkBatch.findById(batchId)
                    .select('status')
                    .lean();
            } catch (_lookupErr) {
                terminalBatch = null;
            }
            if (terminalBatch?.status === 'stopped') {
                logger.info('Suppressed batch crash because user stop won the terminal race', {
                    batchId
                });
                return { stopped: true, cancelled: true };
            }
        }

        logger.error('Batch execution crashed', {
            batchId,
            error: err.message,
            stack: err.stack
        });

        emitBuddyEvent(
            'batch_failed',
            'benchmark',
            `Benchmark batch crashed: ${(err.message || 'unknown').slice(0, 120)}`,
            'high'
        );

        await BenchmarkTimelineEntry.create({
            batchId,
            timestamp: new Date(),
            event: 'execution_crash',
            success: false,
            error: err.message
        }).catch(() => {}); // best-effort

        throw err;
    } finally {
        await flushBatchProgress(true).catch((flushErr) => {
            logger.warn('Failed to flush pending batch progress during cleanup', {
                batchId,
                error: flushErr.message
            });
        });
        clearActiveState();
    }
}

async function stopBatch(batchId) {
    const stoppedAt = new Date();
    const managedLocally = activeBatchId === String(batchId);
    const trustSnapshot = await BenchmarkBatch.findById(batchId)
        .select('status +trust_evidence_context +trust_evidence_finalized_at trust_evidence_sealed')
        .lean();
    if (trustSnapshot?.trust_evidence_context) {
        if (['completed', 'failed', 'stopped', 'interrupted'].includes(trustSnapshot.status)
            || trustSnapshot.trust_evidence_sealed === true
            || trustSnapshot.trust_evidence_finalized_at != null) {
            const existing = await BenchmarkBatch.findById(batchId);
            return { batch: existing, alreadyStopped: trustSnapshot.status === 'stopped', managedLocally };
        }
        const batch = await BenchmarkBatch.finalizeTrustEvidenceBatch(batchId, {
            status: 'stopped',
            failureReason: 'operator_stop',
            allowUnstarted: true
        });
        // A strict run is interrupted only after its terminal evidence state is
        // durable. If finalization fails, the live runner remains authoritative
        // and may continue or be stopped by a later retry.
        abortActiveBatchRequests(batchId);
        // Keep local ownership until executeBatch's finally block confirms
        // every cancelled request has drained and the orchestrator has run its
        // claim teardown. A repeated stop must not release claims early.
        return { batch, alreadyStopped: false, managedLocally };
    }

    // Establish the user stop as durable truth before interrupting work. This
    // small atomic write releases the singleton slot even if authoritative
    // counter reconciliation later fails.
    let batch = await BenchmarkBatch.findOneAndUpdate(
        {
            _id: batchId,
            status: { $in: ['pending', 'running'] }
        },
        {
            $set: {
                status: 'stopped',
                judge_status: 'stopped',
                completed_at: stoppedAt,
                last_activity_at: stoppedAt,
                current_test: buildIdleCurrentTest(),
                active_slot: null,
                execution_pid: null
            }
        },
        { new: true }
    );

    if (!batch) {
        batch = await BenchmarkBatch.findById(batchId);
        if (!batch) {
            throw new Error('Batch not found');
        }
        if (batch.status === 'stopped') {
            // Safe to repeat: already-aborted controllers are ignored.
            abortActiveBatchRequests(batchId);
        }
        return { batch, alreadyStopped: true, managedLocally };
    }

    abortActiveBatchRequests(batchId);

    await BenchmarkTimelineEntry.create({
        batchId,
        timestamp: stoppedAt,
        event: 'stop_requested',
        success: false,
        error: null
    }).catch(() => {});

    try {
        batch = await batch.reconcileFromResults({ status: 'stopped' });
    } catch (err) {
        // The stop intent is already committed. Reconciliation is valuable,
        // but its failure must never resurrect the runner or turn a successful
        // stop into an HTTP 500.
        logger.warn('Batch stopped but authoritative reconciliation failed', {
            batchId,
            error: err.message
        });
    } finally {
        // Catch a request registered between the durable transition and the
        // first abort pass.
        abortActiveBatchRequests(batchId);
    }
    logger.info('Batch stopped by user', { batchId });

    return { batch, alreadyStopped: false, managedLocally };
}

/**
 * Resume a stopped/failed batch from its last checkpoint.
 * Re-uses the original batch config; the orchestrator skips completed pairs.
 */
async function resumeBatch(batchId, options = {}) {
    const batch = await BenchmarkBatch.findById(batchId).select('+spend_grant +trust_evidence_context');
    if (!batch) throw new Error('Batch not found');
    if (batch.trust_evidence_context) {
        const error = new Error('Strict Trust batches are append-only and cannot be resumed; create a new campaign spec');
        error.code = 'BENCHMARK_TRUST_RESUME_FORBIDDEN';
        error.statusCode = 409;
        throw error;
    }
    if (!['stopped', 'failed', 'interrupted'].includes(batch.status)) {
        throw new Error(`Cannot resume batch in status "${batch.status}"`);
    }

    const totalTests = Number(batch.total_tests) || 0;
    const completed = Number(batch.completed) || 0;
    const judgePending = Number(batch.judge_stats?.pending) || 0;
    const checkpointCount = Array.isArray(batch.checkpoint?.completed_pairs)
        ? batch.checkpoint.completed_pairs.length
        : 0;
    const executionRemaining = totalTests > 0
        ? Math.max(0, totalTests - Math.max(completed, checkpointCount)) > 0
        : false;

    if (!executionRemaining && judgePending <= 0) {
        throw new Error('Cannot resume batch with no remaining work');
    }

    // Rebind the judge before calculating any renewed spend ceiling.
    if (options.judgeConfig && typeof options.judgeConfig === 'object') {
        batch.judge_config = {
            ...(batch.judge_config || {}),
            ...options.judgeConfig
        };
    }

    const explicitPromptIds = Array.isArray(batch.prompt_ids)
        ? batch.prompt_ids.map(id => String(id)).filter(Boolean)
        : [];
    let selectedPrompts;
    if (explicitPromptIds.length > 0) {
        const prompts = await BenchmarkPrompt.find({ _id: { $in: explicitPromptIds } });
        const byId = new Map(prompts.map(doc => [doc._id.toString(), doc]));
        selectedPrompts = explicitPromptIds.map(id => byId.get(id)).filter(Boolean);
    } else {
        const prompts = await BenchmarkPrompt.getByLevels(batch.levels);
        selectedPrompts = (batch.depth_config && typeof batch.depth_config === 'object')
            ? samplePromptsByDepth(prompts, batch.depth_config)
            : prompts;
        selectedPrompts.sort((a, b) => (a.level || 0) - (b.level || 0));
    }

    const normalizedTargets = normalizeBatchTargets({
        host: batch.host,
        models: batch.models,
        targets: batch.targets
    });
    const judgeTarget = normalizeBenchmarkTarget(batch.judge_config.target, {
        allowMissingCatalogFingerprint: batch.judge_config.target.executionKind === 'ollama'
    });
    const repeats = Math.max(1, Math.min(5, Number(batch.execution_config?.repeats) || 1));
    const batchContractFingerprint = batch.batch_contract_fingerprint || fingerprint({
        schema: 'agentx.benchmark-batch-contract/v1',
        qualityCohortFingerprint: batch.quality_cohort_fingerprint || null,
        targetFingerprints: normalizedTargets.map((target) => target.fingerprint).sort(),
        repeats,
        campaignKind: batch.campaign_kind || 'model',
        executionMode: batch.execution_mode || 'latency'
    });
    const renewedSpendGrant = await createSpendGrant({
        batchId,
        batchFingerprint: batchContractFingerprint,
        targets: normalizedTargets,
        judgeTarget,
        judgeConfig: batch.judge_config,
        promptCount: selectedPrompts.length,
        repeats,
        executionConfig: batch.execution_config || {},
        approval: options.paidApproval || null
    });

    // Commit the resumed state only after any paid plan has been explicitly
    // approved and signed. A refusal therefore happens before the first call
    // and leaves the stopped batch resumable.
    batch.spend_grant = renewedSpendGrant;
    batch.batch_contract_fingerprint = batchContractFingerprint;
    batch.status = 'running';
    batch.active_slot = 'benchmark_singleton';
    batch.execution_started_at = null;
    batch.execution_pid = null;
    await batch.save();

    if (process.env.NODE_ENV !== 'test') {
        executeBatch(batchId, batch.host, batch.models, selectedPrompts, {
            targets: normalizedTargets,
            spend_grant: renewedSpendGrant,
            quality_cohort_fingerprint: batch.quality_cohort_fingerprint || null,
            batch_contract_fingerprint: batchContractFingerprint,
            judge_config: batch.judge_config || {},
            execution_config: batch.execution_config || {},
            execution_mode: batch.execution_mode || 'latency'
        });
    }

    return { batch_id: batchId, status: 'resumed', checkpoint: batch.checkpoint };
}

module.exports = {
    assertTrustCampaignSpecOneShotIndex,
    runTest,
    startBatch,
    startTrustBatch,
    resumeBatch,
    executeBatch,
    stopBatch,
    getActiveBatchId,
    getActiveHeartbeatInterval,
    clearActiveBatch
};
