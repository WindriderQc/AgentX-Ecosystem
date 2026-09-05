const mongoose = require('mongoose');

jest.mock('../../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../../src/services/benchmark/init', () => ({
    seedPrompts: jest.fn(async () => {})
}));

jest.mock('../../../src/services/benchmark/batchPlanner', () => ({
    buildExecutionPlan: jest.fn(() => ({
        plan: {
            exec_hosts: [],
            judge_model: 'test-judge',
            execution_config: {},
            total_models: 1,
            total_prompts: 1,
            categories: []
        },
        normalizedExecutionConfig: { repeats: 1 }
    }))
}));

jest.mock('../../../src/services/benchmark/harnessBrokerClient', () => ({
    createSpendGrant: jest.fn(async () => null),
    resolveHarnessTarget: jest.fn(async target => target)
}));

jest.mock('../../../src/clients/coreApiClient', () => ({
    acquireWorkloadAdmission: jest.fn(async (workloadId, options = {}) => ({
        acquired: true,
        admissionId: `admission-${workloadId}`,
        generation: `generation-${workloadId}`,
        requestId: options.requestId,
        workloadId
    })),
    heartbeatWorkloadAdmission: jest.fn(async () => ({ heartbeat: true })),
    releaseWorkloadAdmission: jest.fn(async () => ({ released: true }))
}));

const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const coreApiClient = require('../../../src/clients/coreApiClient');
const { startBatch } = require('../../../src/services/benchmark/execution');

describe('startBatch prompt-scoped level persistence', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('derives a non-empty valid level set from explicit prompts before the real model save boundary', async () => {
        const promptId = new mongoose.Types.ObjectId();
        jest.spyOn(BenchmarkPrompt, 'find').mockResolvedValue([{
            _id: promptId,
            name: 'Adversarial level four',
            prompt: 'Return a bounded answer.',
            level: 4,
            category: 'reasoning'
        }]);

        let savedBatch = null;
        jest.spyOn(BenchmarkBatch.prototype, 'save').mockImplementation(async function saveWithValidation() {
            const validationError = this.validateSync();
            if (validationError) throw validationError;
            savedBatch = this;
            return this;
        });

        const result = await startBatch({
            host: 'http://localhost:11434',
            models: ['candidate-model'],
            levels: [],
            prompt_ids: [promptId.toString()],
            run_name: 'prompt-scoped launch'
        });

        expect(result.batch_id).toBe(savedBatch._id.toString());
        expect(savedBatch.levels).toEqual([4]);
        expect(savedBatch.prompt_ids).toEqual([promptId.toString()]);
    });

    it('retains the admission when an ambiguous batch insert cannot be compensated', async () => {
        jest.spyOn(BenchmarkPrompt, 'getByLevels').mockResolvedValue([{
            _id: new mongoose.Types.ObjectId(),
            name: 'Prompt',
            prompt: 'Return a bounded answer.',
            level: 1,
            category: 'reasoning'
        }]);
        jest.spyOn(BenchmarkBatch.prototype, 'save').mockRejectedValue(new Error('insert acknowledgement lost'));
        jest.spyOn(BenchmarkBatch, 'deleteOne').mockRejectedValue(new Error('compensation unavailable'));

        await expect(startBatch({
            host: 'http://localhost:11434',
            models: ['candidate-model'],
            levels: [1]
        })).rejects.toMatchObject({
            code: 'BATCH_CREATION_RECONCILIATION_PENDING',
            retainAdmission: true,
            compensationError: expect.any(Error)
        });

        expect(coreApiClient.releaseWorkloadAdmission).not.toHaveBeenCalled();
    });
});
