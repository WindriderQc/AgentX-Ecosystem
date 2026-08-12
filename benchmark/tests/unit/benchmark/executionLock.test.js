/**
 * Unit tests for execution lock logic in execution.js
 * Tests lock acquisition, heartbeat lifecycle, and batch state transitions
 *
 * Strategy: mock all Mongoose models and external services so tests are fast
 * and deterministic. We test the exported executeBatch function at the boundary
 * of BenchmarkBatch.findOneAndUpdate (lock) and related DB operations.
 */

jest.mock('../../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// Mock the batch orchestrator — we only want to test execution.js internals
jest.mock('../../../src/services/benchmark/batchOrchestrator', () => ({
    runBatchOrchestrator: jest.fn(async () => {})
}));

// Mock config normalization
jest.mock('../../../src/services/benchmark/config', () => ({
    normalizeExecutionConfig: jest.fn(cfg => cfg || {}),
    applyLengthHint: jest.fn((prompt) => prompt),
    buildPromptHints: jest.fn((prompt) => ({
        promptText: prompt,
        applied: false,
        hintText: null,
        lengthHintApplied: false,
        answerContract: { applied: false, text: null, target_tokens: null, max_tokens: null, mode: 'off' }
    }))
}));

// Mock all the other dependencies execution.js imports
jest.mock('../../../src/services/qualityScorer', () => ({
    JUDGE_CONFIG: { model: 'test-judge' }
}));


jest.mock('../../../src/services/benchmark/init', () => ({
    seedPrompts: jest.fn(async () => {})
}));

jest.mock('../../../src/services/modelContextResolver', () => ({
    resolveModelNumCtx: jest.fn(async (model, opts) => opts.fallback || 8192)
}));

jest.mock('../../../src/services/benchmark/promptSampling', () => ({
    samplePromptsByDepth: jest.fn((prompts) => prompts)
}));

jest.mock('../../../src/services/benchmark/testExecution', () => ({
    runTest: jest.fn(async () => ({}))
}));

jest.mock('../../../src/services/benchmark/batchPlanner', () => ({
    buildExecutionPlan: jest.fn(() => ({
        plan: [],
        normalizedExecutionConfig: {}
    }))
}));

// All mock variables prefixed with 'mock' to satisfy jest.mock factory scope rules
jest.mock('../../../models/BenchmarkBatch', () => ({
    findOneAndUpdate: jest.fn(),
    findById: jest.fn(),
    updateOne: jest.fn(async () => ({ matchedCount: 1 })),
    distinct: jest.fn(async () => [])
}));

jest.mock('../../../models/BenchmarkResult', () => ({
    distinct: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    countDocuments: jest.fn(async () => 0)
}));

jest.mock('../../../models/BenchmarkTimelineEntry', () => ({
    create: jest.fn(async () => ({})),
    insertMany: jest.fn(async () => []),
    find: jest.fn(() => ({ sort: jest.fn(() => ({ lean: jest.fn(async () => []) })) })),
    deleteMany: jest.fn(async () => ({ deletedCount: 0 }))
}));

jest.mock('../../../models/BenchmarkPrompt', () => ({
    getByLevels: jest.fn(async () => [
        { _id: 'p1', name: 'Prompt 1', prompt: 'Test?', level: 1, category: 'reasoning' }
    ])
}));

const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { executeBatch, getActiveBatchId, clearActiveBatch } = require('../../../src/services/benchmark/execution');
const { runBatchOrchestrator } = require('../../../src/services/benchmark/batchOrchestrator');
const logger = require('../../../config/logger');

const BATCH_ID = 'batch-test-001';
const DEFAULT_HOST = 'http://localhost:11434';
const MODELS = ['llama3.2:3b'];
const PROMPTS = [
    { _id: 'p1', name: 'Prompt 1', prompt: 'Test?', level: 1, category: 'reasoning' }
];

function makeBatchDoc(overrides = {}) {
    return {
        _id: BATCH_ID,
        status: 'running',
        execution_pid: null,
        execution_started_at: null,
        total_tests: 1,
        execution_config: {},
        save: jest.fn(async () => {}),
        clearCurrentTest: jest.fn(async () => {}),
        markAsCompleted: jest.fn(async () => {}),
        calculateMetrics: jest.fn(async () => {}),
        ...overrides
    };
}

function makeSelectableBatchDoc(status = 'running', overrides = {}) {
    const doc = makeBatchDoc({ ...overrides });
    doc.select = jest.fn().mockReturnThis();
    doc.lean = jest.fn().mockReturnValue({ status });
    return doc;
}

beforeEach(() => {
    jest.clearAllMocks();
    BenchmarkBatch.findOneAndUpdate.mockReset();
    BenchmarkBatch.findById.mockReset();
    BenchmarkBatch.updateOne.mockReset();
    clearActiveBatch();
    // Default: findById returns a runnable batch
    BenchmarkBatch.findById.mockImplementation(() => makeSelectableBatchDoc('running'));
    BenchmarkBatch.updateOne.mockResolvedValue({ matchedCount: 1 });
});

// -------------------------------------------------------------------
// Lock acquisition
// -------------------------------------------------------------------

describe('Execution lock acquisition', () => {
    it('acquires lock on batch with no execution_started_at', async () => {
        BenchmarkBatch.findOneAndUpdate.mockResolvedValueOnce(makeBatchDoc());

        await executeBatch(BATCH_ID, DEFAULT_HOST, MODELS, PROMPTS, {});

        expect(BenchmarkBatch.findOneAndUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ _id: BATCH_ID }),
            expect.objectContaining({ $set: expect.objectContaining({ execution_started_at: expect.any(Date) }) }),
            expect.any(Object)
        );
    });

    it('rejects lock when batch is already locked — skips execution', async () => {
        // findOneAndUpdate returns null when lock is held by another process
        BenchmarkBatch.findOneAndUpdate.mockResolvedValueOnce(null);
        BenchmarkBatch.findById.mockResolvedValueOnce(makeBatchDoc({ execution_pid: 99999 }));

        await executeBatch(BATCH_ID, DEFAULT_HOST, MODELS, PROMPTS, {});

        expect(runBatchOrchestrator).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'Skipping duplicate batch execution - already locked',
            expect.any(Object)
        );
    });

    it('re-acquires lock on abandoned batch — logs re-acquisition warning', async () => {
        // findOneAndUpdate returns a batch with a different pid (abandoned lock)
        BenchmarkBatch.findOneAndUpdate.mockResolvedValueOnce(
            makeBatchDoc({ execution_pid: 12345 })
        );

        await executeBatch(BATCH_ID, DEFAULT_HOST, MODELS, PROMPTS, {});

        expect(logger.warn).toHaveBeenCalledWith(
            'Re-acquiring execution lock for abandoned batch',
            expect.any(Object)
        );
    });
});

// -------------------------------------------------------------------
// Heartbeat lifecycle
// -------------------------------------------------------------------

describe('Heartbeat — stops when batch status changes', () => {
    it('heartbeat stops when updateOne returns matchedCount=0', async () => {
        jest.useFakeTimers();

        BenchmarkBatch.findOneAndUpdate.mockResolvedValueOnce(makeBatchDoc());
        // Heartbeat updateOne returns matchedCount=0 to trigger stop
        BenchmarkBatch.updateOne.mockResolvedValue({ matchedCount: 0 });

        const execPromise = executeBatch(BATCH_ID, DEFAULT_HOST, MODELS, PROMPTS, {});
        // Advance past 10s heartbeat interval
        jest.advanceTimersByTime(15000);
        await Promise.resolve();

        jest.useRealTimers();
        await execPromise;

        // Key assertion: execution completes without crash despite heartbeat stopping
        expect(runBatchOrchestrator).toHaveBeenCalled();
    });
});

// -------------------------------------------------------------------
// Batch lifecycle
// -------------------------------------------------------------------

describe('Batch lifecycle', () => {
    it('batch completes successfully after orchestration', async () => {
        BenchmarkBatch.findOneAndUpdate.mockResolvedValueOnce(makeBatchDoc());

        await executeBatch(BATCH_ID, DEFAULT_HOST, MODELS, PROMPTS, {});

        expect(runBatchOrchestrator).toHaveBeenCalledTimes(1);
    });

    it('marks batch as failed when exec_failed cells reach the terminal threshold', async () => {
        const lockedBatch = makeBatchDoc();
        const finalBatch = makeBatchDoc({
            total_tests: 4,
            completed: 4,
            failed: 1
        });

        BenchmarkBatch.findOneAndUpdate.mockResolvedValueOnce(lockedBatch);
        BenchmarkBatch.findById
            .mockImplementationOnce(() => makeSelectableBatchDoc('running'))
            .mockImplementationOnce(() => finalBatch);

        await executeBatch(BATCH_ID, DEFAULT_HOST, MODELS, PROMPTS, {});

        // 0209: outcome helper returns failure_reason alongside status.
        expect(finalBatch.markAsCompleted).toHaveBeenCalledWith('failed', 'high_failure_rate');
    });

    it('marks batch as failed/zero_cells_executed when no cells ran (0209)', async () => {
        const lockedBatch = makeBatchDoc();
        const finalBatch = makeBatchDoc({
            total_tests: 315,
            completed: 0,
            failed: 0
        });

        BenchmarkBatch.findOneAndUpdate.mockResolvedValueOnce(lockedBatch);
        BenchmarkBatch.findById
            .mockImplementationOnce(() => makeSelectableBatchDoc('running'))
            .mockImplementationOnce(() => finalBatch);

        await executeBatch(BATCH_ID, DEFAULT_HOST, MODELS, PROMPTS, {});

        expect(finalBatch.markAsCompleted).toHaveBeenCalledWith('failed', 'zero_cells_executed');
    });

    it('marks batch as failed when orchestrator throws', async () => {
        BenchmarkBatch.findOneAndUpdate.mockResolvedValueOnce(makeBatchDoc());
        runBatchOrchestrator.mockRejectedValueOnce(new Error('orchestrator crash'));

        await expect(
            executeBatch(BATCH_ID, DEFAULT_HOST, MODELS, PROMPTS, {})
        ).rejects.toThrow('orchestrator crash');

        // Should have called updateOne to set status: 'failed'
        const failCall = BenchmarkBatch.updateOne.mock.calls.find(
            ([, update]) => update?.$set?.status === 'failed'
        );
        expect(failCall).toBeDefined();
    });

    it('clears active batch ID after execution completes', async () => {
        BenchmarkBatch.findOneAndUpdate.mockResolvedValueOnce(makeBatchDoc());

        await executeBatch(BATCH_ID, DEFAULT_HOST, MODELS, PROMPTS, {});

        expect(getActiveBatchId()).toBeNull();
    });

    it('records execution_crash timeline event on failure', async () => {
        const BenchmarkTimelineEntry = require('../../../models/BenchmarkTimelineEntry');
        BenchmarkBatch.findOneAndUpdate.mockResolvedValueOnce(makeBatchDoc());
        runBatchOrchestrator.mockRejectedValueOnce(new Error('crash event test'));

        await expect(
            executeBatch(BATCH_ID, DEFAULT_HOST, MODELS, PROMPTS, {})
        ).rejects.toThrow();

        // Verify the execution_crash event was written to the external timeline collection
        const crashCall = BenchmarkTimelineEntry.create.mock.calls.find(
            ([entry]) => entry?.event === 'execution_crash'
        );
        expect(crashCall).toBeDefined();
    });

    it('does not call orchestrator when batch is not found after lock miss', async () => {
        BenchmarkBatch.findOneAndUpdate.mockResolvedValueOnce(null);
        // findById returns null — batch was deleted
        BenchmarkBatch.findById.mockResolvedValueOnce(null);

        await executeBatch(BATCH_ID, DEFAULT_HOST, MODELS, PROMPTS, {});

        expect(runBatchOrchestrator).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
            'Batch not found',
            expect.any(Object)
        );
    });
});
