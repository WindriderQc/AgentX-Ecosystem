const { normalizeHostUrl } = require('../../helpers/ollamaHostConfig');

const HARD_BENCHMARK_MIN_LEVEL = 4;
const HARD_BENCHMARK_DEFAULT_RULE = undefined;

function includesHardBenchmarkLevel(levels) {
    if (!Array.isArray(levels)) return false;
    return levels.some((level) => Number(level) >= HARD_BENCHMARK_MIN_LEVEL);
}

function resolveBatchMultiJudgeInput(levels, requestedMultiJudge) {
    if (requestedMultiJudge !== undefined) {
        return requestedMultiJudge;
    }
    return HARD_BENCHMARK_DEFAULT_RULE;
}

function filterJudgeDefaultsForExecutionHost(hostDefaults, executionHost) {
    const normalizedExecutionHost = normalizeHostUrl(executionHost);
    const filtered = {};

    for (const [host, model] of Object.entries(hostDefaults || {})) {
        if (!host || !model) continue;
        if (normalizeHostUrl(host) === normalizedExecutionHost) continue;
        filtered[host] = model;
    }

    return filtered;
}

module.exports = {
    HARD_BENCHMARK_MIN_LEVEL,
    HARD_BENCHMARK_DEFAULT_RULE,
    includesHardBenchmarkLevel,
    resolveBatchMultiJudgeInput,
    filterJudgeDefaultsForExecutionHost
};
