// Shared browser state for the single server-authored judge readiness contract.

let currentReadiness = null;

export function setJudgeReadiness(readiness) {
    currentReadiness = readiness && typeof readiness === 'object' ? readiness : null;
    return currentReadiness;
}

export function getJudgeReadiness() {
    return currentReadiness;
}

export function isJudgeReady() {
    return currentReadiness?.ready === true;
}

export function judgeBlockedReason() {
    if (currentReadiness?.summary) return currentReadiness.summary;
    return 'No selected, reachable judge is ready.';
}

if (typeof document !== 'undefined') {
    document.addEventListener('judge-readiness-changed', (event) => {
        setJudgeReadiness(event.detail);
    });
}
