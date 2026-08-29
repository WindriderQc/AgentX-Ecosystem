/**
 * Benchmark Pre-flight Validation
 * ================================
 *
 * Checks to run before starting a benchmark batch:
 * - Target models are loaded and responsive on their hosts
 * - Judge model passes basic connectivity check
 * - Prompt coverage meets minimums per category
 * - No orphaned running batches
 *
 * Used by: batch start API, CI automation
 */

const logger = require('../../../config/logger');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { BENCHMARK_CATEGORIES } = require('../../../config/categories');
const { JUDGE_CONFIG } = require('../qualityScorer');
const { probeJudgeCapability } = require('./judgeModelValidator');
const { benchmarkFetch: fetch } = require('./http');
const { normalizeModelName } = require('./modelMetadata');
const { normalizeHostUrl, getConfiguredHosts } = require('../../helpers/ollamaHostConfig');
const { admitOllamaTargetResolved } = require('../../helpers/ollamaTargetAdmission');
const { readBoundedJson } = require('../../helpers/boundedJsonResponse');
const { getDedicationStatuses } = require('../../clients/coreApiClient');
const { identitiesMatch, resolveArtifactIdentity } = require('../profiler/artifactIdentityService');
const { normalizeJudgeNumCtx } = require('../scoring/judgeRuntimeConfig');
const { normalizeExecutionConfig } = require('./config');
const {
    MIN_THINKING_PROBE_COUNT,
    THINKING_PROFILE_VERSION,
    isThinkingProfileCurrent
} = require('./thinkingPolicy');

const MIN_PROMPTS_PER_CATEGORY = 3;
const WARN_PROMPTS_PER_CATEGORY = 5;
const HOST_CHECK_TIMEOUT_MS = 10000;
const BENCHMARK_TARGET_BLOCKLIST = [
    {
        pattern: /\bdeepcoder\b/i,
        reason: 'Known incompatible with the AgentX benchmark execution path. Use a different execution model.'
    },
    {
        pattern: /(nomic-embed|mxbai-embed|bge-|snowflake-arctic-embed|all-minilm|embedding)/i,
        reason: 'Embedding-only models are not valid benchmark generation targets.'
    }
];

function getBenchmarkTargetBlockReason(model) {
    const normalizedModel = normalizeModelName(model);

    for (const rule of BENCHMARK_TARGET_BLOCKLIST) {
        if (rule.pattern.test(normalizedModel)) {
            return `Model '${normalizedModel}' is not approved for benchmark execution. ${rule.reason}`;
        }
    }

    return null;
}

function readMapLikeEntry(mapLike, key) {
    if (!mapLike || !key) return null;
    if (mapLike instanceof Map) return mapLike.get(key) || null;
    return mapLike[key] || null;
}

function summarizeThinkingPreflight(profile, hostId, normalizedModel, executionConfig = {}) {
    const config = normalizeExecutionConfig(executionConfig || {});
    if (config.think === false) return { warning: null, profile: null };
    const forced = config.think === true;

    const thinkingProfile = readMapLikeEntry(profile?.thinkingProfiles, hostId);
    if (!thinkingProfile) {
        const requested = forced ? 'think=true requested' : 'think=auto selected';
        const action = forced
            ? 'Forced think=true will run, but this should be treated as a diagnostic lane until the model is profiled on this host.'
            : 'Auto will keep thinking off; force true only for diagnostic A/B.';
        return {
            warning: `${requested} for "${normalizedModel}" on '${hostId}', but this model has no host-specific thinking behavior profile. ${action}`,
            profile: null
        };
    }

    const policy = thinkingProfile.recommendedPolicy || 'unknown';
    const channel = thinkingProfile.channel || 'unknown';
    const probeCount = Number(thinkingProfile.probeCount) || 0;
    const profileVersion = Number(thinkingProfile.profileVersion) || 0;
    const probeAttempts = Number(thinkingProfile.probeAttempts) || probeCount;
    const maxProbeNumPredict = Number(thinkingProfile.maxProbeNumPredict) || null;
    const visibleOk = thinkingProfile.visibleFinalAnswerOk === true;
    const requested = forced ? 'think=true' : 'think=auto';
    const budgetBits = [
        `policy=${policy}`,
        `channel=${channel}`,
        `visible_final=${visibleOk}`,
        `version=${profileVersion || 'legacy'}`,
        `probes=${probeCount}`,
        `attempts=${probeAttempts}`
    ];
    if (maxProbeNumPredict) budgetBits.push(`max_predict=${maxProbeNumPredict}`);
    const base = `${requested} profile for "${normalizedModel}" on '${hostId}': ${budgetBits.join(', ')}`;

    if (!isThinkingProfileCurrent(thinkingProfile)) {
        const staleReason = probeCount < MIN_THINKING_PROBE_COUNT
            ? 'Thinking profile was created before the multi-probe behavior matrix'
            : `Thinking profile predates calibrated retry profiling (requires profileVersion >= ${THINKING_PROFILE_VERSION})`;
        const action = forced
            ? 'Forced think=true will run, but rows should be labeled diagnostic and reviewed manually.'
            : 'Auto will keep thinking off until this model is re-profiled.';
        return {
            warning: `${base}. ${staleReason}; ${action}`,
            profile: thinkingProfile
        };
    }

    if (policy === 'disallowed') {
        const action = forced
            ? 'Forced think=true will run despite the failed safety profile; use only for diagnostic A/B and quarantine runaway rows.'
            : 'Auto will keep thinking off.';
        return {
            warning: `${base}. This model previously failed visible-answer safety with think=true; ${action}`,
            profile: thinkingProfile
        };
    }
    if (policy === 'off') {
        const action = forced
            ? 'Forced think=true will run but the profiler saw no observable thinking effect.'
            : 'Auto will keep thinking off.';
        return {
            warning: `${base}. think=true had no observable effect in profiler; ${action}`,
            profile: thinkingProfile
        };
    }
    if (policy === 'metered') {
        const action = forced
            ? 'Forced think=true is aligned with the profile, but rows must still be watched for hidden-token/runaway fields.'
            : 'Auto will enable it and rows must be watched for hidden-token/runaway fields.';
        return {
            warning: `${base}. Thinking is allowed but metered; ${action}`,
            profile: thinkingProfile
        };
    }
    if (policy === 'unknown') {
        const action = forced
            ? 'Forced think=true will run, but results need manual review.'
            : 'Auto will keep thinking off until behavior is known.';
        return {
            warning: `${base}. Thinking behavior is unknown; ${action}`,
            profile: thinkingProfile
        };
    }

    return {
        warning: `${base}. ${forced ? 'Forced think=true is aligned with the profile.' : 'Auto will enable think=true for this model and host.'}`,
        profile: thinkingProfile
    };
}

async function checkBenchmarkTargetEligibility(model, hostUrl, executionConfig = {}) {
    const normalizedModel = normalizeModelName(model);
    const warnings = [];
    let thinkingProfile = null;

    if (!normalizedModel) {
        return {
            ok: false,
            model: normalizedModel,
            source: 'request',
            reason: 'Benchmark target model is required',
            warnings
        };
    }

    const blockedReason = getBenchmarkTargetBlockReason(normalizedModel);
    if (blockedReason) {
        warnings.push(blockedReason);
    }

    // Profile-gate: benchmark must only run against models that have been
    // profiled ON THIS SPECIFIC HOST. Readiness is a per-host Map in the
    // ModelProfile schema (readiness.<hostId>.stage), because the same model
    // can be profiled on some hosts and not others.
    //
    // Exact artifact qualification is mandatory. Infrastructure or registry
    // failures block instead of silently downgrading the benchmark contract.
    try {
        const ModelProfile = require('../../../models/ModelProfile');
        const HostProfile = require('../../../models/HostProfile');

        // Resolve hostUrl → hostId (readiness is keyed by hostId, not URL).
        let hostId = null;
        if (hostUrl) {
            const normalizedHostUrl = normalizeHostUrl(hostUrl);
            const hostDoc = await HostProfile.findOne({ hostUrl: normalizedHostUrl })
                .select('hostId')
                .lean();
            hostId = hostDoc?.hostId || null;
        }

        if (!hostId) {
            return {
                ok: false,
                model: normalizedModel,
                source: 'profile-gate',
                reason: `Host '${hostUrl}' is not registered in Benchmark HostProfile; exact artifact qualification is impossible.`,
                warnings
            };
        }

        const artifact = await resolveArtifactIdentity(normalizedModel, hostId, hostUrl, { refresh: true });
        const profile = await ModelProfile.findOne({ name: artifact.model })
            .select('readiness benchmarkStats capabilities thinkingProfiles')
            .lean();

        // readiness is a Map in schema; .lean() typically returns a plain object,
        // but guard against both shapes for safety.
        const readinessForHost = readMapLikeEntry(profile?.readiness, hostId);
        const stage = readinessForHost?.stage;
        const hasQualifiedDepth = ['standard', 'full'].includes(readinessForHost?.profileDepth);
        const exactProfile = !!readinessForHost
            && hasQualifiedDepth
            && readinessForHost.benchmarkQualified === true
            && readinessForHost.stale !== true
            && identitiesMatch(readinessForHost.artifact, artifact);

        if (!exactProfile) {
            const msg = `Model "${normalizedModel}" has no current benchmark-qualified profile on host '${hostId}' `
                     + `(stage: ${stage || 'missing'}, depth: ${readinessForHost?.profileDepth || 'missing'}, `
                     + `stale: ${readinessForHost?.stale === true}). `
                     + 'Run a standard or full profile for the exact installed tag/digest/runtime before benchmarking.';
            return {
                ok: false,
                model: normalizedModel,
                source: 'profile-gate',
                reason: msg,
                warnings
            };
        }

        if (hostId && hasQualifiedDepth) {
            const thinkingSummary = summarizeThinkingPreflight(profile, hostId, normalizedModel, executionConfig);
            if (thinkingSummary.warning) warnings.push(thinkingSummary.warning);
            thinkingProfile = thinkingSummary.profile;
        }
    } catch (err) {
        return {
            ok: false,
            model: normalizedModel,
            source: 'profile-gate',
            reason: `Exact artifact profile check failed: ${err.message}`,
            warnings
        };
    }

    return {
        ok: true,
        model: normalizedModel,
        source: 'heuristic',
        reason: blockedReason,
        thinking_profile: thinkingProfile,
        warnings
    };
}

/**
 * Check if an Ollama host is responsive and a model is available.
 * @param {string} hostUrl - Ollama host URL
 * @param {string} model - Model to check (optional, just pings /api/tags if null)
 * @returns {Object} { ok, latency_ms, error, models_loaded }
 */
async function checkHostModel(hostUrl, model = null) {
    let normalizedHost;
    try {
        normalizedHost = await admitOllamaTargetResolved(hostUrl, { configuredHosts: getConfiguredHosts() });
    } catch (error) {
        return { ok: false, latency_ms: 0, error: error.message };
    }

    const start = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HOST_CHECK_TIMEOUT_MS);

    try {
        const response = await fetch(`${normalizedHost}/api/tags`, {
            method: 'GET',
            signal: controller.signal,
            redirect: 'manual'
        });

        if (!response.ok) {
            return { ok: false, latency_ms: Date.now() - start, error: `HTTP ${response.status}` };
        }

        const data = await readBoundedJson(response);
        const availableModels = (data.models || []).map((m) => normalizeModelName(m.name || m.model));
        const latency = Date.now() - start;

        if (model) {
            const normalizedModel = normalizeModelName(model);
            const found = availableModels.includes(normalizedModel);
            if (!found) {
                return {
                    ok: false,
                    latency_ms: latency,
                    error: `Model '${normalizedModel}' not found on host`,
                    models_loaded: availableModels.slice(0, 10)
                };
            }
        }

        return { ok: true, latency_ms: latency, models_loaded: availableModels.slice(0, 10) };
    } catch (err) {
        const msg = err.name === 'AbortError'
            ? `Host unreachable (timeout ${HOST_CHECK_TIMEOUT_MS}ms)`
            : err.message;
        return { ok: false, latency_ms: Date.now() - start, error: msg };
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Check prompt coverage across categories and levels.
 * @param {number[]} levels - Which levels will be tested
 * @returns {Object} { ok, categories, warnings, blockers }
 */
function buildPromptAlignmentWarnings(prompts, executionConfig = {}) {
    const config = normalizeExecutionConfig(executionConfig || {});
    const warnings = [];
    const blockers = [];
    const visibleBudgetEnabled = !!(config.include_length_hint || config.answer_contract_mode !== 'off');
    const runtimeCtx = Number(config.force_num_ctx || config.num_ctx) || null;

    if (!visibleBudgetEnabled) {
        warnings.push(
            'No visible response budget is enabled. If a model hits response_max_tokens, the row is a hidden-cap truncation and should not be trusted as a normal quality score.'
        );
    }
    if (runtimeCtx && config.response_max_tokens >= runtimeCtx) {
        warnings.push(
            `response_max_tokens (${config.response_max_tokens}) is greater than or equal to num_ctx (${runtimeCtx}); this leaves no reliable input or hidden-reasoning budget.`
        );
    }
    if (config.think === true) {
        warnings.push(
            'think=true enabled: hidden reasoning shares response_max_tokens with the visible answer. Rows that hit done_reason=length while thinking is present will be marked invalid for automatic quality ranking.'
        );
        if (config.thinking_final_answer_policy === 'off') {
            warnings.push(
                'think=true has no visible-final-answer contract. Hidden thinking will be preserved for audit, but only visible response text is scored.'
            );
        }
    } else if (config.think === 'auto') {
        warnings.push(
            'think=auto enabled: benchmark will use host-specific thinking profiles. Rows resolved to think=true still share response_max_tokens with hidden reasoning and remain subject to runaway quarantine.'
        );
    }

    for (const prompt of prompts || []) {
        const expectedTokens = Math.round(Number(prompt.expected_tokens) || 0);
        if (!expectedTokens) continue;

        if (expectedTokens > config.response_max_tokens) {
            blockers.push(
                `${prompt.name || prompt._id}: expected_tokens (${expectedTokens}) exceeds response_max_tokens (${config.response_max_tokens})`
            );
        } else if (expectedTokens >= Math.floor(config.response_max_tokens * 0.75)) {
            warnings.push(
                `${prompt.name || prompt._id}: expected_tokens (${expectedTokens}) is close to response_max_tokens (${config.response_max_tokens}); increase the cap or tighten the prompt contract.`
            );
        }
    }

    return { warnings, blockers };
}

async function checkPromptCoverage(levels = [1, 2, 3, 4, 5], promptIds = null, executionConfig = {}) {
    const explicitPromptIds = Array.isArray(promptIds)
        ? [...new Set(promptIds.map(id => String(id)).filter(Boolean))]
        : [];

    if (explicitPromptIds.length > 0) {
        const selectedPrompts = await BenchmarkPrompt.find({ _id: { $in: explicitPromptIds } })
            .select('_id name category level expected_tokens output_contract judge_criteria')
            .lean();
        const foundIds = new Set(selectedPrompts.map(p => String(p._id)));
        const missingIds = explicitPromptIds.filter(id => !foundIds.has(id));
        const countsByCategory = {};
        for (const prompt of selectedPrompts) {
            countsByCategory[prompt.category] = (countsByCategory[prompt.category] || 0) + 1;
        }

        const categories = {};
        for (const [cat, count] of Object.entries(countsByCategory)) {
            const categoryMeta = BENCHMARK_CATEGORIES[cat] || null;
            categories[cat] = {
                count,
                label: categoryMeta?.label || cat
            };
        }

        const alignment = buildPromptAlignmentWarnings(selectedPrompts, executionConfig);
        const blockers = [...alignment.blockers];
        if (selectedPrompts.length === 0) {
            blockers.push('No benchmark prompts found for selected prompt_ids');
        }
        for (const id of missingIds) {
            blockers.push(`Prompt id not found: ${id}`);
        }

        return {
            ok: blockers.length === 0,
            totalPrompts: selectedPrompts.length,
            selectedPromptIds: explicitPromptIds,
            categories,
            warnings: alignment.warnings,
            blockers
        };
    }

    const prompts = await BenchmarkPrompt.aggregate([
        { $match: { level: { $in: levels } } },
        {
            $group: {
                _id: '$category',
                count: { $sum: 1 },
                max_expected_tokens: { $max: '$expected_tokens' }
            }
        }
    ]);

    const countsByCategory = {};
    for (const p of prompts) {
        countsByCategory[p._id] = p.count;
    }

    const warnings = [];
    const blockers = [];
    const categories = {};

    for (const [cat, count] of Object.entries(countsByCategory)) {
        const categoryMeta = BENCHMARK_CATEGORIES[cat] || null;
        categories[cat] = {
            count,
            label: categoryMeta?.label || cat
        };

        if (count < MIN_PROMPTS_PER_CATEGORY) {
            warnings.push(`${cat}: ${count} prompt(s) at selected levels (recommended ${MIN_PROMPTS_PER_CATEGORY}+)`);
        } else if (count < WARN_PROMPTS_PER_CATEGORY) {
            warnings.push(`${cat}: ${count} prompt(s) at selected levels (recommended ${WARN_PROMPTS_PER_CATEGORY}+)`);
        }
    }

    if (prompts.length === 0) {
        blockers.push(`No benchmark prompts found for selected levels: ${levels.join(', ')}`);
    }

    const maxExpectedTokens = prompts.reduce((max, p) => Math.max(max, Number(p.max_expected_tokens) || 0), 0);
    const alignment = buildPromptAlignmentWarnings(
        maxExpectedTokens > 0 ? [{ name: `selected levels ${levels.join(',')}`, expected_tokens: maxExpectedTokens }] : [],
        executionConfig
    );
    warnings.push(...alignment.warnings);
    blockers.push(...alignment.blockers);

    return {
        ok: blockers.length === 0,
        totalPrompts: prompts.reduce((sum, p) => sum + p.count, 0),
        categories,
        warnings,
        blockers
    };
}

async function checkJudgeConfiguration(judgeConfig = {}) {
    const host = normalizeHostUrl(judgeConfig.host || JUDGE_CONFIG.host);
    const model = normalizeModelName(judgeConfig.model || JUDGE_CONFIG.model);

    if (!host || !model) {
        return {
            ok: false, host, model,
            warnings: [],
            blockers: ['Judge host and model are required']
        };
    }

    const warnings = [];
    const blockers = [];

    const requestedNumCtx = normalizeJudgeNumCtx(judgeConfig.num_ctx ?? JUDGE_CONFIG.num_ctx);
    const numCtxSource = requestedNumCtx ? 'explicit' : 'modelfile';
    const numCtxAuthoritative = requestedNumCtx != null;

    // Check host reachability and model availability
    const hostCheck = await checkHostModel(host, model);
    if (!hostCheck.ok) {
        blockers.push(`Judge: ${hostCheck.error}`);
        return { ok: false, host, model, warnings, blockers };
    }

    // Probe model capabilities (context window)
    const probe = await probeJudgeCapability(host, model);
    let modelContextLength = null;
    if (probe.ok && probe.context_length) {
        modelContextLength = probe.context_length;
        if (requestedNumCtx && requestedNumCtx > modelContextLength) {
            warnings.push(
                `Configured judge num_ctx (${requestedNumCtx}) exceeds model's native context window (${modelContextLength}). ` +
                `Ollama will still run but quality may degrade beyond the native limit.`
            );
        }
    }

    return {
        ok: blockers.length === 0,
        host,
        model,
        requested_num_ctx: requestedNumCtx,
        num_ctx_source: numCtxSource,
        num_ctx_authoritative: numCtxAuthoritative,
        model_context_length: modelContextLength,
        parameter_size: probe.parameter_size || null,
        latency_ms: hostCheck.latency_ms,
        warnings,
        blockers
    };
}

/**
 * Check for orphaned running batches.
 * @returns {Object} { ok, orphanedBatches }
 */
async function checkOrphanedBatches() {
    const running = await BenchmarkBatch.find({
        status: { $in: ['running', 'judging'] }
    }).select('_id status started_at last_activity_at').lean();

    const now = Date.now();
    const orphaned = running.filter(b => {
        const lastActivity = b.last_activity_at
            ? new Date(b.last_activity_at).getTime()
            : b.started_at ? new Date(b.started_at).getTime() : now;
        return (now - lastActivity) > 300000; // 5 minutes inactive
    });

    return {
        ok: orphaned.length === 0,
        activeBatches: running.length,
        orphanedBatches: orphaned.map(b => ({
            id: b._id,
            status: b.status,
            started_at: b.started_at
        }))
    };
}

/**
 * Check if any execution hosts have GPU-dedicated models.
 * Non-blocking — dedication is informational, not a blocker.
 * @param {Array<{host, model}>} targets
 * @returns {Object} { ok, affectedHosts, warnings }
 */
async function checkDedication(targets) {
    const affectedHosts = [];
    const warnings = [];

    try {
        const statuses = await getDedicationStatuses();
        const execHosts = [...new Set(targets.map(t => t.host?.replace(/\/+$/, '')))];

        for (const hostUrl of execHosts) {
            const match = statuses.find(s => s.host?.replace(/\/+$/, '') === hostUrl);
            if (!match?.pinnedModels?.length) continue;

            const pinnedModels = match.pinnedModels
                .map(p => normalizeModelName(p?.model || p?.name || p?.modelName || p))
                .filter(Boolean);
            if (!pinnedModels.length) continue;

            const batchModels = targets.filter(t => t.host?.replace(/\/+$/, '') === hostUrl).map(t => t.model);
            const nonPinned = batchModels.filter(m => !pinnedModels.some(p => normalizeModelName(p) === normalizeModelName(m)));

            if (nonPinned.length > 0) {
                affectedHosts.push({
                    host: hostUrl,
                    pinnedModels,
                    nonPinnedBatchModels: nonPinned,
                    state: match.state
                });
                warnings.push(
                    `Host ${hostUrl} has pinned model(s): ${pinnedModels.join(', ')}. ` +
                    `Pinned models will be temporarily unloaded during the batch and automatically restored after completion.`
                );
            }
        }
    } catch (err) {
        logger.debug('Dedication check skipped — core unreachable', { error: err.message });
    }

    return { ok: true, affectedHosts, warnings };
}

/**
 * Run all pre-flight checks.
 * @param {Object} options
 * @param {Array<{host, model}>} options.targets - Models to check
 * @param {Object} options.judgeConfig - Judge configuration (host, model)
 * @param {number[]} options.levels - Prompt levels to test
 * @returns {Object} Full pre-flight report
 */
async function runPreflight(options = {}) {
    const { targets = [], judgeConfig = {}, levels = [1, 2, 3, 4, 5], promptIds = null, prompt_ids = null, executionConfig = {} } = options;
    const uniqueTargets = [...new Map(
        (targets || [])
            .map((target) => ({
                host: normalizeHostUrl(target?.host),
                model: normalizeModelName(target?.model)
            }))
            .filter((target) => target.host && target.model)
            .map((target) => [`${target.host}@@${target.model}`, target])
    ).values()];

    const checks = {
        hosts: [],
        judge: null,
        prompts: null,
        batches: null
    };

    // Run all checks in parallel
    const hostChecks = uniqueTargets.map(async (t) => {
        const [hostResult, eligibilityResult] = await Promise.all([
            checkHostModel(t.host, t.model),
            checkBenchmarkTargetEligibility(t.model, t.host, executionConfig)
        ]);

        return {
            ...t,
            ...hostResult,
            ok: hostResult.ok && eligibilityResult.ok,
            host_ok: hostResult.ok,
            benchmark_eligible: !eligibilityResult.reason,
            benchmark_eligibility_source: eligibilityResult.source,
            benchmark_blocked_reason: eligibilityResult.reason,
            thinking_profile: eligibilityResult.thinking_profile || null,
            warnings: eligibilityResult.warnings,
            error: hostResult.error || null
        };
    });

    const [hostResults, promptResult, batchResult, dedicationResult] = await Promise.all([
        Promise.all(hostChecks),
        checkPromptCoverage(levels, promptIds || prompt_ids, executionConfig),
        checkOrphanedBatches(),
        checkDedication(uniqueTargets)
    ]);
    const judgeResult = await checkJudgeConfiguration(judgeConfig);

    checks.hosts = hostResults;
    checks.judge = judgeResult;
    checks.prompts = promptResult;
    checks.batches = batchResult;
    checks.dedication = dedicationResult;

    const allHostsOk = checks.hosts.every(h => h.ok);
    const judgeOk = checks.judge && checks.judge.ok;
    const promptsOk = checks.prompts.ok;
    const batchesOk = checks.batches.ok;

    const ready = allHostsOk && judgeOk && promptsOk && batchesOk;

    const issues = [];
    const warnings = [];
    if (!allHostsOk) {
        const failedHosts = checks.hosts.filter(h => !h.host_ok);
        if (failedHosts.length > 0) {
            issues.push(`${failedHosts.length} host(s) unreachable or missing models`);
        }
    }
    if (!judgeOk) issues.push(...checks.judge.blockers);
    if (!promptsOk) issues.push(...checks.prompts.blockers);
    if (!batchesOk) issues.push(`${checks.batches.orphanedBatches.length} orphaned batch(es) detected`);
    if (dedicationResult.affectedHosts.length > 0) {
        warnings.push(...dedicationResult.warnings);
    }

    logger.info('Pre-flight check completed', { ready, issues, warnings });

    return {
        ready,
        issues,
        warnings,
        checks
    };
}

module.exports = {
    MIN_PROMPTS_PER_CATEGORY,
    WARN_PROMPTS_PER_CATEGORY,
    checkHostModel,
    checkPromptCoverage,
    checkJudgeConfiguration,
    checkOrphanedBatches,
    runPreflight
};
