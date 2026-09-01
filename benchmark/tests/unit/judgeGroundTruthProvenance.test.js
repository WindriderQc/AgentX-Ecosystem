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
