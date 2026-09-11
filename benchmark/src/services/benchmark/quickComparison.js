'use strict';

const { normalizeHostUrl, getConfiguredHosts } = require('../../helpers/ollamaHostConfig');
const { normalizeModelTag } = require('../../../../shared/modelNames');
const { getProfilePerformanceBaseline } = require('./performanceBaseline');
const { resolveReadyJudgeTarget } = require('./judgeReadiness');
const { resolveStandaloneCampaignInferenceContracts } = require('./inferenceContractSnapshot');

function invalid(message) {
    return Object.assign(new Error(message), { status: 400 });
}

// Validate the small preset through the same inference contract used at execution.
// This reads evidence and inventories only; the normal launch still revalidates it.
async function prepareQuickComparison({ host, models, judge_config = {} } = {}) {
    if (typeof host !== 'string' || !Array.isArray(models) || models.length !== 2
        || models.some(model => typeof model !== 'string' || !model.trim())) {
        throw invalid('Choose exactly two prepared local models on one host.');
    }
    const hostUrl = normalizeHostUrl(host);
    const names = models.map(normalizeModelTag);
    if (new Set(names).size !== 2) throw invalid('Choose two different models.');
    if (!getConfiguredHosts().some(entry => normalizeHostUrl(entry.url) === hostUrl)) {
        throw invalid('Choose a configured execution host.');
    }
    if (typeof judge_config?.model !== 'string' || !judge_config.model.trim()
        || typeof judge_config?.host !== 'string' || !judge_config.host.trim()) {
        throw invalid('Choose an installed judge model and host.');
    }

    const measurements = await Promise.all(names.map(async model => {
        const baseline = await getProfilePerformanceBaseline(model, hostUrl);
        if (!baseline || !Number.isInteger(baseline.numCtx) || baseline.numCtx < 512) {
            throw invalid(`${model} needs a current Standard or Full profile on this host. Open Prepare models, finish its profile, then try again.`);
        }
        return { model, context: baseline.numCtx };
    }));
    // A performance measurement can use a larger context than the verified input
    // range. Basic comparison measures speed itself and needs only a small window.
    const context = Math.min(8192, ...measurements.map(entry => entry.context));
    const executionConfig = {
        force_num_ctx: context,
        response_max_tokens: 512,
        response_max_tokens_source: 'caller',
        warmup_timeout_cold: 300000,
        repeats: 1,
        think: false,
        response_mode: 'final_only'
    };
    await resolveStandaloneCampaignInferenceContracts({
        hostGroups: new Map([[hostUrl, names]]),
        executionConfig
    });
    const judge = await resolveReadyJudgeTarget({ host: judge_config.host, model: judge_config.model });
    if (!judge.ready) throw invalid(judge.error || 'The selected judge is unavailable. Check its setup and try again.');
    const judgeIsContender = normalizeHostUrl(judge.target.host) === hostUrl
        && names.includes(normalizeModelTag(judge.target.model));

    return {
        levels: [1],
        depth_config: { 1: 'light', 2: 'off', 3: 'off', 4: 'off', 5: 'off' },
        judge_config: { num_ctx: judgeIsContender ? context : null },
        execution_config: executionConfig,
        measurements,
        summary: `Basic test · one prompt per category · 512 response tokens. Both models will use ${context.toLocaleString('en-US')} verified context tokens with thinking off. Speed is measured during this run.`,
        warning: judgeIsContender
            ? 'Your judge is also a contender; its scores are not an independent assessment.'
            : null
    };
}

module.exports = { prepareQuickComparison };
