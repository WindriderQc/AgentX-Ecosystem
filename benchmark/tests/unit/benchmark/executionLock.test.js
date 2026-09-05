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
    runBatchOrchestrator: jest.fn(async () => {}),
    abortActiveBatchRequests: jest.fn(() => ({ abortedRequestCount: 0 }))
}));

jest.mock('../../../src/clients/coreApiClient', () => ({
    acquireWorkloadAdmission: jest.fn(async () => ({ acquired: true, idempotent: true })),
    heartbeatWorkloadAdmission: jest.fn(async () => ({ heartbeat: true })),
    releaseWorkloadAdmission: jest.fn(async () => ({ released: true })),
    getWorkloadRecoveryIdentity: jest.fn(workloadId => ({
        recoveryId: `recovery-${workloadId}`,
        recoveryRequestId: `recovery-request-${workloadId}`,
        admissionId: `admission-${workloadId}`,
        generation: `generation-${workloadId}`,
        principal: 'benchmark-service'
    })),
    transitionWorkloadRecovery: jest.fn(async () => ({ transitioned: true }))
}));

jest.mock('../../../src/services/benchmark/benchmarkClaimLifecycle', () => ({
    startBenchmarkClaimHeartbeat: jest.fn(() => {
        const stop = jest.fn();
        stop.ready = Promise.resolve();
        stop.drain = jest.fn(async () => {});
        stop.getFailure = jest.fn(() => null);
        stop.assertActive = jest.fn(() => true);
        return stop;
    })
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
    collection: { indexes: jest.fn() },
    findOneAndUpdate: jest.fn(),
    findById: jest.fn(),
    updateOne: jest.fn(async () => ({ matchedCount: 1 })),
    finalizeTrustEvidenceBatch: jest.fn(),
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
const {
    assertTrustCampaignSpecOneShotIndex,
    executeBatch,
    stopBatch,
    getActiveBatchId,
    clearActiveBatch
} = require('../../../src/services/benchmark/execution');
const { runBatchOrchestrator, abortActiveBatchRequests } = require('../../../src/services/benchmark/batchOrchestrator');
const coreApiClient = require('../../../src/clients/coreApiClient');
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
        reconcileFromResults: jest.fn(async function() { return this; }),
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
    BenchmarkBatch.finalizeTrustEvidenceBatch.mockReset();
    BenchmarkBatch.collection.indexes.mockReset();
    BenchmarkBatch.collection.indexes.mockResolvedValue([{
        name: 'uniq_benchmark_batch_trust_campaign_spec_id',
        key: { trust_campaign_spec_id: 1 },
        unique: true,
        partialFilterExpression: { trust_campaign_spec_id: { $type: 'string' } }
    }]);
    clearActiveBatch();
    // Default: findById returns a runnable batch
    BenchmarkBatch.findById.mockImplementation(() => makeSelectableBatchDoc('running'));
    BenchmarkBatch.updateOne.mockResolvedValue({ matchedCount: 1 });
    BenchmarkBatch.finalizeTrustEvidenceBatch.mockResolvedValue(makeBatchDoc({ status: 'stopped' }));
    BenchmarkBatch.findOneAndUpdate.mockImplementation(async (filter) => {
        if (filter?.status?.$in) return makeBatchDoc();
        return null;
    });
});

describe('Trust CampaignSpec one-shot index', () => {
    it('accepts only the exact verified unique partial index', async () => {
        await expect(assertTrustCampaignSpecOneShotIndex()).resolves.toMatchObject({
            name: 'uniq_benchmark_batch_trust_campaign_spec_id',
            unique: true
        });
    });

    it.each([
        { indexes: [] },
        { indexes: [{
            name: 'uniq_benchmark_batch_trust_campaign_spec_id',
            key: { trust_campaign_spec_id: 1 },
            unique: false,
            partialFilterExpression: { trust_campaign_spec_id: { $type: 'string' } }
        }] },
        { indexes: [{
            name: 'uniq_benchmark_batch_trust_campaign_spec_id',
            key: { trust_campaign_spec_id: 1 },
            unique: true,
            partialFilterExpression: { trust_campaign_spec_id: { $type: 'objectId' } }
        }] },
        { indexes: [{
            name: 'uniq_benchmark_batch_trust_campaign_spec_id',
            key: { trust_campaign_spec_id: 1 },
            unique: true,
            partialFilterExpression: {
                trust_campaign_spec_id: { $type: 'string' },
                status: 'completed'
            }
        }] },
        { indexes: [{
            name: 'uniq_benchmark_batch_trust_campaign_spec_id',
            key: { trust_campaign_spec_id: 1 },
            unique: true,
            partialFilterExpression: {
                trust_campaign_spec_id: { $type: 'string', $ne: '' }
            }
        }] }
    ])('fails closed without creating or repairing an invalid index', async ({ indexes }) => {
        BenchmarkBatch.collection.indexes.mockResolvedValue(indexes);

        await expect(assertTrustCampaignSpecOneShotIndex())
            .rejects.toMatchObject({ code: 'BENCHMARK_TRUST_CAMPAIGN_SPEC_INDEX_MISSING' });
        expect(BenchmarkBatch.collection.indexes).toHaveBeenCalledTimes(1);
    });

    it('fails closed when index inspection is unavailable', async () => {
        BenchmarkBatch.collection.indexes.mockRejectedValue(new Error('mongo unavailable'));

        await expect(assertTrustCampaignSpecOneShotIndex())
            .rejects.toMatchObject({ code: 'BENCHMARK_TRUST_CAMPAIGN_SPEC_INDEX_UNAVAILABLE' });
    });
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
        BenchmarkBatch.findOneAndUpdate.mockResolvedValueOnce(finalBatch);
        BenchmarkBatch.findById
            .mockImplementationOnce(() => finalBatch);

        await executeBatch(BATCH_ID, DEFAULT_HOST, MODELS, PROMPTS, {});

        expect(BenchmarkBatch.findOneAndUpdate).toHaveBeenLastCalledWith(
            expect.objectContaining({
                _id: BATCH_ID,
                status: { $in: ['pending', 'running', 'judging'] }
            }),
            expect.objectContaining({
                $set: expect.objectContaining({
                    status: 'failed',
                    failure_reason: 'high_failure_rate',
                    active_slot: null
                })
            }),
            { new: true }
        );
    });

    it('marks batch as failed/zero_cells_executed when no cells ran (0209)', async () => {
        const lockedBatch = makeBatchDoc();
        const finalBatch = makeBatchDoc({
            total_tests: 315,
            completed: 0,
            failed: 0
        });

        BenchmarkBatch.findOneAndUpdate.mockResolvedValueOnce(lockedBatch);
        BenchmarkBatch.findOneAndUpdate.mockResolvedValueOnce(finalBatch);
        BenchmarkBatch.findById
            .mockImplementationOnce(() => finalBatch);

        await executeBatch(BATCH_ID, DEFAULT_HOST, MODELS, PROMPTS, {});

        expect(BenchmarkBatch.findOneAndUpdate).toHaveBeenLastCalledWith(
            expect.any(Object),
            expect.objectContaining({
                $set: expect.objectContaining({
                    status: 'failed',
                    failure_reason: 'zero_cells_executed'
                })
            }),
            { new: true }
        );
    });

    it('does not overwrite a stop that wins the atomic finalization race', async () => {
        const lockedBatch = makeBatchDoc();
        const finalSnapshot = makeBatchDoc({
            total_tests: 1,
            completed: 1,
            failed: 0
        });

        BenchmarkBatch.findOneAndUpdate
            .mockResolvedValueOnce(lockedBatch)
            .mockResolvedValueOnce(null);
        BenchmarkBatch.findById.mockResolvedValueOnce(finalSnapshot);

        await executeBatch(BATCH_ID, DEFAULT_HOST, MODELS, PROMPTS, {});

        expect(BenchmarkBatch.findOneAndUpdate).toHaveBeenLastCalledWith(
            expect.objectContaining({
                _id: BATCH_ID,
                status: { $in: ['pending', 'running', 'judging'] }
            }),
            expect.any(Object),
            { new: true }
        );
        expect(finalSnapshot.calculateMetrics).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith(
            'Skipped batch finalization because a terminal transition already won',
            { batchId: BATCH_ID }
        );
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

    it('retains the workload admission when crash-state persistence is unavailable', async () => {
        BenchmarkBatch.findOneAndUpdate.mockResolvedValueOnce(makeBatchDoc());
        runBatchOrchestrator.mockRejectedValueOnce(new Error('orchestrator crash'));
        BenchmarkBatch.updateOne.mockImplementation(async (_filter, update) => {
            if (update?.$set?.status === 'failed') throw new Error('terminal write unavailable');
            return { matchedCount: 1 };
        });

        await expect(
            executeBatch(BATCH_ID, DEFAULT_HOST, MODELS, PROMPTS, {})
        ).rejects.toMatchObject({
            code: 'BATCH_TERMINAL_RECONCILIATION_PENDING',
            retainAdmission: true,
            compensationError: expect.any(Error)
        });

        expect(coreApiClient.releaseWorkloadAdmission).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
            'Workload admission moved to durable Core recovery quarantine',
            expect.objectContaining({ workloadId: BATCH_ID, phase: 'terminal_reconciliation' })
        );
    });

    it('does not overwrite or misreport a stop that wins the crash transition', async () => {
        const BenchmarkTimelineEntry = require('../../../models/BenchmarkTimelineEntry');
        BenchmarkBatch.findOneAndUpdate.mockResolvedValueOnce(makeBatchDoc());
        BenchmarkBatch.findById.mockImplementation(() => makeSelectableBatchDoc('stopped'));
        BenchmarkBatch.updateOne.mockImplementation(async (filter) => ({
            matchedCount: filter?.status?.$in ? 0 : 1
        }));
        runBatchOrchestrator.mockRejectedValueOnce(new Error('late cancellation race'));

        await expect(
            executeBatch(BATCH_ID, DEFAULT_HOST, MODELS, PROMPTS, {})
        ).resolves.toEqual({ stopped: true, cancelled: true });

        const failureTransition = BenchmarkBatch.updateOne.mock.calls.find(
            ([filter, update]) => filter?.status?.$in && update?.$set?.status === 'failed'
        );
        expect(failureTransition).toBeDefined();
        expect(BenchmarkTimelineEntry.create.mock.calls.some(
            ([entry]) => entry?.event === 'execution_crash'
        )).toBe(false);
        expect(logger.info).toHaveBeenCalledWith(
            'Suppressed batch crash because user stop won the terminal race',
            { batchId: BATCH_ID }
        );
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

describe('Durable stop transition', () => {
    it('finalizes strict Trust evidence before aborting live work', async () => {
        const snapshot = makeSelectableBatchDoc('running', {
            trust_evidence_context: { schema: 'agentx.benchmark-trust-source-context/v2' }
        });
        snapshot.lean.mockReturnValue({
            status: 'running',
            trust_evidence_context: { schema: 'agentx.benchmark-trust-source-context/v2' },
            trust_evidence_sealed: false,
            trust_evidence_finalized_at: null
        });
        BenchmarkBatch.findById.mockReturnValueOnce(snapshot);

        await stopBatch(BATCH_ID);

        expect(BenchmarkBatch.finalizeTrustEvidenceBatch).toHaveBeenCalledWith(BATCH_ID, {
            status: 'stopped',
            failureReason: 'operator_stop',
            allowUnstarted: true
        });
        expect(BenchmarkBatch.finalizeTrustEvidenceBatch.mock.invocationCallOrder[0])
            .toBeLessThan(abortActiveBatchRequests.mock.invocationCallOrder[0]);
    });

    it('does not abort strict Trust work when durable finalization fails', async () => {
        const snapshot = makeSelectableBatchDoc('running', {
            trust_evidence_context: { schema: 'agentx.benchmark-trust-source-context/v2' }
        });
        snapshot.lean.mockReturnValue({
            status: 'running',
            trust_evidence_context: { schema: 'agentx.benchmark-trust-source-context/v2' }
        });
        BenchmarkBatch.findById.mockReturnValueOnce(snapshot);
        BenchmarkBatch.finalizeTrustEvidenceBatch.mockRejectedValueOnce(new Error('mongo unavailable'));

        await expect(stopBatch(BATCH_ID)).rejects.toThrow('mongo unavailable');
        expect(abortActiveBatchRequests).not.toHaveBeenCalled();
    });

    it('keeps strict local ownership until the cancelled runner has drained', async () => {
        let finishOrchestrator;
        runBatchOrchestrator.mockImplementationOnce(() => new Promise(resolve => {
            finishOrchestrator = resolve;
        }));
        BenchmarkBatch.findOneAndUpdate.mockResolvedValueOnce(makeBatchDoc({
            trust_evidence_context: { schema: 'agentx.benchmark-trust-source-context/v2' }
        }));

        const running = executeBatch(BATCH_ID, DEFAULT_HOST, MODELS, PROMPTS, {
            trust_evidence_context: { schema: 'agentx.benchmark-trust-source-context/v2' }
        });
        await new Promise(resolve => setImmediate(resolve));
        expect(getActiveBatchId()).toBe(BATCH_ID);

        const runningSnapshot = makeSelectableBatchDoc('running');
        runningSnapshot.lean.mockReturnValue({
            status: 'running',
            trust_evidence_context: { schema: 'agentx.benchmark-trust-source-context/v2' },
            trust_evidence_sealed: false,
            trust_evidence_finalized_at: null
        });
        BenchmarkBatch.findById.mockReturnValueOnce(runningSnapshot);
        const firstStop = await stopBatch(BATCH_ID);
        expect(firstStop.managedLocally).toBe(true);
        expect(getActiveBatchId()).toBe(BATCH_ID);

        const stoppedSnapshot = makeSelectableBatchDoc('stopped');
        stoppedSnapshot.lean.mockReturnValue({
            status: 'stopped',
            trust_evidence_context: { schema: 'agentx.benchmark-trust-source-context/v2' },
            trust_evidence_sealed: true,
            trust_evidence_finalized_at: new Date()
        });
        const stoppedDocument = makeBatchDoc({ status: 'stopped' });
        BenchmarkBatch.findById
            .mockReturnValueOnce(stoppedSnapshot)
            .mockReturnValueOnce(stoppedDocument);
        const repeatedStop = await stopBatch(BATCH_ID);
        expect(repeatedStop).toMatchObject({ alreadyStopped: true, managedLocally: true });
        expect(getActiveBatchId()).toBe(BATCH_ID);

        finishOrchestrator();
        await running;
        expect(getActiveBatchId()).toBeNull();
    });

    it('keeps the committed stopped state when reconciliation fails', async () => {
        const stoppedIntent = makeBatchDoc({
            status: 'stopped',
            reconcileFromResults: jest.fn(async () => {
                throw new Error('authoritative count unavailable');
            })
        });
        BenchmarkBatch.findOneAndUpdate.mockResolvedValueOnce(stoppedIntent);

        const result = await stopBatch(BATCH_ID);

        expect(result).toMatchObject({
            batch: stoppedIntent,
            alreadyStopped: false,
            managedLocally: false
        });
        expect(BenchmarkBatch.findOneAndUpdate).toHaveBeenCalledWith(
            {
                _id: BATCH_ID,
                status: { $in: ['pending', 'running'] }
            },
            expect.objectContaining({
                $set: expect.objectContaining({
                    status: 'stopped',
                    judge_status: 'stopped',
                    active_slot: null,
                    execution_pid: null
                })
            }),
            { new: true }
        );
        expect(abortActiveBatchRequests).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledWith(
            'Batch stopped but authoritative reconciliation failed',
            expect.objectContaining({ batchId: BATCH_ID })
        );
    });

    it('does not abort work when the durable stop write itself fails', async () => {
        BenchmarkBatch.findOneAndUpdate.mockRejectedValueOnce(new Error('mongo unavailable'));

        await expect(stopBatch(BATCH_ID)).rejects.toThrow('mongo unavailable');

        expect(abortActiveBatchRequests).not.toHaveBeenCalled();
    });
});
