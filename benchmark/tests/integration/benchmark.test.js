/**
 * Benchmark Integration Tests
 * Tests for benchmark routes and service layer
 */

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Keep integration tests deterministic and quiet by bypassing live judge/decomposed scoring.
jest.mock('../../src/services/qualityScorer', () => {
    const actual = jest.requireActual('../../src/services/qualityScorer');
    return {
        ...actual,
        scoreResponse: jest.fn(async ({ judgeConfig = {} } = {}) => ({
            quality_score: 8,
            breakdown: { overall: 8 },
            explanation: 'Mocked integration judge score',
            judge_prompt: 'mock judge prompt',
            judge_model: judgeConfig.model || actual.JUDGE_CONFIG.model,
            scoring_method: 'llm_judge',
            scoring_type: 'reasoning',
            scoring_time_ms: 12,
            judge_confidence: 0.95,
            needs_review: false
        }))
    };
});

// Mock judge model validation to bypass network calls in tests
jest.mock('../../src/services/benchmark/judgeModelValidator', () => ({
    validateJudgeModel: jest.fn(async () => ({ valid: true, latency_ms: 10 }))
}));

// Mock execution host validation to bypass network calls in tests
jest.mock('../../src/services/benchmark/executionHostValidator', () => ({
    validateExecutionHost: jest.fn(async () => ({ valid: true, available_models: [] }))
}));

jest.mock('../../src/services/benchmark/preflight', () => ({
    runPreflight: jest.fn(async () => ({
        ready: true,
        issues: [],
        checks: {
            hosts: [],
            judge: { ok: true, warnings: [], blockers: [] },
            prompts: { ok: true, warnings: [], blockers: [], totalPrompts: 2, categories: {} },
            batches: { ok: true, activeBatches: 0, orphanedBatches: [] }
        }
    }))
}));

const app = require('../../server');
const { runPreflight } = require('../../src/services/benchmark/preflight');
const { validateJudgeModel } = require('../../src/services/benchmark/judgeModelValidator');
const activeProfileState = require('../../src/services/profiler/activeProfileState');

const BenchmarkPrompt = require('../../models/BenchmarkPrompt');
const BenchmarkResult = require('../../models/BenchmarkResult');
const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const HostPerformanceSnapshot = require('../../models/HostPerformanceSnapshot');
const ModelProfile = require('../../models/ModelProfile');
const { CATEGORY_COMPOSITE_PROFILES } = require('../../src/services/scoring/scoringConfigs');
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let mongoServer;

// Server.js only connects inside start(), which is gated by
// `require.main === module`. Integration tests own an isolated MongoMemory
// database so they do not depend on the LAN Mongo host being up.
beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
}, 15000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

afterEach(async () => {
    // Clear all collections between tests
    try {
        await BenchmarkPrompt.deleteMany({});
        await BenchmarkResult.deleteMany({});
        await BenchmarkBatch.deleteMany({});
        await HostPerformanceSnapshot.deleteMany({});
        await ModelProfile.deleteMany({});
        activeProfileState.clearActiveProfilingState();
    } catch (err) {
        // Ignore cleanup errors during tests
    }
});

describe('Benchmark System - Integration Tests', () => {
    describe('POST /api/benchmark/test', () => {
        it('should validate required fields', async () => {
            const response = await request(app)
                .post('/api/benchmark/test')
                .send({ model: 'test-model' }); // Missing host and prompt

            expect(response.status).toBe(400);
            expect(response.body.status).toBe('error');
            expect(response.body.error).toContain('required');
        });
    });

    describe('GET /api/benchmark/prompts', () => {
        it('should return prompts (seeding from JSON if empty)', async () => {
            const response = await request(app).get('/api/benchmark/prompts');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(Array.isArray(response.body.data.prompts)).toBe(true);
            expect(response.body.data.total).toBeGreaterThanOrEqual(0);
        });

        it('should seed prompts from JSON file if collection is empty', async () => {
            const response = await request(app).get('/api/benchmark/prompts');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');

            // Verify prompts were seeded
            const count = await BenchmarkPrompt.countDocuments();
            expect(count).toBeGreaterThan(0);

            const seededCategories = await BenchmarkPrompt.distinct('category');
            expect(seededCategories.sort()).toEqual([
                'coding',
                'creative',
                'instruction',
                'knowledge',
                'math',
                'reasoning',
                'translation'
            ]);
        });

        it('should return prompts grouped by level', async () => {
            // Create test prompts
            await BenchmarkPrompt.create([
                {
                    name: 'Test Prompt 1',
                    prompt: 'What is 2+2?',
                    level: 1,
                    category: 'math'
                },
                {
                    name: 'Test Prompt 2',
                    prompt: 'Explain quantum computing',
                    level: 3,
                    category: 'reasoning'
                }
            ]);

            const response = await request(app).get('/api/benchmark/prompts');

            expect(response.status).toBe(200);
            expect(response.body.data.prompts.length).toBeGreaterThanOrEqual(2);
            expect(response.body.data.by_level).toHaveProperty('1');
            expect(response.body.data.by_level).toHaveProperty('3');
            expect(response.body.data.by_level['1'].some((p) => p.name === 'Test Prompt 1')).toBe(true);
            expect(response.body.data.by_level['3'].some((p) => p.name === 'Test Prompt 2')).toBe(true);
        });
    });

    describe('GET /api/benchmark/results', () => {
        it('should return paginated results', async () => {
            // Create test results
            await BenchmarkResult.create([
                {
                    model: 'test-model',
                    host: 'http://localhost:11434',
                    prompt: 'Test prompt',
                    latency: 1000,
                    tokens: 100,
                    success: true
                },
                {
                    model: 'test-model-2',
                    host: 'http://localhost:11434',
                    prompt: 'Test prompt 2',
                    latency: 2000,
                    tokens: 200,
                    success: true
                }
            ]);

            const response = await request(app).get('/api/benchmark/results?limit=10');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.results).toHaveLength(2);
            expect(response.body.data.total).toBe(2);
        });

        it('should respect limit parameter', async () => {
            // Create 5 results
            const results = [];
            for (let i = 0; i < 5; i++) {
                results.push({
                    model: `model-${i}`,
                    host: 'http://localhost:11434',
                    prompt: `Prompt ${i}`,
                    latency: 1000 + i * 100,
                    tokens: 100,
                    success: true
                });
            }
            await BenchmarkResult.create(results);

            const response = await request(app).get('/api/benchmark/results?limit=3');

            expect(response.status).toBe(200);
            expect(response.body.data.results).toHaveLength(3);
            expect(response.body.data.total).toBe(5);
        });

    });

    describe('GET /api/benchmark/summary', () => {
        it('should return empty summary when no results exist', async () => {
            const response = await request(app).get('/api/benchmark/summary');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.total_tests).toBe(0);
            expect(response.body.data.leaderboard).toEqual([]);
        });

        it('should calculate correct statistics', async () => {
            // Create test results
            await BenchmarkResult.create([
                {
                    model: 'model-a',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    latency: 1000,
                    tokens: 100,
                    tokens_per_sec: 100,
                    success: true
                },
                {
                    model: 'model-a',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    latency: 2000,
                    tokens: 200,
                    tokens_per_sec: 100,
                    success: true
                },
                {
                    model: 'model-b',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    latency: 1500,
                    tokens: 150,
                    tokens_per_sec: 100,
                    success: false
                }
            ]);

            const response = await request(app).get('/api/benchmark/summary');

            expect(response.status).toBe(200);
            expect(response.body.data.total_tests).toBe(3);
            expect(response.body.data.successful).toBe(2);
            expect(response.body.data.failed).toBe(1);
            expect(response.body.data.leaderboard).toHaveLength(1); // Only successful model-a
            expect(response.body.data.leaderboard[0].model).toBe('model-a');
            expect(response.body.data.leaderboard[0].avg_latency).toBe(1500);
        });
    });

    describe('GET /api/benchmark/dashboard', () => {
        it('should return dashboard statistics', async () => {
            await BenchmarkResult.create({
                model: 'test-model',
                host: 'http://localhost:11434',
                prompt: 'Test',
                latency: 1000,
                tokens: 100,
                tokens_per_sec: 100,
                success: true
            });

            const response = await request(app).get('/api/benchmark/dashboard');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.overview).toHaveProperty('total_tests');
            expect(response.body.data.overview).toHaveProperty('successful');
            expect(response.body.data.overview).toHaveProperty('success_rate');
            expect(response.body.data.model_stats).toBeInstanceOf(Array);

            // Verify recent tests are included
            expect(response.body.data.recent_tests).toBeInstanceOf(Array);
            expect(response.body.data.recent_tests).toHaveLength(1);
            expect(response.body.data.recent_tests[0].model).toBe('test-model');
        });

        it('should sort results by specified criteria', async () => {
            await BenchmarkResult.create([
                {
                    model: 'fast-model',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    latency: 500,
                    tokens: 100,
                    tokens_per_sec: 200,
                    success: true
                },
                {
                    model: 'slow-model',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    latency: 2000,
                    tokens: 100,
                    tokens_per_sec: 50,
                    success: true
                }
            ]);

            const responseLatency = await request(app).get('/api/benchmark/dashboard?sort=latency&includeUnavailableModels=true');
            expect(responseLatency.body.data.model_stats[0].model).toBe('fast-model');

            const responseSpeed = await request(app).get('/api/benchmark/dashboard?sort=speed&includeUnavailableModels=true');
            expect(responseSpeed.body.data.model_stats[0].model).toBe('fast-model');
        });

        it('should enrich dashboard model stats with latest host test data', async () => {
            await BenchmarkResult.create({
                model: 'aligned-model',
                host: 'http://localhost:11434',
                prompt: 'Test',
                latency: 1000,
                tokens: 100,
                tokens_per_sec: 100,
                success: true
            });

            await ModelProfile.create({
                name: 'aligned-model',
                displayName: 'Aligned Model',
                categories: ['generalist'],
                benchmarkStats: { bestCategory: 'knowledge' }
            });

            await HostPerformanceSnapshot.create({
                modelName: 'aligned-model',
                hostUrl: 'http://localhost:11434',
                hostId: 'primary',
                tokensPerSec: 108,
                latencyMs: 950,
                timeToFirstTokenMs: 180,
                vramUsedMiB: 8192,
                vramTotalMiB: 24576,
                testedAt: new Date(),
                status: 'pass',
                source: 'benchmark_host_test'
            });

            const response = await request(app).get('/api/benchmark/dashboard?includeUnavailableModels=true');
            expect(response.status).toBe(200);

            const row = response.body.data.model_stats.find((item) => item.model === 'aligned-model');
            expect(row).toBeTruthy();
            expect(row.host_test_status).toBe('pass');
            expect(row.host_test_freshness).toBe('fresh');
            expect(row.host_test_tokens_per_sec).toBe(108);
            expect(row.host_test_latency_ms).toBe(950);
            expect(row.host_test_vram_used_mib).toBe(8192);
            expect(row.recommended_category).toBe('knowledge');
            expect(row.manual_categories).toEqual(['generalist']);
        });

        it('should expose one dashboard composite score per real scoring category', async () => {
            await BenchmarkResult.create({
                model: 'category-honest-model',
                host: 'http://localhost:11434',
                prompt: 'Explain the tradeoffs',
                prompt_category: 'reasoning',
                latency: 1200,
                time_to_first_token_ms: 240,
                tokens: 180,
                tokens_per_sec: 90,
                success: true,
                quality_score: 8.2,
                composite_score: 82
            });

            const response = await request(app).get('/api/benchmark/dashboard?includeUnavailableModels=true');
            expect(response.status).toBe(200);

            const row = response.body.data.model_stats.find((item) => item.model === 'category-honest-model');
            expect(row).toBeTruthy();

            const expectedScoreKeys = Object.keys(CATEGORY_COMPOSITE_PROFILES)
                .map((category) => `${category}_score`)
                .sort();
            const actualScoreKeys = Object.keys(row)
                .filter((key) => key.endsWith('_score'))
                .sort();

            expect(actualScoreKeys).toEqual(expectedScoreKeys);
            expect(row).not.toHaveProperty('balanced_score');
            expect(row).not.toHaveProperty('interactive_score');
            expect(Number(row.avg_composite)).toBeGreaterThan(0);
        });

        it('should expose host test freshness and deltas when host data is missing or diverges', async () => {
            await BenchmarkResult.create([
                {
                    model: 'drift-model',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    latency: 1000,
                    tokens: 100,
                    tokens_per_sec: 100,
                    success: true
                },
                {
                    model: 'unverified-model',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    latency: 800,
                    tokens: 100,
                    tokens_per_sec: 90,
                    success: true
                }
            ]);

            await ModelProfile.create({
                name: 'drift-model',
                displayName: 'Drift Model'
            });

            await HostPerformanceSnapshot.create({
                modelName: 'drift-model',
                hostUrl: 'http://localhost:11434',
                hostId: 'primary',
                tokensPerSec: 40,
                latencyMs: 1600,
                timeToFirstTokenMs: 320,
                testedAt: new Date(),
                status: 'pass',
                source: 'benchmark_host_test'
            });

            const response = await request(app).get('/api/benchmark/dashboard?includeUnavailableModels=true');
            expect(response.status).toBe(200);

            const driftRow = response.body.data.model_stats.find((item) => item.model === 'drift-model');
            const unverifiedRow = response.body.data.model_stats.find((item) => item.model === 'unverified-model');

            expect(driftRow).toBeTruthy();
            expect(driftRow.host_test_status).toBe('pass');
            expect(driftRow.host_test_freshness).toBe('fresh');
            expect(driftRow.host_test_latency_delta_pct).toBeLessThan(-20);
            expect(driftRow.host_test_tokens_delta_pct).toBeGreaterThan(20);

            expect(unverifiedRow).toBeTruthy();
            expect(unverifiedRow.host_test_status).toBeNull();
            expect(unverifiedRow.host_test_freshness).toBe('missing');
            expect(unverifiedRow.host_test_tokens_per_sec).toBeNull();
            expect(unverifiedRow.host_test_latency_ms).toBeNull();
        });
    });

    describe('GET /api/benchmark/judge-breakdown', () => {
        it('should require judge_model', async () => {
            const response = await request(app).get('/api/benchmark/judge-breakdown');
            expect(response.status).toBe(400);
            expect(response.body.status).toBe('error');
            expect(response.body.error).toContain('judge_model');
        });

        it('should break down judge latency by prompt level', async () => {
            await BenchmarkResult.create([
                {
                    model: 'small-model',
                    host: 'http://localhost:11434',
                    prompt: 'P1',
                    prompt_level: 1,
                    tokens: 50,
                    success: true,
                    judge_model: 'judge-a',
                    judge_host: 'http://localhost:11435',
                    scoring_method: 'reasoning',
                    scoring_time_ms: 1000,
                    quality_score: 7.5
                },
                {
                    model: 'big-model',
                    host: 'http://localhost:11434',
                    prompt: 'P2',
                    prompt_level: 3,
                    tokens: 200,
                    success: true,
                    judge_model: 'judge-a',
                    judge_host: 'http://localhost:11435',
                    scoring_method: 'reasoning',
                    scoring_time_ms: 2000,
                    quality_score: 6.0
                },
                {
                    model: 'big-model',
                    host: 'http://localhost:11434',
                    prompt: 'P3',
                    prompt_level: 3,
                    tokens: 220,
                    success: true,
                    judge_model: 'judge-a',
                    judge_host: 'http://localhost:11435',
                    scoring_method: 'llm_failed',
                    scoring_time_ms: 2500,
                    quality_score: null
                }
            ]);

            const response = await request(app).get('/api/benchmark/judge-breakdown')
                .query({ judge_model: 'judge-a', judge_host: 'http://localhost:11435', groupBy: 'level' });

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.groupBy).toBe('level');
            expect(Array.isArray(response.body.data.groups)).toBe(true);

            const levels = response.body.data.groups.map(g => g.key);
            expect(levels).toEqual(expect.arrayContaining([1, 3]));
        });

        it('should break down judge latency by model-under-test (limited)', async () => {
            await BenchmarkResult.create([
                {
                    model: 'm1',
                    host: 'http://localhost:11434',
                    prompt: 'P1',
                    prompt_level: 1,
                    tokens: 10,
                    success: true,
                    judge_model: 'judge-b',
                    judge_host: null,
                    scoring_method: 'reasoning',
                    scoring_time_ms: 500,
                    quality_score: 8.0
                },
                {
                    model: 'm2',
                    host: 'http://localhost:11434',
                    prompt: 'P2',
                    prompt_level: 2,
                    tokens: 20,
                    success: true,
                    judge_model: 'judge-b',
                    judge_host: null,
                    scoring_method: 'reasoning',
                    scoring_time_ms: 700,
                    quality_score: 7.0
                }
            ]);

            const response = await request(app).get('/api/benchmark/judge-breakdown')
                .query({ judge_model: 'judge-b', groupBy: 'model', limit: 10 });

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.groupBy).toBe('model');
            expect(response.body.data.limit).toBe(10);
            const keys = response.body.data.groups.map(g => g.key);
            expect(keys).toEqual(expect.arrayContaining(['m1', 'm2']));
        });
    });

    describe('GET /api/benchmark/compare', () => {
        it('should require models parameter', async () => {
            const response = await request(app).get('/api/benchmark/compare');

            expect(response.status).toBe(400);
            expect(response.body.status).toBe('error');
            expect(response.body.error).toContain('models');
        });

        it('should compare multiple models', async () => {
            await BenchmarkResult.create([
                {
                    model: 'model-a',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    latency: 1000,
                    tokens: 100,
                    tokens_per_sec: 100,
                    success: true
                },
                {
                    model: 'model-b',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    latency: 1500,
                    tokens: 150,
                    tokens_per_sec: 100,
                    success: true
                }
            ]);

            const response = await request(app)
                .get('/api/benchmark/compare?models=model-a,model-b');

            expect(response.status).toBe(200);
            expect(response.body.data.comparison).toHaveLength(2);
            expect(response.body.data.comparison[0].model).toBe('model-a');
            expect(response.body.data.comparison[1].model).toBe('model-b');
        });
    });

    describe('POST /api/benchmark/batch', () => {
        beforeEach(async () => {
            // Seed prompts for batch tests
            await BenchmarkPrompt.create([
                {
                    name: 'Simple Test',
                    prompt: 'What is 1+1?',
                    level: 1,
                    category: 'math'
                },
                {
                    name: 'Complex Test',
                    prompt: 'Explain relativity',
                    level: 3,
                    category: 'reasoning'
                }
            ]);
        });

        it('should validate required fields', async () => {
            const response = await request(app)
                .post('/api/benchmark/batch')
                .send({ host: 'http://localhost:11434' }); // Missing models and levels

            expect(response.status).toBe(400);
            expect(response.body.status).toBe('error');
            expect(response.body.error).toContain('required');
        });

        it('should create batch with valid inputs', async () => {
            const response = await request(app)
                .post('/api/benchmark/batch')
                .send({
                    host: 'http://localhost:11434',
                    models: ['ax/test-model'],
                    levels: [1],
                    run_name: 'Test Batch',
                    judge_config: { host: 'http://localhost:11434', model: 'judge-model' }
                });

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data).toHaveProperty('batch_id');
            const promptsAtLevel1 = await BenchmarkPrompt.countDocuments({ level: 1 });
            expect(response.body.data.total_tests).toBe(promptsAtLevel1);

            // Verify batch was created in database
            const batch = await BenchmarkBatch.findById(response.body.data.batch_id);
            expect(batch).toBeTruthy();
            expect(batch.status).toBe('running');
            expect(batch.models).toEqual(['ax/test-model']);
        });

        it('should not report pending judge work immediately after launch', async () => {
            const response = await request(app)
                .post('/api/benchmark/batch')
                .send({
                    host: 'http://localhost:11434',
                    models: ['ax/test-model'],
                    levels: [1],
                    run_name: 'Judge Init Regression',
                    judge_config: { host: 'http://localhost:11434', model: 'judge-model' }
                });

            expect(response.status).toBe(200);

            const batchResponse = await request(app)
                .get(`/api/benchmark/batch/${response.body.data.batch_id}`)
                .expect(200);

            expect(batchResponse.body.status).toBe('success');
            expect(batchResponse.body.data.completed).toBe(0);
            expect(batchResponse.body.data.judge_total).toBe(0);
            expect(batchResponse.body.data.judge_completed).toBe(0);
            expect(batchResponse.body.data.judge_failed).toBe(0);
            expect(batchResponse.body.data.judge_stats).toMatchObject({
                total: 0,
                pending: 0,
                lag: 0,
                completed: 0,
                failed: 0
            });
        });

        it('should reject batch start when preflight fails', async () => {
            runPreflight.mockResolvedValueOnce({
                ready: false,
                issues: ['Judge reliability 0.52 is below minimum 0.60'],
                checks: {
                    hosts: [],
                    judge: {
                        ok: false,
                        blockers: ['Judge reliability 0.52 is below minimum 0.60'],
                        warnings: []
                    },
                    prompts: { ok: true, blockers: [], warnings: [] },
                    batches: { ok: true, orphanedBatches: [] }
                }
            });

            const response = await request(app)
                .post('/api/benchmark/batch')
                .send({
                    host: 'http://localhost:11434',
                    models: ['ax/test-model'],
                    levels: [1]
                });

            expect(response.status).toBe(422);
            expect(response.body.error).toBe('Benchmark preflight failed');
            expect(response.body.issues).toContain('Judge reliability 0.52 is below minimum 0.60');
        });

        it('should handle multiple models and levels', async () => {
            const response = await request(app)
                .post('/api/benchmark/batch')
                .send({
                    host: 'http://localhost:11434',
                    models: ['ax/model-a', 'ax/model-b'],
                    levels: [1, 3],
                    judge_config: { host: 'http://localhost:11434', model: 'judge-model' }
                });

            expect(response.status).toBe(200);
            const promptsAtLevels = await BenchmarkPrompt.countDocuments({ level: { $in: [1, 3] } });
            expect(response.body.data.total_tests).toBe(2 * promptsAtLevels);
        });

        it('should create a batch from exact prompt IDs when provided', async () => {
            const prompt = await BenchmarkPrompt.findOne({ name: 'Complex Test' }).lean();

            const response = await request(app)
                .post('/api/benchmark/batch')
                .send({
                    host: 'http://localhost:11434',
                    models: ['ax/model-a', 'ax/model-b'],
                    levels: [1, 3],
                    prompt_ids: [prompt._id.toString()],
                    judge_config: { host: 'http://localhost:11434', model: 'judge-model' }
                });

            expect(response.status).toBe(200);
            expect(response.body.data.total_tests).toBe(2);

            const batch = await BenchmarkBatch.findById(response.body.data.batch_id).lean();
            expect(batch.prompt_ids).toEqual([prompt._id.toString()]);
            expect(batch.plan.total_prompts).toBe(1);
            expect(batch.plan.categories).toHaveLength(1);
            expect(batch.plan.categories[0]).toEqual(expect.objectContaining({
                category: 'reasoning',
                prompt_count: 1,
                tests: 2
            }));
        });

        it('uses the explicit judge config during validation and preflight', async () => {
            validateJudgeModel.mockClear();
            runPreflight.mockClear();

            const response = await request(app)
                .post('/api/benchmark/batch')
                .send({
                    host: 'http://localhost:11434',
                    models: ['ax/test-model'],
                    levels: [1],
                    judge_config: {
                        host: 'http://judge-host:11434',
                        model: 'qwen2.5:14b-instruct'
                    }
                });

            expect(response.status).toBe(200);
            expect(validateJudgeModel).toHaveBeenCalledWith(
                'http://judge-host:11434',
                'qwen2.5:14b-instruct'
            );
            expect(runPreflight).toHaveBeenCalledWith(expect.objectContaining({
                judgeConfig: expect.objectContaining({
                    model: 'qwen2.5:14b-instruct',
                    host: 'http://judge-host:11434'
                })
            }));
        });

        it('should return 409 on duplicate-key race collision during start', async () => {
            await BenchmarkBatch.collection.createIndex(
                { active_slot: 1 },
                {
                    unique: true,
                    partialFilterExpression: {
                        active_slot: { $type: 'string' },
                        $or: [
                            { status: { $in: ['running', 'judging'] } },
                            { judge_status: 'running' }
                        ]
                    }
                }
            );

            await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['existing-model'],
                levels: [1],
                run_name: 'Existing Active',
                status: 'running',
                total_tests: 1,
                active_slot: 'benchmark_singleton'
            });

            const realGetActive = BenchmarkBatch.getActive.bind(BenchmarkBatch);
            const getActiveSpy = jest.spyOn(BenchmarkBatch, 'getActive')
                .mockImplementationOnce(() => [])
                .mockImplementation((...args) => realGetActive(...args));

            const response = await request(app)
                .post('/api/benchmark/batch')
                .send({
                    host: 'http://localhost:11434',
                    models: ['ax/new-model'],
                    levels: [1],
                    judge_config: { host: 'http://localhost:11434', model: 'judge-model' }
                });

            getActiveSpy.mockRestore();

            expect(response.status).toBe(409);
            expect(response.body.status).toBe('error');
            expect(response.body.error).toContain('already running');
        });

        it('should reject batch start when the execution host has an active profile job', async () => {
            activeProfileState.activeProfiles.set('profile-test', {
                status: 'running',
                modelName: 'ax/profiled-model',
                hostId: 'local',
                hostUrl: 'http://localhost:11434',
                depth: 'quick',
                currentStep: 'throughput',
                stepsCompleted: 1,
                stepsTotal: 5,
                startedAt: Date.now()
            });

            const response = await request(app)
                .post('/api/benchmark/batch')
                .send({
                    host: 'http://localhost:11434',
                    models: ['ax/test-model'],
                    levels: [1],
                    judge_config: { host: 'http://localhost:11434', model: 'judge-model' }
                });

            expect(response.status).toBe(409);
            expect(response.body.code).toBe('EXECUTION_HOST_PROFILING');
            expect(response.body.active_profiling).toHaveLength(1);
            expect(await BenchmarkBatch.countDocuments({ run_name: { $ne: 'Existing Active' } })).toBe(0);
        });

        it('should reject batch start when the execution host has an active profile queue', async () => {
            activeProfileState.activeProfileQueues.set('queue-test', {
                status: 'running',
                hostId: 'local',
                hostUrl: 'http://localhost:11434',
                hostName: 'local',
                depth: 'quick',
                currentIndex: 0,
                total: 2,
                models: [{ name: 'ax/model-a', status: 'running' }, { name: 'ax/model-b', status: 'pending' }],
                startedAt: Date.now()
            });

            const response = await request(app)
                .post('/api/benchmark/batch')
                .send({
                    host: 'http://localhost:11434',
                    models: ['ax/test-model'],
                    levels: [1],
                    judge_config: { host: 'http://localhost:11434', model: 'judge-model' }
                });

            expect(response.status).toBe(409);
            expect(response.body.code).toBe('EXECUTION_HOST_PROFILING');
            expect(response.body.active_profiling[0]).toMatchObject({
                type: 'profile-host',
                queueId: 'queue-test',
                currentModel: 'ax/model-a'
            });
            expect(await BenchmarkBatch.countDocuments()).toBe(0);
        });
    });

    describe('GET /api/benchmark/batch/:id', () => {
        it('should return 404 for non-existent batch', async () => {
            const fakeId = new mongoose.Types.ObjectId();
            const response = await request(app).get(`/api/benchmark/batch/${fakeId}`);

            expect(response.status).toBe(404);
            expect(response.body.status).toBe('error');
        });

        it('should return batch details', async () => {
            const batch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['test-model'],
                levels: [1],
                run_name: 'Test Batch',
                total_tests: 5,
                status: 'completed'
            });

            const response = await request(app).get(`/api/benchmark/batch/${batch._id}`);

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.run_name).toBe('Test Batch');
            expect(response.body.data.status).toBe('completed');
            expect(response.body.data).toHaveProperty('progress');
            expect(response.body.data).toHaveProperty('success_rate');
        });

        it('should reconcile persisted batch counters from actual results', async () => {
            const batch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['test-model'],
                levels: [1],
                run_name: 'Counter Drift Batch',
                total_tests: 2,
                status: 'completed',
                completed: 0,
                failed: 0
            });

            await BenchmarkResult.create([
                {
                    batch_id: batch._id.toString(),
                    model: 'test-model',
                    host: 'http://localhost:11434',
                    prompt: 'p1',
                    prompt_name: 'P1',
                    prompt_level: 1,
                    prompt_category: 'math',
                    response: 'ok',
                    latency: 100,
                    tokens: 10,
                    success: true
                },
                {
                    batch_id: batch._id.toString(),
                    model: 'test-model',
                    host: 'http://localhost:11434',
                    prompt: 'p2',
                    prompt_name: 'P2',
                    prompt_level: 1,
                    prompt_category: 'math',
                    error: 'boom',
                    latency: 150,
                    tokens: 8,
                    success: false
                }
            ]);

            const response = await request(app).get(`/api/benchmark/batch/${batch._id}`);
            expect(response.status).toBe(200);
            expect(response.body.data.completed).toBe(2);
            expect(response.body.data.failed).toBe(1);
            expect(response.body.data._countMismatch).toBe(true);

            const refreshed = await BenchmarkBatch.findById(batch._id).lean();
            expect(refreshed.completed).toBe(2);
            expect(refreshed.failed).toBe(1);
        });

        it('should omit heavy result fields by default and include them when requested', async () => {
            const batch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['test-model'],
                levels: [1],
                run_name: 'Payload Batch',
                total_tests: 1,
                status: 'completed'
            });

            await BenchmarkResult.create({
                batch_id: batch._id.toString(),
                model: 'test-model',
                host: 'http://localhost:11434',
                prompt: 'What is 2+2?',
                prompt_name: 'Math',
                prompt_level: 1,
                prompt_category: 'math',
                response: '4',
                latency: 123,
                tokens: 5,
                success: true,
                judge_raw_response: '{"score":10}',
                hardware_snapshot: { backend: 'cuda', quantization: 'q4' },
                execution_settings: { num_predict: 32 },
                warmup: { prompt: 'Hi', response: 'Hello' },
                judge_warmup: { prompt: 'Judge', response: 'Done' }
            });

            const compact = await request(app).get(`/api/benchmark/batch/${batch._id}`);
            expect(compact.status).toBe(200);
            expect(compact.body.data.results).toHaveLength(1);
            expect(compact.body.data.results[0].prompt).toBeUndefined();
            expect(compact.body.data.results[0].response).toBeUndefined();
            expect(compact.body.data.results[0].prompt_preview).toContain('Math');
            expect(compact.body.data.results[0].judge_raw_response).toBeUndefined();
            expect(compact.body.data.results[0].hardware_snapshot).toBeUndefined();
            expect(compact.body.data.results[0].execution_settings).toBeUndefined();
            expect(compact.body.data.results[0].warmup).toBeUndefined();
            expect(compact.body.data.results[0].judge_warmup).toBeUndefined();

            const fullText = await request(app).get(`/api/benchmark/batch/${batch._id}?include_full_text=1`);
            expect(fullText.status).toBe(200);
            expect(fullText.body.data.results).toHaveLength(1);
            expect(fullText.body.data.results[0].prompt).toBe('What is 2+2?');
            expect(fullText.body.data.results[0].response).toBe('4');
            expect(fullText.body.data.results[0].judge_raw_response).toBeUndefined();

            const full = await request(app).get(`/api/benchmark/batch/${batch._id}?include_heavy=1`);
            expect(full.status).toBe(200);
            expect(full.body.data.results).toHaveLength(1);
            expect(full.body.data.results[0].judge_raw_response).toBe('{"score":10}');
            expect(full.body.data.results[0].hardware_snapshot).toMatchObject({ backend: 'cuda' });
            expect(full.body.data.results[0].execution_settings).toMatchObject({ num_predict: 32 });
            expect(full.body.data.results[0].warmup).toBeTruthy();
            expect(full.body.data.results[0].judge_warmup).toBeTruthy();
        });

        it('should support paginated result payloads with results_meta', async () => {
            const batch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['test-model'],
                levels: [1],
                run_name: 'Paginated Batch',
                total_tests: 3,
                status: 'completed',
                completed: 3,
                failed: 0
            });

            await BenchmarkResult.create([
                {
                    batch_id: batch._id.toString(),
                    model: 'test-model',
                    host: 'http://localhost:11434',
                    prompt: 'p1',
                    prompt_name: 'P1',
                    prompt_level: 1,
                    prompt_category: 'math',
                    response: 'r1',
                    latency: 100,
                    tokens: 10,
                    success: true
                },
                {
                    batch_id: batch._id.toString(),
                    model: 'test-model',
                    host: 'http://localhost:11434',
                    prompt: 'p2',
                    prompt_name: 'P2',
                    prompt_level: 1,
                    prompt_category: 'math',
                    response: 'r2',
                    latency: 110,
                    tokens: 11,
                    success: true
                },
                {
                    batch_id: batch._id.toString(),
                    model: 'test-model',
                    host: 'http://localhost:11434',
                    prompt: 'p3',
                    prompt_name: 'P3',
                    prompt_level: 1,
                    prompt_category: 'math',
                    response: 'r3',
                    latency: 120,
                    tokens: 12,
                    success: true
                }
            ]);

            const response = await request(app)
                .get(`/api/benchmark/batch/${batch._id}?result_limit=2&result_offset=1`);

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.completed).toBe(3);
            expect(response.body.data.results).toHaveLength(2);
            expect(response.body.data.results_meta).toMatchObject({
                returned: 2,
                total: 3,
                offset: 1,
                limit: 2,
                truncated: false
            });
        });

        it('should include full per_model_counters even when results are paginated', async () => {
            const batch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['model-a', 'model-b'],
                levels: [1],
                run_name: 'Per Model Counters Batch',
                total_tests: 3,
                status: 'completed',
                completed: 3,
                failed: 1,
                judge_total: 3,
                judge_completed: 2
            });

            await BenchmarkResult.create([
                {
                    batch_id: batch._id.toString(),
                    model: 'model-a',
                    host: 'http://localhost:11434',
                    prompt: 'p1',
                    prompt_name: 'P1',
                    prompt_level: 1,
                    prompt_category: 'math',
                    response: 'r1',
                    latency: 100,
                    tokens: 10,
                    quality_score: 9,
                    success: true
                },
                {
                    batch_id: batch._id.toString(),
                    model: 'model-a',
                    host: 'http://localhost:11434',
                    prompt: 'p2',
                    prompt_name: 'P2',
                    prompt_level: 1,
                    prompt_category: 'math',
                    response: 'r2',
                    latency: 110,
                    tokens: 11,
                    quality_score: 8,
                    success: true
                },
                {
                    batch_id: batch._id.toString(),
                    model: 'model-b',
                    host: 'http://localhost:11434',
                    prompt: 'p3',
                    prompt_name: 'P3',
                    prompt_level: 1,
                    prompt_category: 'reasoning',
                    error: 'boom',
                    latency: 150,
                    tokens: 5,
                    scoring_method: 'exec_failed',
                    success: false
                }
            ]);

            const response = await request(app)
                .get(`/api/benchmark/batch/${batch._id}?result_limit=1`);

            expect(response.status).toBe(200);
            expect(response.body.data.results_meta).toMatchObject({
                returned: 1,
                total: 3,
                truncated: true
            });
            expect(response.body.data.per_model_counters).toBeTruthy();
            expect(response.body.data.per_model_counters['model-a']).toMatchObject({
                exec_done: 2,
                exec_failed: 0,
                judge_done: 2,
                judge_failed: 0
            });
            expect(response.body.data.per_model_counters['model-b']).toMatchObject({
                exec_done: 1,
                exec_failed: 1,
                judge_done: 0,
                judge_failed: 1
            });
        });
    });

    describe('GET /api/benchmark/batches', () => {
        it('should return empty list when no batches exist', async () => {
            const response = await request(app).get('/api/benchmark/batches');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            // Service returns { batches: [], total: 0 }
            expect(response.body.data.batches).toBeInstanceOf(Array);
            expect(response.body.data.batches).toHaveLength(0);
        });

        it('should return recent batches sorted by creation time', async () => {
            // Create batches with different timestamps
            const olderBatch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['model-1'],
                levels: [1],
                run_name: 'Older Batch',
                status: 'completed',
                total_tests: 1,
                created_at: new Date(Date.now() - 10000)
            });

            const newerBatch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['model-2'],
                levels: [1],
                run_name: 'Newer Batch',
                status: 'running',
                total_tests: 1,
                created_at: new Date()
            });

            const response = await request(app).get('/api/benchmark/batches');

            expect(response.status).toBe(200);
            expect(response.body.data.batches).toHaveLength(2);
            // Should be sorted by created_at desc (newer first)
            expect(response.body.data.batches[0]._id.toString()).toBe(newerBatch._id.toString());
            expect(response.body.data.batches[1]._id.toString()).toBe(olderBatch._id.toString());
        });

        it('should respect limit parameter', async () => {
            // Create 5 batches
            const batches = [];
            for (let i = 0; i < 5; i++) {
                batches.push({
                    host: 'http://localhost:11434',
                    models: ['test-model'],
                    levels: [1],
                    run_name: `Batch ${i}`,
                    status: 'completed',
                    total_tests: 1
                });
            }
            await BenchmarkBatch.create(batches);

            const response = await request(app).get('/api/benchmark/batches?limit=3');

            expect(response.status).toBe(200);
            expect(response.body.data.batches).toHaveLength(3);
            expect(response.body.data.total).toBe(5);
        });

        it('should filter batches by an exact tag', async () => {
            await BenchmarkBatch.create([
                {
                    host: 'http://localhost:11434',
                    models: ['planning-model'],
                    levels: [1],
                    run_name: 'Planning batch',
                    status: 'completed',
                    total_tests: 1,
                    tags: ['planning:agentx:benchmark-capability']
                },
                {
                    host: 'http://localhost:11434',
                    models: ['other-model'],
                    levels: [1],
                    run_name: 'Other batch',
                    status: 'completed',
                    total_tests: 1,
                    tags: ['other']
                }
            ]);

            const response = await request(app)
                .get('/api/benchmark/batches?tag=planning%3Aagentx%3Abenchmark-capability&limit=1');

            expect(response.status).toBe(200);
            expect(response.body.data.total).toBe(1);
            expect(response.body.data.batches).toHaveLength(1);
            expect(response.body.data.batches[0].run_name).toBe('Planning batch');
        });
    });

    describe('POST /api/benchmark/batch/:id/stop', () => {
        it('should stop a running batch', async () => {
            const batch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['stop-model'],
                levels: [1],
                run_name: 'Stop Me',
                status: 'running',
                total_tests: 1
            });

            const response = await request(app).post(`/api/benchmark/batch/${batch._id}/stop`);

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.status).toBe('stopped');
            expect(response.body.data.already_stopped).toBe(false);

            const refreshed = await BenchmarkBatch.findById(batch._id).lean();
            expect(refreshed.status).toBe('stopped');
        });
    });

    describe('POST /api/benchmark/batch/:id/recover', () => {
        it('should recover a running batch by reconciling counters and clearing current state', async () => {
            const batch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['recover-model'],
                levels: [1],
                run_name: 'Recover Me',
                status: 'running',
                judge_status: 'running',
                total_tests: 3,
                completed: 0,
                failed: 0,
                judge_total: 99,
                judge_completed: 12,
                judge_failed: 8,
                active_slot: 'benchmark_singleton',
                current_test: {
                    model: 'recover-model',
                    prompt_id: 'prompt-1',
                    prompt_name: 'Recover Prompt',
                    prompt_level: 1,
                    stage: 'executing',
                    started_at: new Date(),
                    test_number: 2
                }
            });

            await BenchmarkResult.create([
                {
                    batch_id: batch._id.toString(),
                    model: 'recover-model',
                    host: 'http://localhost:11434',
                    prompt: 'Prompt A',
                    prompt_name: 'Recover Prompt A',
                    prompt_level: 1,
                    prompt_category: 'reasoning',
                    response: 'Useful answer',
                    latency: 120,
                    tokens: 16,
                    success: true,
                    scoring_method: 'llm_judge'
                },
                {
                    batch_id: batch._id.toString(),
                    model: 'recover-model',
                    host: 'http://localhost:11434',
                    prompt: 'Prompt B',
                    prompt_name: 'Recover Prompt B',
                    prompt_level: 1,
                    prompt_category: 'reasoning',
                    error: 'Execution failed',
                    latency: 95,
                    tokens: 0,
                    success: false,
                    scoring_method: 'exec_failed'
                },
                {
                    batch_id: batch._id.toString(),
                    model: 'recover-model',
                    host: 'http://localhost:11434',
                    prompt: 'Prompt C',
                    prompt_name: 'Recover Prompt C',
                    prompt_level: 1,
                    prompt_category: 'reasoning',
                    response: 'Needs judging',
                    latency: 140,
                    tokens: 20,
                    success: true,
                    scoring_method: 'pending'
                }
            ]);

            const response = await request(app).post(`/api/benchmark/batch/${batch._id}/recover`);

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.message).toContain('stopped');
            expect(response.body.data.completed).toBe(3);
            expect(response.body.data.failed).toBe(1);
            expect(response.body.data.judge_total).toBe(2);
            expect(response.body.data.judge_completed).toBe(1);
            expect(response.body.data.judge_status).toBe('stopped');

            const refreshed = await BenchmarkBatch.findById(batch._id).lean();
            expect(refreshed.status).toBe('stopped');
            expect(refreshed.completed).toBe(3);
            expect(refreshed.failed).toBe(1);
            expect(refreshed.judge_total).toBe(2);
            expect(refreshed.judge_completed).toBe(1);
            expect(refreshed.judge_failed).toBe(0);
            expect(refreshed.judge_status).toBe('stopped');
            expect(refreshed.active_slot).toBeNull();
            expect(refreshed.current_test).toMatchObject({
                model: null,
                prompt_id: null,
                prompt_name: null,
                prompt_level: null,
                stage: 'idle',
                started_at: null,
                test_number: null
            });
        });
    });

    describe('BenchmarkBatch.cleanupStale', () => {
        it('should reconcile stale interrupted batches from authoritative result counts', async () => {
            const batch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['stale-model'],
                levels: [1],
                run_name: 'Stale Batch',
                status: 'running',
                judge_status: 'running',
                total_tests: 3,
                completed: 0,
                failed: 0,
                judge_total: 50,
                judge_completed: 4,
                judge_failed: 2,
                active_slot: 'benchmark_singleton',
                current_test: {
                    model: 'stale-model',
                    prompt_id: 'prompt-stale',
                    prompt_name: 'Stale Prompt',
                    prompt_level: 1,
                    stage: 'judging',
                    started_at: new Date(),
                    test_number: 3
                },
                last_activity_at: null
            });

            await BenchmarkResult.create([
                {
                    batch_id: batch._id.toString(),
                    model: 'stale-model',
                    host: 'http://localhost:11434',
                    prompt: 'Prompt A',
                    prompt_name: 'A',
                    prompt_level: 1,
                    prompt_category: 'reasoning',
                    response: 'Scored',
                    latency: 100,
                    tokens: 10,
                    success: true,
                    scoring_method: 'llm_judge'
                },
                {
                    batch_id: batch._id.toString(),
                    model: 'stale-model',
                    host: 'http://localhost:11434',
                    prompt: 'Prompt B',
                    prompt_name: 'B',
                    prompt_level: 1,
                    prompt_category: 'reasoning',
                    response: 'Pending',
                    latency: 120,
                    tokens: 12,
                    success: true,
                    scoring_method: 'pending'
                },
                {
                    batch_id: batch._id.toString(),
                    model: 'stale-model',
                    host: 'http://localhost:11434',
                    prompt: 'Prompt C',
                    prompt_name: 'C',
                    prompt_level: 1,
                    prompt_category: 'reasoning',
                    error: 'boom',
                    latency: 90,
                    tokens: 0,
                    success: false,
                    scoring_method: 'exec_failed'
                }
            ]);

            const cleaned = await BenchmarkBatch.cleanupStale(0);

            expect(cleaned).toBe(1);

            const refreshed = await BenchmarkBatch.findById(batch._id).lean();
            expect(refreshed.status).toBe('interrupted');
            expect(refreshed.judge_status).toBe('failed');
            expect(refreshed.completed).toBe(3);
            expect(refreshed.failed).toBe(1);
            expect(refreshed.judge_total).toBe(2);
            expect(refreshed.judge_completed).toBe(1);
            expect(refreshed.judge_failed).toBe(0);
            expect(refreshed.active_slot).toBeNull();
            expect(refreshed.current_test.stage).toBe('idle');
        });

        it('should auto-complete stale batches that already finished execution and judging', async () => {
            const batch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['finished-model'],
                levels: [1],
                run_name: 'Finished But Stale',
                status: 'running',
                judge_status: 'running',
                total_tests: 2,
                active_slot: 'benchmark_singleton',
                last_activity_at: null
            });

            await BenchmarkResult.create([
                {
                    batch_id: batch._id.toString(),
                    model: 'finished-model',
                    host: 'http://localhost:11434',
                    prompt: 'Prompt A',
                    prompt_name: 'A',
                    prompt_level: 1,
                    prompt_category: 'reasoning',
                    response: 'Done',
                    latency: 110,
                    tokens: 14,
                    success: true,
                    scoring_method: 'llm_judge'
                },
                {
                    batch_id: batch._id.toString(),
                    model: 'finished-model',
                    host: 'http://localhost:11434',
                    prompt: 'Prompt B',
                    prompt_name: 'B',
                    prompt_level: 1,
                    prompt_category: 'reasoning',
                    response: 'Judge failed',
                    latency: 150,
                    tokens: 18,
                    success: true,
                    scoring_method: 'llm_failed'
                }
            ]);

            const cleaned = await BenchmarkBatch.cleanupStale(0);

            expect(cleaned).toBe(1);

            const refreshed = await BenchmarkBatch.findById(batch._id).lean();
            expect(refreshed.status).toBe('completed');
            expect(refreshed.judge_status).toBe('completed');
            expect(refreshed.completed).toBe(2);
            expect(refreshed.failed).toBe(0);
            expect(refreshed.judge_total).toBe(2);
            expect(refreshed.judge_completed).toBe(2);
            expect(refreshed.judge_failed).toBe(1);
            expect(refreshed.active_slot).toBeNull();
        });
    });

    describe('POST /api/benchmark/batch/:id/judge', () => {
        it('should enqueue judging request and return immediately', async () => {
            const batch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['judge-model'],
                levels: [1],
                run_name: 'Judge Me',
                status: 'completed',
                total_tests: 1
            });

            await BenchmarkResult.create({
                batch_id: batch._id.toString(),
                model: 'judge-model',
                host: 'http://localhost:11434',
                prompt: 'Judge this',
                prompt_name: 'Judge Prompt',
                prompt_level: 1,
                prompt_category: 'reasoning',
                success: true,
                scoring_method: 'pending',
                response: 'This is a response to evaluate.'
            });

            const response = await request(app)
                .post(`/api/benchmark/batch/${batch._id}/judge`)
                .send({ concurrency: 1, force: false });

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.message).toContain('Judging started in background');
            expect(response.body.data.pending_count).toBe(1);
            await wait(75);
        });

        it('should return 409 when trying to judge a running batch', async () => {
            const batch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['judge-model-running'],
                levels: [1],
                run_name: 'Judge Running',
                status: 'running',
                total_tests: 1
            });

            const response = await request(app)
                .post(`/api/benchmark/batch/${batch._id}/judge`)
                .send({ concurrency: 1 });

            expect(response.status).toBe(409);
            expect(response.body.status).toBe('error');
            expect(response.body.error).toContain('still running');
        });

        it('should return 400 when no pending results exist', async () => {
            const batch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['judge-model-none'],
                levels: [1],
                run_name: 'Judge None',
                status: 'completed',
                total_tests: 1
            });

            const response = await request(app)
                .post(`/api/benchmark/batch/${batch._id}/judge`)
                .send({ force: false });

            expect(response.status).toBe(400);
            expect(response.body.status).toBe('error');
            expect(response.body.error).toContain('No pending');
        });
    });

    describe('GET /api/benchmark/batch/:id/judge/status', () => {
        it('should return persisted judge status counters', async () => {
            const batch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['judge-status-model'],
                levels: [1],
                run_name: 'Judge Status Batch',
                status: 'completed',
                total_tests: 2,
                judge_status: 'completed',
                judge_total: 2,
                judge_completed: 2,
                judge_failed: 1
            });

            const response = await request(app).get(`/api/benchmark/batch/${batch._id}/judge/status`);

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.active).toBe(false);
            expect(response.body.data.judge_status).toBe('completed');
            expect(response.body.data.judge_total).toBe(2);
            expect(response.body.data.judge_completed).toBe(2);
            expect(response.body.data.judge_failed).toBe(1);
        });
    });

    describe('POST /api/benchmark/batch/:id/rejudge-pending', () => {
        it('should enqueue rejudge request and return immediately', async () => {
            const batch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['rejudge-model'],
                levels: [1],
                run_name: 'Rejudge Me',
                status: 'completed',
                total_tests: 1
            });

            await BenchmarkResult.create({
                batch_id: batch._id.toString(),
                model: 'rejudge-model',
                host: 'http://localhost:11434',
                prompt: 'Retry judge',
                prompt_name: 'Retry Prompt',
                prompt_level: 1,
                prompt_category: 'reasoning',
                success: true,
                scoring_method: 'pending',
                response: 'Rejudge this response.'
            });

            const response = await request(app)
                .post(`/api/benchmark/batch/${batch._id}/rejudge-pending`)
                .send({ concurrency: 1 });

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.message).toContain('Judging started in background');
            expect(response.body.data.pending_count).toBe(1);
            await wait(75);
        });

        it('should return 400 when no pending results exist for rejudge', async () => {
            const batch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['rejudge-model-none'],
                levels: [1],
                run_name: 'Rejudge None',
                status: 'completed',
                total_tests: 1
            });

            const response = await request(app)
                .post(`/api/benchmark/batch/${batch._id}/rejudge-pending`)
                .send({ concurrency: 1 });

            expect(response.status).toBe(400);
            expect(response.body.status).toBe('error');
            expect(response.body.error).toContain('No pending');
        });
    });

    describe('GET /api/benchmark/results/advanced', () => {
        it('should support advanced filtering and pagination', async () => {
            const batchId = new mongoose.Types.ObjectId().toString();
            await BenchmarkResult.create([
                {
                    batch_id: batchId,
                    model: 'advanced-model-a',
                    host: 'http://localhost:11434',
                    prompt: 'Prompt A',
                    prompt_name: 'Prompt A',
                    prompt_category: 'math',
                    prompt_level: 2,
                    latency: 400,
                    tokens: 40,
                    quality_score: 8.8,
                    scoring_method: 'reasoning',
                    success: true
                },
                {
                    batch_id: batchId,
                    model: 'advanced-model-b',
                    host: 'http://localhost:11434',
                    prompt: 'Prompt B',
                    prompt_name: 'Prompt B',
                    prompt_category: 'reasoning',
                    prompt_level: 5,
                    latency: 900,
                    tokens: 90,
                    quality_score: 6.1,
                    scoring_method: 'llm_failed',
                    success: false
                }
            ]);

            const response = await request(app)
                .get('/api/benchmark/results/advanced')
                .query({
                    batchId,
                    categories: 'math',
                    levelMin: 1,
                    levelMax: 3,
                    qualityMin: 8,
                    success: 'true',
                    limit: 10,
                    offset: 0
                });

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.total).toBe(1);
            expect(response.body.data.results).toHaveLength(1);
            expect(response.body.data.results[0].model).toBe('advanced-model-a');
            expect(response.body.data.hasMore).toBe(false);
        });

        it('should clamp limit and sanitize unsupported sort field', async () => {
            await BenchmarkResult.create({
                model: 'advanced-limit-model',
                host: 'http://localhost:11434',
                prompt: 'Prompt C',
                prompt_name: 'Prompt C',
                prompt_category: 'math',
                prompt_level: 2,
                latency: 200,
                tokens: 20,
                quality_score: 9.1,
                scoring_method: 'reasoning',
                success: true
            });

            const response = await request(app)
                .get('/api/benchmark/results/advanced')
                .query({
                    limit: 999999,
                    offset: -50,
                    sort: '__proto__',
                    sortDir: 'asc'
                });

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.limit).toBe(5000);
            expect(response.body.data.offset).toBe(0);
            expect(response.body.data.sort).toBe('timestamp');
            expect(response.body.data.sortDir).toBe('asc');
        });
    });

    describe('POST /api/benchmark/results/:id/human-review', () => {
        it('should persist human review score and reviewer', async () => {
            const result = await BenchmarkResult.create({
                model: 'human-reviewed-model',
                host: 'http://localhost:11434',
                prompt: 'Review this output',
                response: 'Sample response',
                latency: 300,
                tokens: 30,
                quality_score: 7.0,
                success: true
            });

            const response = await request(app)
                .post(`/api/benchmark/results/${result._id}/human-review`)
                .send({ action: 'override', human_score: 9.5, reviewer: 'qa-reviewer' });

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.action).toBe('overridden');
            expect(response.body.data.human_score).toBe(9.5);
            expect(response.body.data.human_reviewed_at).toBeTruthy();

            const refreshed = await BenchmarkResult.findById(result._id).lean();
            expect(refreshed.human_score).toBe(9.5);
            expect(refreshed.human_reviewer).toBe('qa-reviewer');
            expect(refreshed.human_review_status).toBe('overridden');
            expect(refreshed.human_reviewed_at).toBeTruthy();
        });

        it('should approve a result using the judge score', async () => {
            const result = await BenchmarkResult.create({
                model: 'approved-model',
                host: 'http://localhost:11434',
                prompt: 'Approve this output',
                response: 'Sample response',
                latency: 300,
                tokens: 30,
                quality_score: 6.5,
                needs_review: true,
                review_reason: 'low confidence',
                success: true
            });

            const response = await request(app)
                .post(`/api/benchmark/results/${result._id}/human-review`)
                .send({ action: 'approve', reviewer: 'qa-reviewer' });

            expect(response.status).toBe(200);
            expect(response.body.data.action).toBe('approved');
            expect(response.body.data.human_score).toBe(6.5);

            const refreshed = await BenchmarkResult.findById(result._id).lean();
            expect(refreshed.human_review_status).toBe('approved');
            expect(refreshed.human_score).toBe(6.5);
            expect(refreshed.needs_review).toBe(false);
            expect(refreshed.review_reason).toBeNull();
            expect(refreshed.excluded_from_leaderboard).toBe(false);
        });

        it('should reject a result and exclude it from leaderboard calculations', async () => {
            const result = await BenchmarkResult.create({
                model: 'rejected-model',
                host: 'http://localhost:11434',
                prompt: 'Reject this output',
                response: 'Broken response',
                prompt_category: 'reasoning',
                latency: 300,
                tokens: 30,
                quality_score: 2.0,
                needs_review: true,
                review_reason: 'anomaly',
                success: true
            });

            const response = await request(app)
                .post(`/api/benchmark/results/${result._id}/human-review`)
                .send({ action: 'reject', reviewer: 'qa-reviewer', notes: 'invalid prompt/response pair' });

            expect(response.status).toBe(200);
            expect(response.body.data.action).toBe('rejected');
            expect(response.body.data.excluded_from_leaderboard).toBe(true);

            const refreshed = await BenchmarkResult.findById(result._id).lean();
            expect(refreshed.human_review_status).toBe('rejected');
            expect(refreshed.human_score).toBeNull();
            expect(refreshed.needs_review).toBe(false);
            expect(refreshed.excluded_from_leaderboard).toBe(true);
            expect(refreshed.review_reason).toContain('Rejected by human review');
        });

        // 0129 — calibration loop hookup
        it('writes a JudgeGroundTruth entry when a reviewer overrides (source: courthouse-review)', async () => {
            const result = await BenchmarkResult.create({
                model: 'loop-override-model',
                host: 'http://localhost:11434',
                prompt: '0129 override prompt',
                response: 'override response',
                prompt_category: 'coding',
                prompt_level: 3,
                latency: 10, tokens: 5,
                quality_score: 7.0,
                success: true
            });

            const response = await request(app)
                .post(`/api/benchmark/results/${result._id}/human-review`)
                .send({ action: 'override', human_score: 4.0, reviewer: 'yb' });

            expect(response.status).toBe(200);
            expect(response.body.data.ground_truth_id).toBeTruthy();

            const gt = await JudgeGroundTruth.findOne({
                name: `courthouse-review-${result._id}`
            }).lean();
            expect(gt).toBeTruthy();
            expect(gt.source).toBe('courthouse-review');
            expect(gt.reviewer).toBe('yb');
            expect(gt.expert_scores.overall).toBe(4.0);
            expect(gt.judge_score_at_review).toBe(7.0);
            expect(String(gt.source_result_id)).toBe(String(result._id));
            expect(gt.category).toBe('coding');
        });

        it('is idempotent on re-review — overwrites the same ground truth entry', async () => {
            const result = await BenchmarkResult.create({
                model: 'loop-idem-model',
                host: 'http://localhost:11434',
                prompt: '0129 idem prompt',
                response: 'idem response',
                prompt_category: 'reasoning',
                prompt_level: 2,
                latency: 10, tokens: 5,
                quality_score: 5.0,
                success: true
            });

            await request(app)
                .post(`/api/benchmark/results/${result._id}/human-review`)
                .send({ action: 'override', human_score: 3.0, reviewer: 'r1' });
            await request(app)
                .post(`/api/benchmark/results/${result._id}/human-review`)
                .send({ action: 'override', human_score: 8.0, reviewer: 'r2' });

            const entries = await JudgeGroundTruth.find({
                name: `courthouse-review-${result._id}`
            }).lean();
            expect(entries).toHaveLength(1);
            expect(entries[0].expert_scores.overall).toBe(8.0);
            expect(entries[0].reviewer).toBe('r2');
        });

        it('does NOT write a ground-truth entry on reject (no usable human_score)', async () => {
            const result = await BenchmarkResult.create({
                model: 'loop-reject-model',
                host: 'http://localhost:11434',
                prompt: '0129 reject prompt',
                response: 'reject response',
                prompt_category: 'knowledge',
                prompt_level: 1,
                latency: 10, tokens: 5,
                quality_score: 2.0,
                success: true
            });

            await request(app)
                .post(`/api/benchmark/results/${result._id}/human-review`)
                .send({ action: 'reject', reviewer: 'r3', notes: 'broken' });

            const entry = await JudgeGroundTruth.findOne({
                name: `courthouse-review-${result._id}`
            }).lean();
            expect(entry).toBeNull();
        });
    });

    describe('GET /api/benchmark/generalist-leaderboard', () => {
        it('should return generalist leaderboard data from benchmark results', async () => {
            await BenchmarkPrompt.create([
                {
                    name: 'Coding Prompt',
                    prompt: 'Write a helper function',
                    level: 2,
                    category: 'coding'
                },
                {
                    name: 'Reasoning Prompt',
                    prompt: 'Solve a logic puzzle',
                    level: 3,
                    category: 'reasoning'
                }
            ]);

            await BenchmarkResult.create([
                {
                    model: 'generalist-model',
                    host: 'http://localhost:11434',
                    prompt: 'Code task',
                    prompt_name: 'Code task',
                    prompt_category: 'coding',
                    prompt_level: 3,
                    quality_score: 8.0,
                    success: true
                },
                {
                    model: 'generalist-model',
                    host: 'http://localhost:11434',
                    prompt: 'Reasoning task',
                    prompt_name: 'Reasoning task',
                    prompt_category: 'reasoning',
                    prompt_level: 4,
                    quality_score: 7.5,
                    success: true
                }
            ]);

            const response = await request(app).get('/api/benchmark/generalist-leaderboard?axis=quality&includeUnavailableModels=true');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(Array.isArray(response.body.data.leaderboard)).toBe(true);
            expect(response.body.data.categoryWeights).toBeTruthy();
            expect(response.body.data.categoryWeights).toHaveProperty('coding');
            expect(response.body.data.categoryWeights).toHaveProperty('reasoning');
            expect(response.body.data.categoryWeights).not.toHaveProperty('refactoring');
            expect(response.body.data.leaderboard.length).toBeGreaterThan(0);
            expect(response.body.data.leaderboard[0]).toHaveProperty('generalistScore');
        });

        it('can scope the generalist leaderboard to currently configured hosts', async () => {
            const envKeys = [
                'OLLAMA_HOST',
                'OLLAMA_HOST_1',
                'OLLAMA_HOST_PRIMARY',
                'OLLAMA_HOST_2',
                'OLLAMA_HOST_HEAVY',
                'OLLAMA_HOST_SECONDARY',
                'OLLAMA_HOST_3',
                'OLLAMA_HOST_TERTIARY'
            ];
            const previousEnv = {};
            for (const key of envKeys) {
                previousEnv[key] = process.env[key];
                delete process.env[key];
            }
            process.env.OLLAMA_HOST = 'http://current-host.test:11434';

            try {
                await BenchmarkPrompt.create({
                    name: 'Reasoning Prompt',
                    prompt: 'Solve a logic puzzle',
                    level: 3,
                    category: 'reasoning'
                });

                await BenchmarkResult.create([
                    {
                        model: 'current-host-model',
                        host: 'http://current-host.test:11434',
                        prompt: 'Reasoning task',
                        prompt_name: 'Reasoning task',
                        prompt_category: 'reasoning',
                        prompt_level: 3,
                        quality_score: 7.5,
                        success: true,
                        excluded_from_leaderboard: false
                    },
                    {
                        model: 'retired-host-model',
                        host: 'http://retired-host.test:11434',
                        prompt: 'Reasoning task',
                        prompt_name: 'Reasoning task',
                        prompt_category: 'reasoning',
                        prompt_level: 3,
                        quality_score: 9.5,
                        success: true,
                        excluded_from_leaderboard: false
                    }
                ]);

                const currentResponse = await request(app)
                    .get('/api/benchmark/generalist-leaderboard?axis=quality&hostScope=current&includeUnavailableModels=true');

                expect(currentResponse.status).toBe(200);
                expect(currentResponse.body.data.hostScope).toBe('current');
                expect(currentResponse.body.data.hostFilterApplied).toBe(true);
                expect(currentResponse.body.data.configuredHosts).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({ url: 'http://current-host.test:11434' })
                    ])
                );

                const currentModels = currentResponse.body.data.leaderboard.map((row) => row.model);
                expect(currentModels).toContain('current-host-model');
                expect(currentModels).not.toContain('retired-host-model');

                const allResponse = await request(app)
                    .get('/api/benchmark/generalist-leaderboard?axis=quality&hostScope=all&includeUnavailableModels=true');
                const allModels = allResponse.body.data.leaderboard.map((row) => row.model);
                expect(allResponse.body.data.hostScope).toBe('all');
                expect(allResponse.body.data.hostFilterApplied).toBe(false);
                expect(allModels).toEqual(expect.arrayContaining([
                    'current-host-model',
                    'retired-host-model'
                ]));
            } finally {
                for (const key of envKeys) {
                    if (previousEnv[key] === undefined) delete process.env[key];
                    else process.env[key] = previousEnv[key];
                }
            }
        });

        // 0117 — contract-v1 §2.7 defense-in-depth: infra-failed rows must never surface
        // on a leaderboard regardless of other fields (success / quality_score).
        it('should exclude rows with infra_error:true even when success:false (0117)', async () => {
            await BenchmarkPrompt.create([
                {
                    name: 'Reasoning Prompt',
                    prompt: 'Solve a logic puzzle',
                    level: 3,
                    category: 'reasoning'
                }
            ]);

            await BenchmarkResult.create([
                // A clean, successful scored row (must appear)
                {
                    model: 'clean-model',
                    host: 'http://localhost:11434',
                    prompt: 'Reasoning task',
                    prompt_name: 'Reasoning task',
                    prompt_category: 'reasoning',
                    prompt_level: 3,
                    quality_score: 7.5,
                    success: true,
                    infra_error: false
                },
                // Infra-failed row — success:false matches the contract for infra failures;
                // quality_score:10 is synthetic to prove the infra flag (not the success flag)
                // is what excludes the row.
                {
                    model: 'infra-failed-model',
                    host: 'http://localhost:11434',
                    prompt: 'Reasoning task',
                    prompt_name: 'Reasoning task',
                    prompt_category: 'reasoning',
                    prompt_level: 3,
                    quality_score: 10,
                    success: false,
                    infra_error: true,
                    error_type: 'infra',
                    error: 'ECONNREFUSED'
                }
            ]);

            const response = await request(app).get('/api/benchmark/generalist-leaderboard?axis=quality&includeUnavailableModels=true');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');

            const models = response.body.data.leaderboard.map((row) => row.model);
            expect(models).toContain('clean-model');
            expect(models).not.toContain('infra-failed-model');
        });

        // 0117 — contract-v1 §2.7 defense-in-depth: the (shouldn't-happen) case where
        // infra_error:true is set on a success:true row must still be excluded.
        it('should exclude rows with infra_error:true even when success:true (0117)', async () => {
            await BenchmarkPrompt.create([
                {
                    name: 'Reasoning Prompt',
                    prompt: 'Solve a logic puzzle',
                    level: 3,
                    category: 'reasoning'
                }
            ]);

            await BenchmarkResult.create([
                {
                    model: 'clean-model',
                    host: 'http://localhost:11434',
                    prompt: 'Reasoning task',
                    prompt_name: 'Reasoning task',
                    prompt_category: 'reasoning',
                    prompt_level: 3,
                    quality_score: 7.5,
                    success: true,
                    infra_error: false
                },
                {
                    model: 'bad-flag-model',
                    host: 'http://localhost:11434',
                    prompt: 'Reasoning task',
                    prompt_name: 'Reasoning task',
                    prompt_category: 'reasoning',
                    prompt_level: 3,
                    quality_score: 9.5,
                    success: true,
                    infra_error: true // corrupt combination — infra exclusion must still win
                }
            ]);

            const response = await request(app).get('/api/benchmark/generalist-leaderboard?axis=quality&includeUnavailableModels=true');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');

            const models = response.body.data.leaderboard.map((row) => row.model);
            expect(models).toContain('clean-model');
            expect(models).not.toContain('bad-flag-model');
        });

        it('should exclude rows rejected by human review from the leaderboard', async () => {
            await BenchmarkPrompt.create([
                {
                    name: 'Reasoning Prompt',
                    prompt: 'Solve a logic puzzle',
                    level: 3,
                    category: 'reasoning'
                }
            ]);

            await BenchmarkResult.create([
                {
                    model: 'clean-model',
                    host: 'http://localhost:11434',
                    prompt: 'Reasoning task',
                    prompt_name: 'Reasoning task',
                    prompt_category: 'reasoning',
                    prompt_level: 3,
                    quality_score: 7.5,
                    success: true,
                    excluded_from_leaderboard: false
                },
                {
                    model: 'rejected-model',
                    host: 'http://localhost:11434',
                    prompt: 'Reasoning task',
                    prompt_name: 'Reasoning task',
                    prompt_category: 'reasoning',
                    prompt_level: 3,
                    quality_score: 9.5,
                    success: true,
                    human_review_status: 'rejected',
                    excluded_from_leaderboard: true
                }
            ]);

            const response = await request(app).get('/api/benchmark/generalist-leaderboard?axis=quality&includeUnavailableModels=true');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');

            const models = response.body.data.leaderboard.map((row) => row.model);
            expect(models).toContain('clean-model');
            expect(models).not.toContain('rejected-model');
        });
    });

    describe('DELETE /api/benchmark/results', () => {
        it('should clear all results', async () => {
            // Create test results
            await BenchmarkResult.create([
                {
                    model: 'test-model',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    latency: 1000,
                    tokens: 100,
                    success: true
                },
                {
                    model: 'test-model-2',
                    host: 'http://localhost:11434',
                    prompt: 'Test 2',
                    latency: 2000,
                    tokens: 200,
                    success: true
                }
            ]);

            const response = await request(app)
                .delete('/api/benchmark/results')
                .send({ confirm: 'DELETE_ALL' });

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.message).toContain('Cleared 2 results');

            // Verify results were deleted
            const count = await BenchmarkResult.countDocuments();
            expect(count).toBe(0);
        });
    });

    describe('DELETE /api/benchmark/results/failed', () => {
        it('should clear only failed results', async () => {
            await BenchmarkResult.create([
                {
                    model: 'ok-model',
                    host: 'http://localhost:11434',
                    prompt: 'success',
                    latency: 100,
                    tokens: 20,
                    success: true
                },
                {
                    model: 'bad-model',
                    host: 'http://localhost:11434',
                    prompt: 'failure',
                    error: 'boom',
                    success: false
                }
            ]);

            const response = await request(app)
                .delete('/api/benchmark/results/failed')
                .send({ confirm: 'DELETE_FAILED' });

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.message).toContain('failed results');

            const remaining = await BenchmarkResult.find().lean();
            expect(remaining).toHaveLength(1);
            expect(remaining[0].success).toBe(true);
        });
    });

    describe('GET /api/benchmark/quality-breakdown', () => {
        it('should return quality breakdown by category and level', async () => {
            await BenchmarkResult.create([
                {
                    model: 'test-model',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    prompt_level: 1,
                    prompt_category: 'math',
                    latency: 1000,
                    tokens: 100,
                    quality_score: 8.5,  // Changed from 85 to match 0-10 scale
                    composite_score: 90,
                    success: true
                },
                {
                    model: 'test-model',
                    host: 'http://localhost:11434',
                    prompt: 'Test 2',
                    prompt_level: 2,
                    prompt_category: 'reasoning',
                    latency: 1500,
                    tokens: 150,
                    quality_score: 7.5,  // Changed from 75 to match 0-10 scale
                    composite_score: 80,
                    success: true
                }
            ]);

            const response = await request(app).get('/api/benchmark/quality-breakdown');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data).toHaveProperty('overall');
            expect(response.body.data).toHaveProperty('by_category');
            expect(response.body.data).toHaveProperty('by_level');
            expect(response.body.data.categories).toEqual(expect.arrayContaining(['math', 'reasoning']));
            expect(response.body.data.levels).toEqual(expect.arrayContaining([1, 2]));
        });
    });
});
