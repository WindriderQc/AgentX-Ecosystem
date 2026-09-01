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
