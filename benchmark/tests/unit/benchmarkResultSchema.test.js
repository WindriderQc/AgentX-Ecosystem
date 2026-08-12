/**
 * Tests for TODO 0111: BenchmarkResult schema includes decomposed_breakdown.
 *
 * Covers delta row 8 from scoring-contract-v1.md §3:
 *   BenchmarkResult had no `decomposed_breakdown` field, so Mongoose was
 *   stripping the value that decomposedJudge writes. This test confirms the
 *   field is declared in the schema and that a document instance preserves it
 *   through Mongoose's type coercion (no DB round-trip required).
 */

jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const BenchmarkResult = require('../../models/BenchmarkResult');
const BenchmarkPrompt = require('../../models/BenchmarkPrompt');

describe('BenchmarkResult schema — decomposed_breakdown', () => {
    test('decomposed_breakdown path is declared on the schema', () => {
        const path = BenchmarkResult.schema.path('decomposed_breakdown');
        expect(path).toBeDefined();
    });

    test('default value is null', () => {
        const instance = new BenchmarkResult({
            model: 'test-model',
            host: 'http://localhost:11434',
            prompt: 'test',
            success: true
        });
        expect(instance.decomposed_breakdown).toBeNull();
    });

    test('nested object value is preserved through Mongoose assignment', () => {
        const sampleBreakdown = {
            correctness: [
                { question: 'Is the output numerically correct?', answer: true, weight: 0.4, contributed: true },
                { question: 'Are edge cases handled?', answer: false, weight: 0.3, contributed: false }
            ],
            clarity: [
                { question: 'Is variable naming descriptive?', answer: true, weight: 0.5, contributed: true }
            ]
        };

        const instance = new BenchmarkResult({
            model: 'test-model',
            host: 'http://localhost:11434',
            prompt: 'Write a sort function',
            success: true,
            decomposed_breakdown: sampleBreakdown
        });

        expect(instance.decomposed_breakdown).toEqual(sampleBreakdown);
        expect(instance.decomposed_breakdown.correctness).toHaveLength(2);
        expect(instance.decomposed_breakdown.correctness[0].answer).toBe(true);
        expect(instance.decomposed_breakdown.clarity[0].question)
            .toBe('Is variable naming descriptive?');
    });

    test('toObject() / toJSON() include decomposed_breakdown', () => {
        const instance = new BenchmarkResult({
            model: 'test-model',
            host: 'http://localhost:11434',
            prompt: 'test',
            success: true,
            decomposed_breakdown: { foo: [{ q: 'bar' }] }
        });

        const asObj = instance.toObject();
        expect(asObj).toHaveProperty('decomposed_breakdown');
        expect(asObj.decomposed_breakdown).toEqual({ foo: [{ q: 'bar' }] });
    });

    test('factual prompt category is valid for corpus persistence', () => {
        const promptCategoryPath = BenchmarkPrompt.schema.path('category');
        const resultCategoryPath = BenchmarkResult.schema.path('prompt_category');
        expect(promptCategoryPath.enumValues).toContain('factual');
        expect(resultCategoryPath.enumValues).toContain('factual');

        const instance = new BenchmarkResult({
            model: 'test-model',
            host: 'http://localhost:11434',
            prompt: 'What is the capital of France?',
            prompt_category: 'factual',
            scoring_type: 'factual',
            success: true
        });
        expect(instance.validateSync()).toBeUndefined();
    });
});
