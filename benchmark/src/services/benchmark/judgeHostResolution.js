function resolveJudgeHost(executionHost, judgeConfig = {}) {
    const execHost = String(executionHost || '').trim();
    const explicitHost = String(judgeConfig.host || '').trim();

    if (explicitHost) {
        return {
            judgeHost: explicitHost,
            effectiveJudgeSameHost: explicitHost === execHost,
            resolution: 'explicit'
        };
    }

    return {
        judgeHost: execHost,
        effectiveJudgeSameHost: true,
        resolution: 'execution_host_default'
    };
}

module.exports = {
    resolveJudgeHost
};
