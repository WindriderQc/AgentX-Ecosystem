jest.mock('../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

jest.mock('../../models/BenchmarkResult', () => ({
    find: jest.fn()
}));

const BenchmarkResult = require('../../models/BenchmarkResult');
const { computeDiscriminationStats } = require('../../src/services/scoring/questionDiscrimination');

function provideRows(rows) {
    BenchmarkResult.find.mockReturnValue({
        select: jest.fn(() => ({
            lean: jest.fn(async () => rows)
        }))
    });
}

describe('question discrimination', () => {
    afterEach(() => jest.clearAllMocks());

    test('uses effective contribution as pass rate for inverted questions', async () => {
        provideRows([
            {
                scoring_type: 'reasoning',
                model: 'model-a',
                decomposed_breakdown: {
                    logic_soundness: [{
                        question: 'Are there contradictions?',
                        answer: false,
                        inverted: true,
                        contributed: true,
                        weight: 0.25
                    }]
                }
            },
            {
                scoring_type: 'reasoning',
                model: 'model-b',
                decomposed_breakdown: {
                    logic_soundness: [{
                        question: 'Are there contradictions?',
                        answer: false,
                        inverted: true,
                        contributed: true,
                        weight: 0.25
                    }]
                }
            }
        ]);

        const result = await computeDiscriminationStats();
        expect(result.questions).toHaveLength(1);
        expect(result.questions[0]).toMatchObject({
            inverted: true,
            yes: 0,
            no: 2,
            passed: 2,
            failed: 0,
            raw_yes_rate: 0,
            pass_rate: 1,
            sample_sufficient: false,
            flag: 'insufficient_data'
        });
    });

    test('reconstructs raw answers for historical rows without answer', async () => {
        provideRows([{
            scoring_type: 'reasoning',
            model: 'model-a',
            decomposed_breakdown: {
                logic_soundness: [{
                    question: 'Are there contradictions?',
                    inverted: true,
                    contributed: false,
                    weight: 0.25
                }]
            }
        }]);

        const result = await computeDiscriminationStats();
        expect(result.questions[0]).toMatchObject({
            yes: 1,
            no: 0,
            passed: 0,
            failed: 1,
            raw_yes_rate: 1,
            pass_rate: 0,
            sample_sufficient: false,
            flag: 'insufficient_data'
        });
    });

    test('flags an extreme only after the sample and model floors are met', async () => {
        provideRows(Array.from({ length: 5 }, (_, index) => ({
            scoring_type: 'reasoning',
            model: index % 2 === 0 ? 'model-a' : 'model-b',
            decomposed_breakdown: {
                accuracy: [{
                    question: 'Is the conclusion correct?',
                    answer: true,
                    contributed: true,
                    weight: 0.3
                }]
            }
        })));

        const result = await computeDiscriminationStats();

        expect(result.questions[0]).toMatchObject({
            passed: 5,
            model_count: 2,
            sample_sufficient: true,
            pass_rate: 1,
            flag: 'too_easy'
        });
        expect(result.stats.thresholds).toMatchObject({
            minSampleSize: 5,
            minModelCount: 2
        });
    });
});
