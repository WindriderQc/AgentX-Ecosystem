/**
 * Quality Scorer Unit Tests
 * Tests for enhanced scoring dimensions and consolidated scoring system
 */

const {
    buildDynamicJudgePrompt,
    getScoringDimensions,
    scoreResponse,
    calculateCompositeScore,
    quickScore,
    routeScoring,
    ENHANCED_SCORING_CONFIGS,
    CATEGORY_COMPOSITE_PROFILES,
    CATEGORY_STRATEGIES
} = require('../../src/services/qualityScorer');
const calibrationGoldset = require('../../data/judge-calibration-set.json');

// Mock logger to avoid console noise in tests
jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// Mock fetch for scoreResponse tests
jest.mock('node-fetch', () => jest.fn());
const mockFetch = require('node-fetch');

function mockBinary(answer) {
    return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: answer })
    });
}

describe('Enhanced Scoring Dimensions', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });
    describe('buildDynamicJudgePrompt', () => {
        it('should build a prompt with 4 core dimensions for coding category', () => {
            const dimensions = ENHANCED_SCORING_CONFIGS.coding.core_dimensions;
            const task = 'Write a function to sort an array';
            const expected = 'Efficient sorting algorithm';
            const response = 'function sort(arr) { return arr.sort(); }';

            const prompt = buildDynamicJudgePrompt(dimensions, task, expected, response);

            expect(prompt).toContain('You are a strict quality evaluator');
            expect(prompt).toContain('CRITERIA TO EVALUATE:');
            expect(prompt).toContain('correctness');
            expect(prompt).toContain('clarity');
            expect(prompt).toContain('efficiency');
            expect(prompt).toContain('robustness');
            expect(prompt).toContain(task);
            expect(prompt).toContain(expected);
            expect(prompt).toContain(response);
        });

        it('should build a prompt with 4 core dimensions for reasoning category', () => {
            const dimensions = ENHANCED_SCORING_CONFIGS.reasoning.core_dimensions;
            const task = 'Explain why the sky is blue';
            const expected = 'Scientific explanation';
            const response = 'The sky is blue because...';

            const prompt = buildDynamicJudgePrompt(dimensions, task, expected, response);

            expect(prompt).toContain('accuracy');
            expect(prompt).toContain('logic_soundness');
            expect(prompt).toContain('clarity');
            expect(prompt).toContain('completeness');
            expect(dimensions.length).toBe(4);
        });

        it('should format dimension names in criteria list (replace underscores with spaces)', () => {
            const dimensions = [
                { name: 'error_handling', weight: 0.5, desc: 'Handles errors well?' },
                { name: 'test_coverage', weight: 0.5, desc: 'Good test coverage?' }
            ];

            const prompt = buildDynamicJudgePrompt(dimensions, 'task', 'expected', 'response');

            expect(prompt).toContain('1. error handling (0-10): Handles errors well?');
            expect(prompt).toContain('2. test coverage (0-10): Good test coverage?');
            expect(prompt).toContain('"error_handling": "X"');
            expect(prompt).toContain('"test_coverage": "X"');
        });

        it('should include JSON format template with all dimensions', () => {
            const dimensions = [
                { name: 'accuracy', weight: 0.5, desc: 'Is accurate?' },
                { name: 'clarity', weight: 0.5, desc: 'Is clear?' }
            ];

            const prompt = buildDynamicJudgePrompt(dimensions, 'task', 'expected', 'response');

            expect(prompt).toContain('"accuracy": "X"');
            expect(prompt).toContain('"clarity": "X"');
            expect(prompt).toContain('"overall": "X"');
            expect(prompt).toContain('"explanation": "brief reason"');
        });

        it('should include empty response handling instructions', () => {
            const dimensions = ENHANCED_SCORING_CONFIGS.coding.core_dimensions;
            const prompt = buildDynamicJudgePrompt(dimensions, 'task', 'expected', 'response');

            expect(prompt).toContain('RESPONSE TO EVALUATE section is empty or blank');
            expect(prompt).toContain('assign 0 to all dimensions');
        });
    });

    describe('getScoringDimensions', () => {
        it('should use custom scoring_dimensions from prompt if defined', () => {
            const prompt = {
                name: 'Custom Prompt',
                scoring_type: 'coding',
                scoring_dimensions: [
                    { name: 'custom_dim1', weight: 0.6, description: 'Custom dimension 1' },
                    { name: 'custom_dim2', weight: 0.4, description: 'Custom dimension 2' }
                ]
            };

            const result = getScoringDimensions(prompt);

            expect(result.category).toBe('custom');
            expect(result.dimensions).toHaveLength(2);
            expect(result.dimensions[0].name).toBe('custom_dim1');
            expect(result.dimensions[0].weight).toBe(0.6);
            expect(result.dimensions[0].desc).toBe('Custom dimension 1');
            expect(result.weights).toEqual({ custom_dim1: 0.6, custom_dim2: 0.4 });
        });

        it('should use enhanced configs if no custom dimensions defined', () => {
            const prompt = {
                name: 'Test Prompt',
                scoring_type: 'coding'
            };

            const result = getScoringDimensions(prompt);

            expect(result.category).toBe('coding');
            expect(result.dimensions.length).toBe(4);
            expect(result.dimensions[0].name).toBe('correctness');
            expect(result.weights.correctness).toBeGreaterThan(0);
        });

        it('should fall back to the default benchmark config for unknown scoring_type', () => {
            const prompt = {
                name: 'Test Prompt',
                scoring_type: 'unknown-category'
            };

            const result = getScoringDimensions(prompt);

            expect(result.category).toBe('knowledge');
            expect(result.dimensions.length).toBe(4);
            expect(result.dimensions[0].name).toBe('accuracy');
        });

        it('should remap legacy scoring types to the canonical benchmark category', () => {
            const prompt = {
                name: 'Legacy Refactor Prompt',
                scoring_type: 'refactoring'
            };

            const result = getScoringDimensions(prompt);

            expect(result.category).toBe('coding');
            expect(result.dimensions.length).toBe(4);
            expect(result.dimensions[0].name).toBe('correctness');
        });

        it('should use knowledge config by default when no scoring_type specified', () => {
            const prompt = {
                name: 'Test Prompt'
            };

            const result = getScoringDimensions(prompt);

            expect(result.category).toBe('knowledge');
            expect(result.dimensions.length).toBe(4);
        });

        it('should handle all 7 benchmark category types', () => {
            const categories = Object.keys(ENHANCED_SCORING_CONFIGS);

            categories.forEach(category => {
                const prompt = { name: 'Test', scoring_type: category };
                const result = getScoringDimensions(prompt);

                expect(result.dimensions.length).toBe(4);
                expect(result.weights).toBeDefined();
            });
        });
    });

    describe('quickScore', () => {
        it('should return score 10 for JSON exact match', () => {
            const response = '{"name": "Alice", "age": 30}';
            const prompt = { expected_answer: '{"name": "Alice", "age": 30}' };
            const result = quickScore(response, prompt);

            expect(result).not.toBeNull();
            expect(result.quick).toBe(true);
            expect(result.score).toBe(10);
            expect(result.matched).toBe(true);
            expect(result.pattern).toBe('json_exact_match');
        });

        it('should return null for JSON mismatch so downstream scoring can judge semantics', () => {
            const response = '{"name": "Bob", "age": 30}';
            const prompt = { expected_answer: '{"name": "Alice", "age": 30}' };
            const result = quickScore(response, prompt);

            expect(result).toBeNull();
        });

        it('should return null for prompts without expected_answer', () => {
            const response = 'Some response';
            const prompt = { prompt: 'Explain something complex' };
            const result = quickScore(response, prompt);
            expect(result).toBeNull();
        });

        it('should return null for non-JSON text (deferred to downstream scorers)', () => {
            const response = 'The capital of France is Paris.';
            const prompt = { prompt: 'What is the capital of France?', expected_answer: 'Paris' };
            const result = quickScore(response, prompt);
            // Non-JSON: quickScorer defers to deterministic/LLM
            expect(result).toBeNull();
        });

        it('should return null for math text answers (deferred to downstream scorers)', () => {
            const response = 'The answer is 42.';
            const prompt = { prompt: 'What is 15 + 27?', expected_answer: '42' };
            const result = quickScore(response, prompt);
            // Non-JSON: quickScorer defers to deterministic scorer
            expect(result).toBeNull();
        });

        it('should handle JSON arrays', () => {
            const response = '[1, 2, 3]';
            const prompt = { expected_answer: '[1, 2, 3]' };
            const result = quickScore(response, prompt);

            expect(result).not.toBeNull();
            expect(result.score).toBe(10);
            expect(result.pattern).toBe('json_exact_match');
        });
    });

    describe('ENHANCED_SCORING_CONFIGS Validation', () => {
        it('should have all 7 required categories', () => {
            const expectedCategories = [
                'coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'
            ];

            expectedCategories.forEach(category => {
                expect(ENHANCED_SCORING_CONFIGS).toHaveProperty(category);
            });
        });

        it('should have exactly 4 core dimensions per category', () => {
            Object.entries(ENHANCED_SCORING_CONFIGS).forEach(([category, config]) => {
                expect(config.core_dimensions.length).toBe(4);
            });
        });

        it('should have core_dimension weights that sum to 1.0 for each category', () => {
            Object.entries(ENHANCED_SCORING_CONFIGS).forEach(([category, config]) => {
                const sum = config.core_dimensions.reduce((acc, dim) => acc + dim.weight, 0);
                expect(sum).toBeCloseTo(1.0, 2);
            });
        });

        it('should have all required fields for each core dimension', () => {
            Object.entries(ENHANCED_SCORING_CONFIGS).forEach(([category, config]) => {
                config.core_dimensions.forEach(dim => {
                    expect(dim).toHaveProperty('name');
                    expect(dim).toHaveProperty('weight');
                    expect(dim).toHaveProperty('desc');
                    expect(typeof dim.name).toBe('string');
                    expect(typeof dim.weight).toBe('number');
                    expect(typeof dim.desc).toBe('string');
                });
            });
        });

        describe('Category-specific validations', () => {
            it('coding: should include correctness as highest-weighted dimension', () => {
                const dims = ENHANCED_SCORING_CONFIGS.coding.core_dimensions;
                const correctness = dims.find(d => d.name === 'correctness');
                expect(correctness).toBeDefined();
                expect(correctness.weight).toBeGreaterThanOrEqual(0.3);
            });

            it('reasoning: should include accuracy and logic_soundness', () => {
                const dims = ENHANCED_SCORING_CONFIGS.reasoning.core_dimensions;
                expect(dims.find(d => d.name === 'accuracy')).toBeDefined();
                expect(dims.find(d => d.name === 'logic_soundness')).toBeDefined();
            });

            it('math: should include answer_correctness as a core weighted dimension', () => {
                const dims = ENHANCED_SCORING_CONFIGS.math.core_dimensions;
                const answer = dims.find(d => d.name === 'answer_correctness');
                expect(answer).toBeDefined();
                expect(answer.weight).toBeGreaterThanOrEqual(0.25);
            });

            it('creative: should include originality', () => {
                const dims = ENHANCED_SCORING_CONFIGS.creative.core_dimensions;
                expect(dims.find(d => d.name === 'originality')).toBeDefined();
            });

            it('instruction: should include instruction adherence and format accuracy', () => {
                const dims = ENHANCED_SCORING_CONFIGS.instruction.core_dimensions;
                expect(dims.find(d => d.name === 'instruction_adherence')).toBeDefined();
                expect(dims.find(d => d.name === 'format_accuracy')).toBeDefined();
            });
        });
    });

    describe('Category-Specific Composite Profiles', () => {
        const testMetrics = {
            latency: 5000,
            tokens_per_sec: 50,
            quality_score: 8.5
        };

        describe('CATEGORY_COMPOSITE_PROFILES Structure', () => {
            it('should export CATEGORY_COMPOSITE_PROFILES', () => {
                expect(CATEGORY_COMPOSITE_PROFILES).toBeDefined();
                expect(typeof CATEGORY_COMPOSITE_PROFILES).toBe('object');
            });

            it('should have all required benchmark categories', () => {
                const expectedCategories = [
                    'coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'
                ];

                expectedCategories.forEach(category => {
                    expect(CATEGORY_COMPOSITE_PROFILES).toHaveProperty(category);
                });
            });

            it('should have weights that sum to 1.0 for each category', () => {
                Object.entries(CATEGORY_COMPOSITE_PROFILES).forEach(([category, profile]) => {
                    const sum = Object.values(profile.weights).reduce((a, b) => a + b, 0);
                    expect(sum).toBeCloseTo(1.0, 3);
                });
            });
        });

        describe('calculateCompositeScore', () => {
            it('should accept category name and use category-specific weights', () => {
                const result = calculateCompositeScore(testMetrics, 'coding');

                expect(result).toHaveProperty('composite_score');
                expect(result).toHaveProperty('composite_profile_used');
                expect(result.composite_profile_used).toBe('category:coding');
                expect(result.weights.quality).toBe(0.6);
            });

            it('should produce different scores for different categories', () => {
                const codingResult = calculateCompositeScore(testMetrics, 'coding');
                const reasoningResult = calculateCompositeScore(testMetrics, 'reasoning');

                expect(codingResult.composite_score).not.toBe(reasoningResult.composite_score);
            });

            it('should prioritize quality for reasoning category (80% weight)', () => {
                const result = calculateCompositeScore(testMetrics, 'reasoning');

                expect(result.weights.quality).toBe(0.8);
                expect(result.weights.latency).toBe(0.1);
                expect(result.weights.speed).toBe(0.1);
            });

            it('should default to knowledge category for unknown category (contract §2.9)', () => {
                const result = calculateCompositeScore(testMetrics, 'nonexistent');

                expect(result.composite_profile_used).toBe('category:knowledge');
            });

            it('should handle edge cases gracefully', () => {
                const invalidMetrics = {
                    latency: 'not-a-number',
                    tokens_per_sec: null,
                    quality_score: undefined
                };
                const result = calculateCompositeScore(invalidMetrics, 'coding');

                expect(result.composite_score).toBeGreaterThanOrEqual(0);
                expect(result.normalized.quality).toBe(0);
                expect(result.normalized.speed).toBe(0);
            });

            it('should cap latency score at 0 when exceeding latencyCap', () => {
                const highLatencyMetrics = { ...testMetrics, latency: 100000 };
                const result = calculateCompositeScore(highLatencyMetrics, 'knowledge');

                // knowledge has 30s cap, 100s should give 0 latency score
                expect(result.normalized.latency).toBe(0);
            });

            it('should cap composite to 0 when quality is 0 (quality floor)', () => {
                const zeroQualityMetrics = {
                    latency: 500,         // very fast
                    tokens_per_sec: 80,   // very fast
                    quality_score: 0      // zero quality
                };
                const result = calculateCompositeScore(zeroQualityMetrics, 'knowledge');

                expect(result.composite_score).toBe(0);
                expect(result.normalized.quality).toBe(0);
            });

            // Contract §2.9 (delta 0113): fast-garbage floor tightened from
            // `quality_score === 0` to `quality_score < 3`. A 0.4/10 answer
            // must not earn >4/100 regardless of speed.
            it('should cap composite at quality*10 when quality is 0.4 (fast-garbage floor)', () => {
                const fastButLowQuality = {
                    latency: 100,         // extremely fast
                    tokens_per_sec: 100,
                    quality_score: 0.4
                };
                const result = calculateCompositeScore(fastButLowQuality, 'knowledge');

                expect(result.composite_score).toBe(4);
            });

            it('should cap composite at quality*10 when quality is 2.9 (just under floor)', () => {
                const borderlineFast = {
                    latency: 100,
                    tokens_per_sec: 100,
                    quality_score: 2.9
                };
                const result = calculateCompositeScore(borderlineFast, 'knowledge');

                expect(result.composite_score).toBe(29);
            });

            it('should apply normal composite formula at quality >= 3', () => {
                const passingQuality = {
                    latency: 100,
                    tokens_per_sec: 100,
                    quality_score: 3
                };
                const result = calculateCompositeScore(passingQuality, 'knowledge');

                // knowledge weights: quality=0.7, latency=0.2, speed=0.1
                // qualityScore=30, responsivenessScore≈99.7, speedScore=100
                // composite ≈ 30*0.7 + ~99.7*0.2 + 100*0.1 ≈ 50.9 >> 30 (floor * 10)
                expect(result.composite_score).toBeGreaterThan(30);
            });

            it('should default to knowledge category and log warning when category is missing', () => {
                const logger = require('../../config/logger');
                logger.warn.mockClear();

                const result = calculateCompositeScore({
                    latency: 1000,
                    tokens_per_sec: 50,
                    quality_score: 7
                });

                expect(result.composite_profile_used).toBe('category:knowledge');
                expect(logger.warn).toHaveBeenCalledWith(
                    expect.stringContaining('calculateCompositeScore'),
                    expect.objectContaining({ defaulted_to: 'knowledge' })
                );
            });
        });
    });

    describe('scoreResponse edge cases', () => {
        it('should export scoreResponse function', () => {
            expect(typeof scoreResponse).toBe('function');
        });

        it('should return score 0 with empty_response method for empty responses', async () => {
            const result = await scoreResponse({
                response: '',
                prompt: { prompt: 'Test prompt', scoring_type: 'knowledge' }
            });

            expect(result.quality_score).toBe(0);
            expect(result.scoring_method).toBe('empty_response');
            expect(result.explanation).toContain('NO response');
        });

        it('should normalize legacy scoring types before returning empty-response metadata', async () => {
            const result = await scoreResponse({
                response: '',
                prompt: { prompt: 'Refactor this function', scoring_type: 'refactoring' }
            });

            expect(result.quality_score).toBe(0);
            expect(result.scoring_method).toBe('empty_response');
            expect(result.scoring_type).toBe('coding');
        });

        it('should return score 0 with empty_response method for whitespace-only responses', async () => {
            const result = await scoreResponse({
                response: '   \n\t  ',
                prompt: { prompt: 'Test prompt', scoring_type: 'knowledge' }
            });

            expect(result.quality_score).toBe(0);
            expect(result.scoring_method).toBe('empty_response');
        });

        it('should skip LLM judge when skipLLM is true', async () => {
            const result = await scoreResponse({
                response: 'Some response',
                prompt: { prompt: 'Test prompt' },
                skipLLM: true
            });

            expect(result.scoring_method).toBe('skipped');
            expect(result.quality_score).toBeNull();
        });

        it('should use deterministic numeric scoring path for math prompts and return quality_score', async () => {
            const result = await scoreResponse({
                response: 'x = 6',
                prompt: {
                    prompt: 'Solve for x: 7x = 42',
                    scoring_type: 'math',
                    expected_answer: '6',
                    level: 3
                }
            });

            expect(result.scoring_method).toBe('deterministic');
            expect(result.quality_score).toBe(10);
            expect(result.judge_confidence).toBe(1);
            expect(result.needs_review).toBe(false);
        });

        it('scores cal-bad-02 as a low deterministic math mismatch', async () => {
            const anchor = calibrationGoldset.find(row => row.id === 'cal-bad-02');
            const result = await scoreResponse({
                response: anchor.response,
                prompt: {
                    name: `config-goldset-${anchor.id}`,
                    prompt: anchor.prompt,
                    scoring_type: anchor.category,
                    category: anchor.category,
                    expected_answer: anchor.expected_answer,
                    level: anchor.difficulty || 3
                }
            });

            expect(result.scoring_method).toBe('deterministic');
            expect(result.matched_expected).toBe(false);
            expect(result.quality_score).toBeLessThanOrEqual(anchor.gold_score);
            expect(result.quality_score).not.toBe(6);
        });
    });

    describe('Phase 1.5 disabled — criteria-based hybrid removed', () => {
        it('should route instruction prompts with judge_criteria to decomposed, not hybrid', async () => {
            mockFetch.mockImplementation(() => mockBinary('YES'));

            const response = 'Q1: The Pine Ridge trail is closed.\nQ2: They had rye sandwiches for lunch.\nQ3: They stayed at Alder Cove campsite.';
            const prompt = {
                name: 'Lake Trip Journal',
                scoring_type: 'instruction',
                category: 'instruction',
                expected_answer: 'Q1: Pine Ridge trail. Q2: Rye sandwiches. Q3: Alder Cove.',
                judge_criteria: [
                    'Names Pine Ridge as the closed trail',
                    'Identifies rye sandwiches as the main lunch item',
                    'Names Alder Cove as the campsite',
                    'Answers are labeled Q1, Q2, Q3'
                ]
            };

            const result = await routeScoring(response, prompt, { host: 'http://localhost:11434', model: 'test' });

            expect(result).not.toBeNull();
            expect(result.scoring_method).toBe('decomposed');
        });
    });
});
