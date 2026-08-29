// Run independent evidence requests without letting one rejection cancel the
// other surfaces. Tasks are functions so synchronous setup errors are settled
// the same way as rejected requests.

export async function settleEvidence(tasks = {}) {
    const entries = Object.entries(tasks);
    const results = await Promise.allSettled(
        entries.map(([, load]) => Promise.resolve().then(() => load()))
    );

    return Object.fromEntries(results.map((result, index) => {
        const name = entries[index][0];
        return [name, result.status === 'fulfilled'
            ? { ok: true, value: result.value, error: null }
            : { ok: false, value: null, error: result.reason }];
    }));
}

export function withRecoverableJudgeSetup(readiness, {
    rosterAvailable = true,
    hostPanels = []
} = {}) {
    const hasSelectableCandidates = rosterAvailable && hostPanels.some(
        (panel) => Array.isArray(panel?.judges) && panel.judges.length > 0
    );
    if (readiness?.ready === true || hasSelectableCandidates) return readiness;

    return {
        ...(readiness || {}),
        setup: {
            ...(readiness?.setup || {}),
            href: '/setup?focus=judge',
            label: 'Open judge setup',
            description: 'Open setup to select an already-installed judge model. No model is downloaded or selected automatically.'
        }
    };
}
