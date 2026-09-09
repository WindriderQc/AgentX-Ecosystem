'use strict';

const { resolveJudgeHost } = require('./judgeHostResolution');

// A batch's admission intent is immutable. Creation, execution and resume
// include its judge from the start, even when only some targets remain pending.
function batchAdmissionScope(targets, judgeConfig = {}) {
    const hosts = (targets || []).map(target => target.host).filter(Boolean);
    const externalJudge = judgeConfig.target?.executionKind
        && judgeConfig.target.executionKind !== 'ollama';
    const judgeHosts = externalJudge ? [] : (hosts.length ? hosts : [''])
        .map(host => resolveJudgeHost(host, judgeConfig).judgeHost).filter(Boolean);
    return {
        hosts: [...new Set([...hosts, ...judgeHosts])],
        kind: externalJudge || (targets || []).some(target => target.executionKind !== 'ollama')
            ? 'benchmark-cloud' : 'benchmark'
    };
}

module.exports = { batchAdmissionScope };
