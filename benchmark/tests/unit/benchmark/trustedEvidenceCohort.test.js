const {
    fixtureIdentity,
    assessTrustedCohort,
    selectTrustedCohort,
    buildConsumerTrustVerdict
} = require('../../../src/services/benchmark/trustedEvidenceCohort');

const NOW = new Date('2026-08-30T12:00:00.000Z');

function exactGroup(overrides = {}) {
    const fixtures = [
        { name: 'coding-1', prompt: 'Write code', category: 'coding', level: 4 },
        { name: 'reasoning-1', prompt: 'Reason', category: 'reasoning', level: 5 }
    ];
    const candidateFixtures = ['model-a', 'model-b'].flatMap(model => fixtures.map(fixture => ({
        model,
        host: model === 'model-a' ? 'http://host-a:11434' : 'http://host-b:11434',
        ...fixture
    })));
    return {
        _id: 'batch-exact',
        rowCount: 4,
        latestTimestamp: new Date('2026-08-29T12:00:00.000Z'),
        scorerVersions: ['scorer-v3'],
        scorerKnownRows: 4,
        confidenceKnownRows: 4,
        judgeKnownRows: 4,
        judgeTargets: [{ model: 'judge:14b', host: 'http://judge:11434' }],
        candidateIdentities: [
            {
                model: 'model-a', host: 'http://host-a:11434',
                modelDigest: 'sha256:a', artifactDigest: 'sha256:a', runtimeFingerprint: 'runtime-a'
            },
            {
                model: 'model-b', host: 'http://host-b:11434',
                modelDigest: 'sha256:b', artifactDigest: 'sha256:b', runtimeFingerprint: 'runtime-b'
            }
        ],
        fixtures,
        candidateFixtures,
        ...overrides
    };
}

function completedBatch(overrides = {}) {
    return {
        _id: 'batch-exact',
        status: 'completed',
        completed_at: new Date('2026-08-29T12:00:00.000Z'),
        total_tests: 4,
        completed: 4,
        failed: 0,
        ...overrides
    };
}

function assessCohort(group, batch = completedBatch(), options = {}) {
    return assessTrustedCohort(group, batch, {
        asOf: NOW,
        freshnessDays: 30,
        inventory: {
            totalRows: group.rowCount,
            excludedRows: 0,
            reviewRows: 0,
            failedRows: 0,
            unscoredRows: 0
        },
        ...options
    });
}

describe('Trusted leaderboard evidence cohorts', () => {
    test('admits one recent completed cohort with exact fixture, scorer, artifact and runtime identities', () => {
        const cohort = assessCohort(exactGroup(), completedBatch());

        expect(cohort.eligible).toBe(true);
        expect(cohort.modelCount).toBe(2);
        expect(cohort.fixtureFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(cohort.scorerFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(cohort.evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    });

    test('keeps legacy rows inspectable elsewhere but rejects them from Trusted when exact identity is absent', () => {
        const legacy = exactGroup({
            candidateIdentities: [{
                model: 'legacy-model', host: 'http://old-host:11434',
                modelDigest: null, artifactDigest: null, runtimeFingerprint: null
            }],
            scorerVersions: [null],
            scorerKnownRows: 0,
            confidenceKnownRows: 0
        });
        const cohort = assessCohort(legacy, completedBatch());

        expect(cohort.eligible).toBe(false);
        expect(cohort.reasons).toEqual(expect.arrayContaining([
            'candidate_identity_missing_or_mixed',
            'scorer_identity_missing_or_mixed',
            'confidence_unknown'
        ]));
    });

    test('rejects stale evidence even when every identity field is populated', () => {
        const cohort = assessCohort(
            exactGroup({ latestTimestamp: new Date('2026-01-03T12:00:00.000Z') }),
            completedBatch({ completed_at: new Date('2026-01-03T12:00:00.000Z') }),
            { asOf: NOW, freshnessDays: 30 }
        );

        expect(cohort.eligible).toBe(false);
        expect(cohort.reasons).toContain('stale');
    });

    test('rejects a cohort when excluded or filtered rows are hidden from the trusted query', () => {
        const cohort = assessCohort(exactGroup(), completedBatch(), {
            asOf: NOW,
            freshnessDays: 30,
            inventory: {
                totalRows: 5,
                excludedRows: 1,
                failedRows: 0,
                unscoredRows: 0
            }
        });

        expect(cohort.eligible).toBe(false);
        expect(cohort.reasons).toEqual(expect.arrayContaining(['excluded_rows', 'partial_scope']));
    });

    test('rejects a cohort while any row is pending human review', () => {
        const cohort = assessCohort(exactGroup({ rowCount: 3 }), completedBatch(), {
            inventory: {
                totalRows: 4,
                excludedRows: 0,
                reviewRows: 1,
                failedRows: 0,
                unscoredRows: 0
            }
        });

        expect(cohort.eligible).toBe(false);
        expect(cohort.reasons).toEqual(expect.arrayContaining(['review_pending_rows', 'partial_scope']));
    });

    test('rejects a batch when candidates did not run the same fixtures', () => {
        const group = exactGroup();
        group.candidateFixtures = group.candidateFixtures.filter(row => (
            row.model !== 'model-b' || row.name !== 'reasoning-1'
        ));
        const cohort = assessCohort(group, completedBatch());

        expect(cohort.eligible).toBe(false);
        expect(cohort.reasons).toContain('candidate_fixture_scope_mismatch');
    });

    test.each([
        ['two judge targets', {
            judgeKnownRows: 4,
            judgeTargets: [
                { model: 'judge-a:14b', host: 'http://judge-a:11434' },
                { model: 'judge-b:14b', host: 'http://judge-b:11434' }
            ]
        }],
        ['a row without a complete judge identity', {
            judgeKnownRows: 3,
            judgeTargets: [{ model: 'judge:14b', host: 'http://judge:11434' }]
        }]
    ])('rejects %s from a Phase 0 trusted cohort', (_label, overrides) => {
        const cohort = assessCohort(exactGroup(overrides), completedBatch());

        expect(cohort.eligible).toBe(false);
        expect(cohort.reasons).toContain('judge_identity_missing_or_mixed');
        expect(cohort.scorerFingerprint).toBeNull();
    });

    test('rejects completed status when batch counters are not exactly complete and failure-free', () => {
        const cohort = assessCohort(
            exactGroup(),
            completedBatch({ completed: 3, failed: 1 })
        );

        expect(cohort.eligible).toBe(false);
        expect(cohort.reasons).toContain('batch_counts_incomplete');
    });

    test('rejects a planned cell that never produced a result document', () => {
        const group = exactGroup({
            rowCount: 3,
            scorerKnownRows: 3,
            confidenceKnownRows: 3,
            judgeKnownRows: 3
        });
        const cohort = assessCohort(group, completedBatch(), {
            inventory: {
                totalRows: 3,
                excludedRows: 0,
                failedRows: 0,
                unscoredRows: 0
            }
        });

        expect(cohort.eligible).toBe(false);
        expect(cohort.reasons).toContain('batch_result_count_mismatch');
    });

    test('prefers the strongest comparable cohort before recency', () => {
        const oneModel = assessCohort(
            exactGroup({
                _id: 'new-one-model',
                candidateIdentities: [exactGroup().candidateIdentities[0]],
                candidateFixtures: exactGroup().candidateFixtures.filter(row => row.model === 'model-a')
            }),
            completedBatch({ _id: 'new-one-model', completed_at: new Date('2026-08-30T10:00:00.000Z') }),
            { asOf: NOW, freshnessDays: 30 }
        );
        const twoModels = assessCohort(exactGroup(), completedBatch());

        expect(selectTrustedCohort([oneModel, twoModels]).batchId).toBe('batch-exact');
    });

    test('prefers broader fixture coverage before raw model count', () => {
        const fixtures = [
            { name: 'coding-1', prompt: 'Write code', category: 'coding', level: 4 },
            { name: 'reasoning-1', prompt: 'Reason', category: 'reasoning', level: 5 },
            { name: 'knowledge-1', prompt: 'Recall', category: 'knowledge', level: 4 }
        ];
        const broader = assessCohort(
            exactGroup({
                _id: 'broader-one-model',
                rowCount: 3,
                scorerKnownRows: 3,
                confidenceKnownRows: 3,
                judgeKnownRows: 3,
                candidateIdentities: [exactGroup().candidateIdentities[0]],
                fixtures,
                candidateFixtures: fixtures.map(fixture => ({
                    model: 'model-a',
                    host: 'http://host-a:11434',
                    ...fixture
                }))
            }),
            completedBatch({ _id: 'broader-one-model', total_tests: 3, completed: 3 }),
            { asOf: NOW, freshnessDays: 30 }
        );
        const narrower = assessCohort(exactGroup(), completedBatch());

        expect(selectTrustedCohort([narrower, broader]).batchId).toBe('broader-one-model');
    });

    test('fixture digest changes when prompt content changes', () => {
        const first = fixtureIdentity(exactGroup().fixtures);
        const second = fixtureIdentity([
            { ...exactGroup().fixtures[0], prompt: 'Write different code' },
            exactGroup().fixtures[1]
        ]);
        expect(first.fingerprint).not.toBe(second.fingerprint);
    });

    test.each([
        ['exploratory', null, null, 'exploratory'],
        ['trusted', { selected: null, excludedBatchCount: 1, exclusionReasons: { stale: 1 } }, false, 'stale'],
        ['trusted', { selected: null, excludedBatchCount: 1, exclusionReasons: { stale: 1, candidate_identity_missing_or_mixed: 1 } }, false, 'inconclusive'],
        ['trusted', { selected: null, excludedBatchCount: 1, exclusionReasons: { candidate_identity_missing_or_mixed: 1 } }, false, 'inconclusive'],
        ['trusted', { selected: { evidenceFingerprint: 'abc', completedAt: NOW.toISOString() }, exclusionReasons: {} }, false, 'inconclusive'],
        ['trusted', { selected: { evidenceFingerprint: 'abc', completedAt: NOW.toISOString() }, exclusionReasons: {} }, true, 'trusted']
    ])('returns an explicit %s consumer verdict as %s evidence', (trustScope, cohortResolution, scopeComplete, state) => {
        const verdict = buildConsumerTrustVerdict({
            trustScope,
            cohortResolution,
            scopeComplete,
            rows: [{ model: 'model-a', host: 'host-a', generalistScore: 82 }]
        });

        expect(verdict).toMatchObject({
            contract: 'agentx.benchmark-consumer-trust/v1',
            state,
            qualified: false,
            highConfidenceAllowed: false,
            qualifiedWinner: null
        });
    });
});
