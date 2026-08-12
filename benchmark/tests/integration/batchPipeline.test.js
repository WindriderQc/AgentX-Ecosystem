/**
 * Batch Pipeline Integration Tests
 * Tests the full executeBatch happy path against isolated MongoMemoryServer.
 * All external HTTP calls (Ollama, judge) are mocked.
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// -------------------------------------------------------------------
// Mocks — must be defined before requiring production modules
// -------------------------------------------------------------------

jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// The claim lifecycle is exercised by dedicated unit tests. Keep this
// integration suite isolated from the live Core control plane.
jest.mock('../../src/clients/coreApiClient', () => ({
    claimHostForBenchmark: jest.fn(async () => ({ claimed: true })),
    releaseBenchmarkClaim: jest.fn(async () => ({ released: true }))
}));

// Mock Ollama HTTP: returns a canned model response for every call
const mockBenchmarkFetch = jest.fn();
jest.mock('../../src/services/benchmark/http', () => ({
    benchmarkFetch: mockBenchmarkFetch
}));

// Contract resolution is a separate Core service-to-service dependency. Its
// endpoint/fingerprint semantics are covered by inferenceContractSnapshot's
// focused tests; this pipeline suite owns only model/judge execution and must
// not reinterpret its mocked Ollama response as a Core contract response.
jest.mock('../../src/services/benchmark/inferenceContractSnapshot', () => ({
    loadOrResolveCampaignInferenceContracts: jest.fn(async () => ({
        requestFingerprint: 'f'.repeat(64),
        responseMode: 'final_only',
        candidates: []
    })),
    getFrozenModelExecutionConfig: jest.fn((_campaign, _model, _host, baseConfig = {}) => ({
        ...baseConfig,
        num_ctx: 8192,
        response_max_tokens: 4096,
        think: false,
        send_think: true,
        think_mode: 'final_only',
        rankable_mode: true,
        inference_contract_fingerprint: 'a'.repeat(64),
        artifact_digest: 'sha256:test-artifact'
    })),
    assertFrozenArtifactDigest: jest.fn(async () => 'sha256:test-artifact')
}));

jest.mock('../../src/helpers/httpAgent', () => ({
    getFetchOptions: (url, opts) => opts
}));

// Mock judgeResult so we do not make real judge HTTP calls
jest.mock('../../src/services/benchmark/judgeExecutor', () => ({
    judgeResult: jest.fn(async (resultId, judgeConfig) => ({
        quality_score: 7.5,
        scoring_method: 'llm_judge',
        judge_model: judgeConfig.model || 'test-judge'
    })),
    applyScoresToResult: jest.fn()
}));

// Mock model warmup — no Ollama calls needed for these tests
jest.mock('../../src/services/benchmark/modelWarmup', () => ({
    warmupModel: jest.fn(async () => ({
        prompt: 'warmup',
        response: 'ok',
        latency_ms: 10,
        already_loaded: true
    }))
}));

// hardwareProfileService removed — profiler handles hardware detection now

// Mock host test service — used for performance baseline
jest.mock('../../src/services/hostTestService', () => ({
    testModelOnHost: jest.fn(async () => ({
        status: 'ok',
        tokensPerSec: 50,
        latencyMs: 200
    }))
}));

// Mock judgeHostResolution — use the execution host as judge host
jest.mock('../../src/services/benchmark/judgeHostResolution', () => ({
    resolveJudgeHost: jest.fn((hostUrl) => ({
        judgeHost: hostUrl,
        resolution: 'default'
    }))
}));

// Mock qualityScorer JUDGE_CONFIG
jest.mock('../../src/services/qualityScorer', () => ({
    JUDGE_CONFIG: { model: 'test-judge', host: 'http://localhost:11434' },
    scoreResponse: jest.fn(async () => ({
        quality_score: 7.5,
        scoring_method: 'llm_judge'
    })),
    calculateCompositeScore: jest.fn(() => ({ composite: 65, quality: 7.5 }))
}));

// Mock modelContextResolver
jest.mock('../../src/services/modelContextResolver', () => ({
    resolveModelNumCtx: jest.fn(async (model, opts) => opts.fallback || 8192),
    resolveModelNumCtxDetails: jest.fn(async (model, opts) => ({
        num_ctx: opts.fallback || 8192,
        source: 'test_fallback',
        authoritative: false
    }))
}));

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function mockOllamaResponse(responseText = 'This is a test response.') {
    return {
        ok: true,
        json: async () => ({
            message: { content: responseText },
            done_reason: 'stop',
            eval_count: 20,
            response: responseText
        })
    };
}

function mockOllamaAbort() {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    return Promise.reject(err);
}

// -------------------------------------------------------------------
// Setup
// -------------------------------------------------------------------

const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkResult = require('../../models/BenchmarkResult');
const BenchmarkPrompt = require('../../models/BenchmarkPrompt');

const { executeBatch, clearActiveBatch } = require('../../src/services/benchmark/execution');

const HOST = 'http://localhost:11434';
const MODEL = 'test-model:3b';
// Unique namespace to isolate this test's data
const TEST_RUN_PREFIX = `batchPipeline-test-${Date.now()}`;

let testPrompts = [];
let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    // Defensive cleanup: a previous run that crashed mid-execution can leave a
    // benchmarkbatches doc with active_slot='benchmark_singleton', which then
    // collides with our new inserts via the partial unique index on active_slot.
    // The whole suite owns this slot, so clearing it on entry is safe.
    await BenchmarkBatch.deleteMany({ active_slot: 'benchmark_singleton' });
}, 15000);

afterAll(async () => {
    // Clean up test data created by this suite
    await BenchmarkBatch.deleteMany({ run_name: new RegExp(TEST_RUN_PREFIX) });
    await BenchmarkBatch.deleteMany({ active_slot: 'benchmark_singleton' });
    await BenchmarkResult.deleteMany({ prompt_name: new RegExp(TEST_RUN_PREFIX) });
    await BenchmarkPrompt.deleteMany({ name: new RegExp(TEST_RUN_PREFIX) });
    await mongoose.disconnect();
    await mongoServer.stop();
});

beforeEach(async () => {
    jest.clearAllMocks();
    clearActiveBatch();

    // Seed prompts with a unique prefix for this test run
    testPrompts = await BenchmarkPrompt.insertMany([
        {
            name: `${TEST_RUN_PREFIX}-alpha`,
            prompt: 'What is 2+2?',
            level: 1,
            category: 'math',
            expected_answer: '4'
        },
        {
            name: `${TEST_RUN_PREFIX}-beta`,
            prompt: 'Name the capital of France.',
            level: 1,
            category: 'knowledge',
            expected_answer: 'Paris'
        }
    ]);
});

afterEach(async () => {
    clearActiveBatch();
    // Clean up per-test documents
    await BenchmarkBatch.deleteMany({ run_name: new RegExp(TEST_RUN_PREFIX) });
    await BenchmarkResult.deleteMany({ prompt_name: new RegExp(TEST_RUN_PREFIX) });
    await BenchmarkPrompt.deleteMany({ name: new RegExp(TEST_RUN_PREFIX) });
});

async function createTestBatch(overrides = {}) {
    const batch = new BenchmarkBatch({
        run_name: `${TEST_RUN_PREFIX}-run`,
        host: HOST,
        models: [MODEL],
        levels: [1],
        status: 'running',
        total_tests: testPrompts.length,
        active_slot: 'benchmark_singleton',
        started_at: new Date(),
        ...overrides
    });
    await batch.save();
    return batch;
}

// -------------------------------------------------------------------
// Test cases
// -------------------------------------------------------------------

describe('Batch pipeline — happy path', () => {
    it('creates batch in running state and transitions to completed', async () => {
        mockBenchmarkFetch.mockResolvedValue(mockOllamaResponse());

        const batch = await createTestBatch();
        await executeBatch(batch._id.toString(), HOST, [MODEL], testPrompts, {});

        const finalBatch = await BenchmarkBatch.findById(batch._id);
        expect(finalBatch.status).toBe('completed');
    }, 30000);

    it('executes all prompts and creates results for each', async () => {
        mockBenchmarkFetch.mockResolvedValue(mockOllamaResponse());

        const batch = await createTestBatch();
        await executeBatch(batch._id.toString(), HOST, [MODEL], testPrompts, {});

        const resultCount = await BenchmarkResult.countDocuments({
            batch_id: batch._id.toString()
        });
        expect(resultCount).toBe(testPrompts.length);
    }, 30000);

    it('all results are associated with the batch', async () => {
        mockBenchmarkFetch.mockResolvedValue(mockOllamaResponse());

        const batch = await createTestBatch();
        await executeBatch(batch._id.toString(), HOST, [MODEL], testPrompts, {});

        const results = await BenchmarkResult.find({ batch_id: batch._id.toString() });
        for (const result of results) {
            expect(String(result.batch_id)).toBe(batch._id.toString());
            expect(result.model).toBe(MODEL);
            expect(result.host).toBe(HOST);
        }
    }, 30000);

    it('persists the per-batch judge model over the default judge config', async () => {
        mockBenchmarkFetch.mockResolvedValue(mockOllamaResponse());

        const batch = await createTestBatch({
            judge_config: {
                model: 'bar',
                host: 'http://judge-host:11434'
            }
        });

        await executeBatch(batch._id.toString(), HOST, [MODEL], testPrompts, {
            judge_config: {
                model: 'bar',
                host: 'http://judge-host:11434'
            }
        });

        const results = await BenchmarkResult.find({ batch_id: batch._id.toString() }).lean();
        expect(results).toHaveLength(testPrompts.length);
        expect(results.every((result) => result.judge_model === 'bar')).toBe(true);
    }, 30000);

    it('all successful results have valid quality_score (number in [0,10] or null)', async () => {
        mockBenchmarkFetch.mockResolvedValue(mockOllamaResponse());

        const batch = await createTestBatch();
        await executeBatch(batch._id.toString(), HOST, [MODEL], testPrompts, {});

        const results = await BenchmarkResult.find({
            batch_id: batch._id.toString(),
            success: true
        });

        for (const result of results) {
            if (result.quality_score !== null && result.quality_score !== undefined) {
                expect(typeof result.quality_score).toBe('number');
                expect(result.quality_score).toBeGreaterThanOrEqual(0);
                expect(result.quality_score).toBeLessThanOrEqual(10);
            }
        }
    }, 30000);

    it('batch tracks judge_completed count after execution', async () => {
        mockBenchmarkFetch.mockResolvedValue(mockOllamaResponse());

        const batch = await createTestBatch();
        await executeBatch(batch._id.toString(), HOST, [MODEL], testPrompts, {});

        const finalBatch = await BenchmarkBatch.findById(batch._id);
        expect(typeof finalBatch.judge_completed).toBe('number');
        expect(finalBatch.judge_completed).toBeGreaterThanOrEqual(0);
    }, 30000);
});

describe('Batch pipeline — error handling', () => {
    it('handles model timeout gracefully — batch still completes with partial results', async () => {
        mockBenchmarkFetch
            .mockResolvedValueOnce(mockOllamaResponse())
            .mockImplementationOnce(() => mockOllamaAbort());

        const batch = await createTestBatch();
        await executeBatch(batch._id.toString(), HOST, [MODEL], testPrompts, {});

        const finalBatch = await BenchmarkBatch.findById(batch._id);
        expect(['completed', 'running', 'failed']).toContain(finalBatch.status);

        const resultCount = await BenchmarkResult.countDocuments({
            batch_id: batch._id.toString()
        });
        expect(resultCount).toBeGreaterThan(0);
    }, 30000);

    it('handles judge failure gracefully — batch still completes', async () => {
        const { judgeResult } = require('../../src/services/benchmark/judgeExecutor');
        judgeResult.mockRejectedValueOnce(new Error('Judge service unavailable'));

        mockBenchmarkFetch.mockResolvedValue(mockOllamaResponse());

        const batch = await createTestBatch({ total_tests: 1 });
        const singlePrompt = [testPrompts[0]];
        await executeBatch(batch._id.toString(), HOST, [MODEL], singlePrompt, {});

        const finalBatch = await BenchmarkBatch.findById(batch._id);
        expect(finalBatch.status).toBe('completed');
    }, 30000);

    it('does not crash when batch ID is not found during lock acquisition', async () => {
        mockBenchmarkFetch.mockResolvedValue(mockOllamaResponse());

        const fakeId = new mongoose.Types.ObjectId().toString();
        await executeBatch(fakeId, HOST, [MODEL], testPrompts, {});
        // Should return without throwing
    }, 30000);
});
