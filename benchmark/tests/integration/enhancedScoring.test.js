/**
 * Enhanced Scoring Integration Tests
 * Tests for enhanced scoring dimensions with 8-12 dimensions
 */

const {
    getScoringDimensions,
    buildDynamicJudgePrompt,
    ENHANCED_SCORING_CONFIGS
} = require('../../src/services/qualityScorer');

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const BenchmarkPrompt = require('../../models/BenchmarkPrompt');

describe('Enhanced Scoring System - Integration', () => {
    let mongoServer;

    beforeAll(async () => {
        mongoServer = await MongoMemoryServer.create();
        await mongoose.connect(mongoServer.getUri());
    }, 15000);

    afterAll(async () => {
        await mongoose.disconnect();
        await mongoServer.stop();
    });

    afterEach(async () => {
        await BenchmarkPrompt.deleteMany({});
    });

    describe('BenchmarkPrompt Model with scoring_dimensions', () => {
        it('should save prompt with custom scoring_dimensions', async () => {
            const prompt = await BenchmarkPrompt.create({
                name: 'Custom Scoring Prompt',
                prompt: 'Write a function to calculate fibonacci',
                level: 2,
                category: 'coding',
                scoring_type: 'coding',
                scoring_dimensions: [
                    {
                        name: 'correctness',
                        weight: 0.4,
                        description: 'Does the code produce correct results?',
                        scale: '0-10',
                        rubric: 'Test cases must pass'
                    },
                    {
                        name: 'efficiency',
                        weight: 0.3,
                        description: 'Is the algorithm efficient?',
                        scale: '0-10',
                        rubric: 'Should be O(n) or better'
                    },
                    {
                        name: 'readability',
                        weight: 0.3,
                        description: 'Is the code easy to understand?',
                        scale: '0-10',
                        rubric: 'Clear variable names and comments'
                    }
                ]
            });

            expect(prompt._id).toBeDefined();
            expect(prompt.scoring_dimensions).toHaveLength(3);
            expect(prompt.scoring_dimensions[0].name).toBe('correctness');
            expect(prompt.scoring_dimensions[0].weight).toBe(0.4);
            expect(prompt.scoring_dimensions[0].description).toBe('Does the code produce correct results?');
        });

        it('should validate weight range (0-1)', async () => {
            await expect(BenchmarkPrompt.create({
                    name: 'Invalid Weight',
                    prompt: 'Test',
                    level: 1,
                    category: 'knowledge',
                    scoring_dimensions: [
                        {
                            name: 'test',
                            weight: 1.5, // Invalid: > 1
                            description: 'Test dimension'
                        }
                    ]
                })).rejects.toMatchObject({ name: 'ValidationError' });
        });

        it('should allow prompt without scoring_dimensions (backward compatible)', async () => {
            const prompt = await BenchmarkPrompt.create({
                name: 'Legacy Prompt',
                prompt: 'What is 2+2?',
                level: 1,
                category: 'math',
                scoring_type: 'math'
            });

            expect(prompt._id).toBeDefined();
            expect(prompt.scoring_dimensions).toBeUndefined();
        });
    });

    describe('Enhanced Scoring Dimension Selection', () => {
        it('should use enhanced config for coding category (4 core dimensions)', async () => {
            const prompt = await BenchmarkPrompt.create({
                name: 'Code Test',
                prompt: 'Implement binary search',
                level: 3,
                category: 'coding',
                scoring_type: 'coding'
            });

            const dimensions = getScoringDimensions(prompt);

            // Now uses 4 core dimensions for judge reliability
            expect(dimensions.category).toBe('coding');
            expect(dimensions.dimensions).toHaveLength(4);
            expect(dimensions.dimensions.map(d => d.name)).toEqual([
                'correctness',
                'clarity',
                'efficiency',
                'robustness'
            ]);
        });

        it('should use enhanced config for reasoning category (4 core dimensions)', async () => {
            const prompt = await BenchmarkPrompt.create({
                name: 'Reasoning Test',
                prompt: 'Explain why correlation does not imply causation',
                level: 3,
                category: 'reasoning',
                scoring_type: 'reasoning'
            });

            const dimensions = getScoringDimensions(prompt);

            expect(dimensions.category).toBe('reasoning');
            expect(dimensions.dimensions).toHaveLength(4);
            expect(dimensions.dimensions.map(d => d.name)).toEqual([
                'accuracy',
                'logic_soundness',
                'completeness',
                'clarity'
            ]);
        });

        it('should use enhanced config for math category (4 core dimensions)', async () => {
            const prompt = await BenchmarkPrompt.create({
                name: 'Math Test',
                prompt: 'Solve the integral of x^2',
                level: 4,
                category: 'math',
                scoring_type: 'math'
            });

            const dimensions = getScoringDimensions(prompt);

            expect(dimensions.category).toBe('math');
            expect(dimensions.dimensions).toHaveLength(4);
            expect(dimensions.dimensions.map(d => d.name)).toEqual([
                'answer_correctness',
                'method',
                'rigor',
                'clarity'
            ]);
        });

        it('should use custom dimensions when specified', async () => {
            const prompt = await BenchmarkPrompt.create({
                name: 'Custom Dimensions',
                prompt: 'Write a poem',
                level: 2,
                category: 'creative',
                scoring_type: 'creative',
                scoring_dimensions: [
                    {
                        name: 'beauty',
                        weight: 0.5,
                        description: 'Is it beautiful?'
                    },
                    {
                        name: 'meaning',
                        weight: 0.5,
                        description: 'Does it have depth?'
                    }
                ]
            });

            const dimensions = getScoringDimensions(prompt);

            expect(dimensions.category).toBe('custom');
            expect(dimensions.dimensions).toHaveLength(2);
            expect(dimensions.dimensions[0].name).toBe('beauty');
            expect(dimensions.dimensions[1].name).toBe('meaning');
        });
    });

    describe('Dynamic Judge Prompt Generation', () => {
        it('should generate detailed prompts for 4-dimension coding scoring', async () => {
            const prompt = await BenchmarkPrompt.create({
                name: 'Fibonacci',
                prompt: 'Write a function to calculate fibonacci numbers',
                level: 2,
                category: 'coding',
                scoring_type: 'coding',
                expected_answer: 'Efficient recursive or iterative solution'
            });

            const dimensions = getScoringDimensions(prompt);
            const judgePrompt = buildDynamicJudgePrompt(
                dimensions.dimensions,
                prompt.prompt,
                prompt.expected_answer,
                'function fib(n) { return n <= 1 ? n : fib(n-1) + fib(n-2); }'
            );

            // Verify all 4 core dimensions are in the prompt
            expect(judgePrompt).toContain('correctness');
            expect(judgePrompt).toContain('clarity');
            expect(judgePrompt).toContain('efficiency');
            expect(judgePrompt).toContain('robustness');

            // Verify JSON template has all dimensions
            expect(judgePrompt).toContain('"correctness": "X"');
            expect(judgePrompt).toContain('"clarity": "X"');
            expect(judgePrompt).toContain('"efficiency": "X"');
            expect(judgePrompt).toContain('"robustness": "X"');
            expect(judgePrompt).toContain('"overall": "X"');
        });

        it('should generate prompts with custom dimensions', async () => {
            const prompt = await BenchmarkPrompt.create({
                name: 'SQL Query',
                prompt: 'Write a SQL query to find top 10 customers',
                level: 2,
                category: 'coding',
                scoring_dimensions: [
                    {
                        name: 'correctness',
                        weight: 0.4,
                        description: 'Does the query return correct results?'
                    },
                    {
                        name: 'optimization',
                        weight: 0.3,
                        description: 'Is the query optimized with proper indexes?'
                    },
                    {
                        name: 'readability',
                        weight: 0.3,
                        description: 'Is the query well-formatted and clear?'
                    }
                ]
            });

            const dimensions = getScoringDimensions(prompt);
            const judgePrompt = buildDynamicJudgePrompt(
                dimensions.dimensions,
                prompt.prompt,
                'SELECT with proper ORDER BY and LIMIT',
                'SELECT * FROM customers ORDER BY total_spent DESC LIMIT 10;'
            );

            expect(judgePrompt).toContain('1. correctness (0-10): Does the query return correct results?');
            expect(judgePrompt).toContain('2. optimization (0-10): Is the query optimized with proper indexes?');
            expect(judgePrompt).toContain('3. readability (0-10): Is the query well-formatted and clear?');
        });
    });

    describe('Backward Compatibility with Legacy Prompts', () => {
        it('should work with prompts created before enhanced scoring', async () => {
            const legacyPrompt = await BenchmarkPrompt.create({
                name: 'Legacy Math',
                prompt: 'What is 15 + 27?',
                level: 1,
                category: 'math',
                scoring_type: 'math',
                expected_answer: '42'
            });

            // Should use enhanced config (4 core dimensions) since ENHANCED_SCORING_CONFIGS exists
            const dimensions = getScoringDimensions(legacyPrompt);

            expect(dimensions.category).toBe('math');
            expect(dimensions.dimensions).toHaveLength(4);
        });

        it('should handle prompts with undefined scoring_type', async () => {
            const prompt = await BenchmarkPrompt.create({
                name: 'General Question',
                prompt: 'Explain photosynthesis',
                level: 2,
                category: 'knowledge'
            });

            const dimensions = getScoringDimensions(prompt);

            // BenchmarkPrompt model defaults scoring_type to 'reasoning'
            expect(dimensions.category).toBe('reasoning');
            expect(dimensions.dimensions).toHaveLength(4);
        });
    });

    describe('Weight Validation', () => {
        it('should ensure weights sum to approximately 1.0 for enhanced configs', () => {
            Object.entries(ENHANCED_SCORING_CONFIGS).forEach(([category, config]) => {
                const sum = config.core_dimensions.reduce((acc, dim) => acc + dim.weight, 0);
                expect(sum).toBeCloseTo(1.0, 2);
            });
        });

        it('should support custom weight distributions', async () => {
            const prompt = await BenchmarkPrompt.create({
                name: 'Weighted Test',
                prompt: 'Test prompt',
                level: 1,
                category: 'knowledge',
                scoring_dimensions: [
                    { name: 'critical', weight: 0.7, description: 'Critical aspect' },
                    { name: 'minor', weight: 0.2, description: 'Minor aspect' },
                    { name: 'optional', weight: 0.1, description: 'Optional aspect' }
                ]
            });

            const dimensions = getScoringDimensions(prompt);
            const sum = dimensions.dimensions.reduce((acc, dim) => acc + dim.weight, 0);

            expect(sum).toBeCloseTo(1.0, 2);
            expect(dimensions.weights.critical).toBe(0.7);
        });
    });
});
