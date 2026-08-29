'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

const RESULTS_EXPLORER_EVIDENCE_POLICY = Object.freeze({
    basis: 'timestamp',
    recent_max_age_days: 30,
    aging_max_age_days: 90
});

const EVIDENCE_ERAS = new Set(['recent', 'aging', 'historical', 'undated']);

function normalizeAsOf(asOf) {
    const value = asOf instanceof Date ? asOf : new Date(asOf ?? Date.now());
    return Number.isFinite(value.getTime()) ? value : new Date();
}

function getEvidenceEra(timestamp, asOf = Date.now()) {
    const recordedAt = timestamp instanceof Date ? timestamp : new Date(timestamp);
    if (!timestamp || !Number.isFinite(recordedAt.getTime())) {
        return {
            evidence_era: 'undated',
            evidence_age_days: null,
            evidence_recorded_at: null
        };
    }

    const reference = normalizeAsOf(asOf);
    const elapsedMs = Math.max(0, reference.getTime() - recordedAt.getTime());
    const ageDays = Math.ceil(elapsedMs / DAY_MS);
    const recentCutoff = RESULTS_EXPLORER_EVIDENCE_POLICY.recent_max_age_days * DAY_MS;
    const agingCutoff = RESULTS_EXPLORER_EVIDENCE_POLICY.aging_max_age_days * DAY_MS;

    let era = 'historical';
    if (elapsedMs <= recentCutoff) era = 'recent';
    else if (elapsedMs <= agingCutoff) era = 'aging';

    return {
        evidence_era: era,
        evidence_age_days: ageDays,
        evidence_recorded_at: recordedAt.toISOString()
    };
}

function projectResultsExplorerEvidence(result = {}, asOf = Date.now()) {
    return {
        ...result,
        ...getEvidenceEra(result.timestamp, asOf),
        legacy_scoring: result.composite_formula === 'legacy'
    };
}

function getEvidenceEraFilter(era, asOf = Date.now()) {
    if (!EVIDENCE_ERAS.has(era)) return null;

    const reference = normalizeAsOf(asOf);
    const recentCutoff = new Date(
        reference.getTime() - RESULTS_EXPLORER_EVIDENCE_POLICY.recent_max_age_days * DAY_MS
    );
    const historicalCutoff = new Date(
        reference.getTime() - RESULTS_EXPLORER_EVIDENCE_POLICY.aging_max_age_days * DAY_MS
    );

    if (era === 'recent') return { timestamp: { $gte: recentCutoff } };
    if (era === 'aging') {
        return { timestamp: { $gte: historicalCutoff, $lt: recentCutoff } };
    }
    if (era === 'historical') return { timestamp: { $lt: historicalCutoff } };
    return { $nor: [{ timestamp: { $type: 'date' } }] };
}

function combineMongoFilters(baseFilter = {}, extraFilter = {}) {
    if (!baseFilter || Object.keys(baseFilter).length === 0) return extraFilter;
    if (!extraFilter || Object.keys(extraFilter).length === 0) return baseFilter;
    return { $and: [baseFilter, extraFilter] };
}

module.exports = {
    RESULTS_EXPLORER_EVIDENCE_POLICY,
    EVIDENCE_ERAS,
    getEvidenceEra,
    getEvidenceEraFilter,
    projectResultsExplorerEvidence,
    combineMongoFilters
};
