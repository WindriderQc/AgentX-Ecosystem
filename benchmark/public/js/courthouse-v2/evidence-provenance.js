// Result evidence provenance. This labels existing scoring fields without
// changing score values or aggregation contracts.

const DETERMINISTIC_METHODS = new Set([
    'deterministic',
    'deterministic_fallback',
    'quick',
    'pattern',
    'empty_response',
    'response_contract_failed'
]);

const JUDGE_METHODS = new Set([
    'llm_judge',
    'decomposed',
    'reference',
    'reference_quick',
    'reasoning',
    'hybrid'
]);

export function evidenceProvenance(result = {}) {
    const method = String(result.scoring_method || result.judging_method || '').toLowerCase();
    const hasDeterministic = result.deterministic_score !== null
        && result.deterministic_score !== undefined;
    const hasJudge = result.subjective_score !== null
        && result.subjective_score !== undefined;

    if (hasDeterministic && hasJudge) {
        return {
            kind: 'hybrid',
            label: 'Deterministic + judge evidence',
            description: 'This result combines a deterministic signal with an LLM judge score.',
            judgeScored: true
        };
    }

    if (hasDeterministic || DETERMINISTIC_METHODS.has(method)) {
        return {
            kind: 'deterministic-only',
            label: 'Deterministic-only evidence',
            description: 'This result comes from an exact, format, reference, or rule-based check; no LLM judge score is present.',
            judgeScored: false
        };
    }

    if (hasJudge || JUDGE_METHODS.has(method)
        || (!!result.judge_model && !['pending', 'llm_failed', 'skipped', 'disabled'].includes(method))) {
        return {
            kind: 'judge-scored',
            label: 'Judge-scored evidence',
            description: 'This result includes an LLM judge score.',
            judgeScored: true
        };
    }

    return {
        kind: 'unscored',
        label: 'No score evidence',
        description: method === 'llm_failed'
            ? 'The judge attempt failed, so no judge score is available.'
            : 'No deterministic or judge score is available.',
        judgeScored: false
    };
}

export function evidenceBadge(result = {}, { compact = false } = {}) {
    const provenance = evidenceProvenance(result);
    const label = compact
        ? provenance.kind === 'deterministic-only' ? 'DET'
            : provenance.kind === 'judge-scored' ? 'JUDGE'
            : provenance.kind === 'hybrid' ? 'HYBRID'
            : 'UNSCORED'
        : provenance.label;
    return `<span class="evidence-badge evidence-${provenance.kind}" title="${escapeAttribute(provenance.description)}">${label}</span>`;
}

function escapeAttribute(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
