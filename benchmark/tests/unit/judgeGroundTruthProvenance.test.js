'use strict';

const JudgeGroundTruth = require('../../models/JudgeGroundTruth');

function groundTruth(overrides = {}) {
    return new JudgeGroundTruth({
        name: 'provenance-contract-test',
        category: 'reasoning',
        level: 3,
        prompt: 'opaque prompt',
        response: 'opaque response',
        expert_scores: { overall: 7 },
        expert_rationale: 'independent review evidence',
        provenance_class: 'independent_human_score',
        review_protocol: 'blind_independent',
        ...overrides
    });
}

describe('JudgeGroundTruth qualified provenance contract', () => {
    test('stores an immutable indexed exact judge identity while allowing legacy rows to remain unbound', () => {
        const identityPath = JudgeGroundTruth.schema.path('judge_identity_fingerprint');
        expect(identityPath.options.immutable).toBe(true);
        const legacy = groundTruth({ judge_score_at_review: 7 });
        expect(legacy.validateSync()).toBeUndefined();
        expect(legacy.judge_identity_fingerprint).toBeNull();

        const invalid = groundTruth({ judge_identity_fingerprint: 'not-a-fingerprint' }).validateSync();
        expect(invalid.errors.judge_identity_fingerprint).toBeDefined();

        const identityIndex = JudgeGroundTruth.schema.indexes().find(([keys]) => (
            keys.judge_identity_fingerprint === 1
            && keys.active === 1
            && keys.category === 1
        ));
        expect(identityIndex).toBeDefined();
    });

    test('keeps signed-attestation bytes private and immutable behind unique partial replay indexes', () => {
        for (const path of [
            'human_attestation_fingerprint',
            'human_attestation_issuer_id',
            'human_attestation_key_id',
            'human_attestation_nonce',
            'human_attestation_issued_at',
            'human_attestation_valid_until',
            'human_attestation_source_fingerprint',
            'human_attestation'
        ]) {
            expect(JudgeGroundTruth.schema.path(path).options.immutable).toBe(true);
        }
        expect(JudgeGroundTruth.schema.path('human_attestation').options.select).toBe(false);

        const indexes = JudgeGroundTruth.schema.indexes();
        expect(indexes).toEqual(expect.arrayContaining([
            [
                { human_attestation_fingerprint: 1 },
                expect.objectContaining({
                    name: 'human_attestation_fingerprint_unique',
                    unique: true,
                    partialFilterExpression: { human_attestation_fingerprint: { $type: 'string' } }
                })
            ],
            [
                {
                    human_attestation_issuer_id: 1,
                    human_attestation_key_id: 1,
                    human_attestation_nonce: 1
                },
                expect.objectContaining({ name: 'human_attestation_nonce_unique', unique: true })
            ]
        ]));
    });

    test('excludes any complete or partial attestation marker from legacy visibility', () => {
        const visibility = JudgeGroundTruth.buildLegacyGroundTruthVisibilityFilter();
        expect(visibility.$nor).toEqual(expect.arrayContaining([
            { source: 'attested-human-evidence-v1' },
            { created_by: /^attested:/ },
            { human_attestation_fingerprint: { $ne: null } },
            { human_attestation_issuer_id: { $ne: null } },
            { human_attestation: { $ne: null } }
        ]));
    });

    test('applies legacy visibility to deviation and accuracy summaries', async () => {
        const find = jest.spyOn(JudgeGroundTruth, 'find').mockReturnValue({
            sort: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis()
        });
        JudgeGroundTruth.getHighDeviation();
        expect(find).toHaveBeenCalledWith(expect.objectContaining({
            active: true,
            $nor: expect.arrayContaining([
                { source: 'attested-human-evidence-v1' },
                { human_attestation_fingerprint: { $ne: null } }
            ])
        }));
        find.mockRestore();

        const aggregate = jest.spyOn(JudgeGroundTruth, 'aggregate')
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        const countDocuments = jest.spyOn(JudgeGroundTruth, 'countDocuments').mockResolvedValue(0);
        await JudgeGroundTruth.getAccuracySummary();
        for (const [pipeline] of aggregate.mock.calls) {
            expect(pipeline[0].$match.$nor).toEqual(expect.arrayContaining([
                { source: 'attested-human-evidence-v1' },
                { human_attestation_fingerprint: { $ne: null } }
            ]));
        }
        expect(countDocuments).toHaveBeenCalledWith(expect.objectContaining({
            active: true,
            $nor: expect.any(Array)
        }));
        aggregate.mockRestore();
        countDocuments.mockRestore();
    });

    test.each(['blind_independent', 'blind_double_review'])(
        'accepts independent human evidence produced by %s',
        (reviewProtocol) => {
            expect(groundTruth({ review_protocol: reviewProtocol }).validateSync()).toBeUndefined();
        }
    );

    test('rejects judge-visible evidence mislabeled as independent', () => {
        const error = groundTruth({ review_protocol: 'judge_visible_single_review' }).validateSync();
        expect(error.errors.review_protocol.message).toMatch(/matching blind or adjudicated/);
    });

    test('requires adjudication protocol for adjudicated provenance', () => {
        expect(groundTruth({
            provenance_class: 'adjudicated_human_score',
            review_protocol: 'adjudicated'
        }).validateSync()).toBeUndefined();

        const error = groundTruth({
            provenance_class: 'adjudicated_human_score',
            review_protocol: 'blind_double_review'
        }).validateSync();
        expect(error.errors.review_protocol.message).toMatch(/matching blind or adjudicated/);
    });
});
