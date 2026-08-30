const {
    fixtureIdentity,
    assessTrustedCohort,
    selectTrustedCohort
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
        ...overrides
    };
}

describe('Trusted leaderboard evidence cohorts', () => {
    test('admits one recent completed cohort with exact fixture, scorer, artifact and runtime identities', () => {
        const cohort = assessTrustedCohort(exactGroup(), completedBatch(), { asOf: NOW, freshnessDays: 30 });

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
        const cohort = assessTrustedCohort(legacy, completedBatch(), { asOf: NOW, freshnessDays: 30 });

        expect(cohort.eligible).toBe(false);
        expect(cohort.reasons).toEqual(expect.arrayContaining([
            'candidate_identity_missing_or_mixed',
            'scorer_identity_missing_or_mixed',
            'confidence_unknown'
        ]));
    });

    test('rejects stale evidence even when every identity field is populated', () => {
        const cohort = assessTrustedCohort(
            exactGroup({ latestTimestamp: new Date('2026-01-03T12:00:00.000Z') }),
            completedBatch({ completed_at: new Date('2026-01-03T12:00:00.000Z') }),
            { asOf: NOW, freshnessDays: 30 }
        );

        expect(cohort.eligible).toBe(false);
        expect(cohort.reasons).toContain('stale');
    });

    test('rejects a batch when candidates did not run the same fixtures', () => {
        const group = exactGroup();
        group.candidateFixtures = group.candidateFixtures.filter(row => (
            row.model !== 'model-b' || row.name !== 'reasoning-1'
        ));
        const cohort = assessTrustedCohort(group, completedBatch(), { asOf: NOW, freshnessDays: 30 });

        expect(cohort.eligible).toBe(false);
        expect(cohort.reasons).toContain('candidate_fixture_scope_mismatch');
    });

    test('prefers the strongest comparable cohort before recency', () => {
        const oneModel = assessTrustedCohort(
            exactGroup({
                _id: 'new-one-model',
                candidateIdentities: [exactGroup().candidateIdentities[0]],
                candidateFixtures: exactGroup().candidateFixtures.filter(row => row.model === 'model-a')
            }),
            completedBatch({ _id: 'new-one-model', completed_at: new Date('2026-08-30T10:00:00.000Z') }),
            { asOf: NOW, freshnessDays: 30 }
        );
        const twoModels = assessTrustedCohort(exactGroup(), completedBatch(), { asOf: NOW, freshnessDays: 30 });

        expect(selectTrustedCohort([oneModel, twoModels]).batchId).toBe('batch-exact');
    });

    test('prefers broader fixture coverage before raw model count', () => {
        const fixtures = [
            { name: 'coding-1', prompt: 'Write code', category: 'coding', level: 4 },
            { name: 'reasoning-1', prompt: 'Reason', category: 'reasoning', level: 5 },
            { name: 'knowledge-1', prompt: 'Recall', category: 'knowledge', level: 4 }
        ];
        const broader = assessTrustedCohort(
            exactGroup({
                _id: 'broader-one-model',
                rowCount: 3,
                scorerKnownRows: 3,
                confidenceKnownRows: 3,
                candidateIdentities: [exactGroup().candidateIdentities[0]],
                fixtures,
                candidateFixtures: fixtures.map(fixture => ({
                    model: 'model-a',
                    host: 'http://host-a:11434',
                    ...fixture
                }))
            }),
            completedBatch({ _id: 'broader-one-model' }),
            { asOf: NOW, freshnessDays: 30 }
        );
        const narrower = assessTrustedCohort(exactGroup(), completedBatch(), { asOf: NOW, freshnessDays: 30 });

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
});
