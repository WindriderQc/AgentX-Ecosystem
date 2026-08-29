'use strict';

const {
    RESULTS_EXPLORER_EVIDENCE_POLICY,
    getEvidenceEra,
    getEvidenceEraFilter,
    projectResultsExplorerEvidence,
    combineMongoFilters
} = require('../../src/services/benchmark/resultsExplorerEvidence');

describe('Results Explorer evidence age', () => {
    const asOf = new Date('2026-08-28T12:00:00.000Z');

    test('uses transparent timestamp-only age bands at the documented boundaries', () => {
        expect(RESULTS_EXPLORER_EVIDENCE_POLICY).toMatchObject({
            basis: 'timestamp',
            recent_max_age_days: 30,
            aging_max_age_days: 90
        });
        expect(getEvidenceEra('2026-08-28T11:00:00.000Z', asOf)).toMatchObject({
            evidence_era: 'recent',
            evidence_age_days: 1
        });
        expect(getEvidenceEra('2026-07-29T12:00:00.000Z', asOf).evidence_era).toBe('recent');
        expect(getEvidenceEra('2026-07-29T11:59:59.999Z', asOf).evidence_era).toBe('aging');
        expect(getEvidenceEra('2026-05-30T12:00:00.000Z', asOf).evidence_era).toBe('aging');
        expect(getEvidenceEra('2026-05-30T11:59:59.999Z', asOf).evidence_era).toBe('historical');
    });

    test('keeps missing or invalid dates explicitly undated', () => {
        expect(getEvidenceEra(null, asOf)).toEqual({
            evidence_era: 'undated',
            evidence_age_days: null,
            evidence_recorded_at: null
        });
        expect(getEvidenceEra('not-a-date', asOf).evidence_era).toBe('undated');
    });

    test('claims legacy scoring only when the persisted formula says legacy', () => {
        const timestamp = '2026-01-01T00:00:00.000Z';
        expect(projectResultsExplorerEvidence({ timestamp }, asOf)).toMatchObject({
            evidence_era: 'historical',
            legacy_scoring: false
        });
        expect(projectResultsExplorerEvidence({ timestamp, composite_formula: 'legacy' }, asOf)).toMatchObject({
            evidence_era: 'historical',
            legacy_scoring: true
        });
    });

    test('builds matching Mongo filters without overwriting caller filters', () => {
        const recent = getEvidenceEraFilter('recent', asOf);
        expect(recent.timestamp.$gte).toEqual(new Date('2026-07-29T12:00:00.000Z'));
        expect(combineMongoFilters({ model: 'model-a' }, recent)).toEqual({
            $and: [{ model: 'model-a' }, recent]
        });
        expect(getEvidenceEraFilter('undated', asOf)).toEqual({
            $nor: [{ timestamp: { $type: 'date' } }]
        });
        expect(getEvidenceEraFilter('unsupported', asOf)).toBeNull();
    });
});
