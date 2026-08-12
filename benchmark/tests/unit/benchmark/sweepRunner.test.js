'use strict';

const { runSweep, _internal } = require('../../../src/services/benchmark/sweepRunner');

const HOST_URL = 'http://ollama-host:11434';

function planReady(overrides = {}) {
    return {
        host: { hostId: 'secondary', hostUrl: HOST_URL },
        payloads: {
            profileQueue: null,
            benchmark: {
                host: HOST_URL,
                models: ['ax/gemma4:e4b'],
                levels: [1, 2, 3],
                judge_config: { host: 'http://judge:11434', model: 'judge' },
                execution_config: {},
                execution_mode: 'latency',
                run_name: 'sweep'
            }
        },
        ...overrides
    };
}

function planNeedsProfile() {
    return {
        host: { hostId: 'secondary', hostUrl: HOST_URL },
        payloads: {
            profileQueue: { hostId: 'secondary', depth: 'quick', modelNames: ['gemma4:e4b'] },
            benchmark: null
        }
    };
}

function baseDeps(overrides = {}) {
    return {
        buildSweepPlan: jest.fn().mockResolvedValue(planReady()),
        getActiveBatches: jest.fn().mockResolvedValue([]),
        findActiveProfilingForHost: jest.fn().mockResolvedValue([]),
        runPreflight: jest.fn().mockResolvedValue({ ready: true, issues: [] }),
        startBatch: jest.fn().mockResolvedValue({ batch_id: 'B1', total_tests: 12 }),
        sleep: jest.fn().mockResolvedValue(undefined),
        ...overrides
    };
}

describe('sweepRunner.runSweep', () => {
    it('plan-only: returns a dry-run plan and starts nothing without execute:true', async () => {
        const deps = baseDeps();
        const res = await runSweep({ hostId: 'secondary', candidates: ['gemma4:e4b'] }, deps);

        expect(res.phase).toBe('dry_run');
        expect(res.executed).toBe(false);
        expect(res.wouldStart.benchmark).toBe(true);
        expect(deps.getActiveBatches).not.toHaveBeenCalled();
        expect(deps.startBatch).not.toHaveBeenCalled();
    });

    it('benchmark-ready: runs preflight then starts the batch', async () => {
        const deps = baseDeps();
        const res = await runSweep({ hostId: 'secondary', candidates: ['gemma4:e4b'], execute: true }, deps);

        expect(deps.runPreflight).toHaveBeenCalledTimes(1);
        expect(deps.runPreflight.mock.calls[0][0].targets).toEqual([{ host: HOST_URL, model: 'ax/gemma4:e4b' }]);
        expect(deps.startBatch).toHaveBeenCalledTimes(1);
        expect(deps.startBatch.mock.calls[0][0]).toMatchObject({
            host: HOST_URL,
            models: ['ax/gemma4:e4b'],
            levels: [1, 2, 3],
            execution_mode: 'latency'
        });
        expect(res).toMatchObject({ phase: 'benchmarking', executed: true, batchId: 'B1', totalTests: 12 });
    });

    it('lock-conflict: rejects (409) when a batch is already active and never starts a batch', async () => {
        const deps = baseDeps({ getActiveBatches: jest.fn().mockResolvedValue([{ batch_id: 'ACTIVE' }]) });
        await expect(runSweep({ hostId: 'secondary', candidates: ['x'], execute: true }, deps))
            .rejects.toMatchObject({ statusCode: 409 });
        expect(deps.startBatch).not.toHaveBeenCalled();
    });

    it('lock-conflict: rejects (409) when the host has an active profile queue', async () => {
        const deps = baseDeps({ findActiveProfilingForHost: jest.fn().mockResolvedValue([{ type: 'profile-host', queueId: 'q' }]) });
        await expect(runSweep({ hostId: 'secondary', candidates: ['x'], execute: true }, deps))
            .rejects.toMatchObject({ statusCode: 409 });
        expect(deps.startBatch).not.toHaveBeenCalled();
    });

    it('profile-needed (deferred): returns needs_profile with the payload, starts no batch', async () => {
        const deps = baseDeps({ buildSweepPlan: jest.fn().mockResolvedValue(planNeedsProfile()) });
        const res = await runSweep({ hostId: 'secondary', candidates: ['gemma4:e4b'], execute: true }, deps);

        expect(res.phase).toBe('needs_profile');
        expect(res.profilePayload).toMatchObject({ hostId: 'secondary', modelNames: ['gemma4:e4b'] });
        expect(deps.startBatch).not.toHaveBeenCalled();
    });

    it('auto-profile success: profiles, polls to completed, re-plans, then benchmarks', async () => {
        const buildSweepPlan = jest.fn()
            .mockResolvedValueOnce(planNeedsProfile())  // first plan: needs profiling
            .mockResolvedValueOnce(planReady());        // after profiling: ready
        const deps = baseDeps({
            buildSweepPlan,
            startProfileQueue: jest.fn().mockResolvedValue({ queueId: 'q1' }),
            getQueueStatus: jest.fn().mockResolvedValue({ status: 'completed' })
        });

        const res = await runSweep({ hostId: 'secondary', candidates: ['gemma4:e4b'], execute: true }, deps);

        expect(deps.startProfileQueue).toHaveBeenCalledTimes(1);
        expect(buildSweepPlan).toHaveBeenCalledTimes(2);
        expect(deps.startBatch).toHaveBeenCalledTimes(1);
        expect(res).toMatchObject({ phase: 'benchmarking', batchId: 'B1' });
    });

    it('failed-profile: stops at profile_failed and never benchmarks', async () => {
        const deps = baseDeps({
            buildSweepPlan: jest.fn().mockResolvedValue(planNeedsProfile()),
            startProfileQueue: jest.fn().mockResolvedValue({ queueId: 'q1' }),
            getQueueStatus: jest.fn().mockResolvedValue({ status: 'failed' })
        });
        const res = await runSweep({ hostId: 'secondary', candidates: ['x'], execute: true }, deps);

        expect(res).toMatchObject({ phase: 'profile_failed', queueId: 'q1', status: 'failed' });
        expect(deps.startBatch).not.toHaveBeenCalled();
    });

    it('preflight_failed: does not start a batch when preflight is not ready', async () => {
        const deps = baseDeps({ runPreflight: jest.fn().mockResolvedValue({ ready: false, issues: ['model missing'] }) });
        const res = await runSweep({ hostId: 'secondary', candidates: ['x'], execute: true }, deps);

        expect(res.phase).toBe('preflight_failed');
        expect(res.issues).toEqual(['model missing']);
        expect(deps.startBatch).not.toHaveBeenCalled();
    });
});

describe('sweepRunner.pollToTerminal', () => {
    const { pollToTerminal } = _internal;

    it('returns completed immediately on a terminal-ok status', async () => {
        const r = await pollToTerminal({
            queueId: 'q', getQueueStatus: jest.fn().mockResolvedValue({ status: 'completed' }),
            sleep: jest.fn(), pollIntervalMs: 10, maxWaitMs: 100
        });
        expect(r).toMatchObject({ status: 'completed', pending: false });
    });

    it('flags pending when still running past the wait ceiling', async () => {
        const r = await pollToTerminal({
            queueId: 'q', getQueueStatus: jest.fn().mockResolvedValue({ status: 'running' }),
            sleep: jest.fn().mockResolvedValue(undefined), pollIntervalMs: 10, maxWaitMs: 0
        });
        expect(r).toMatchObject({ status: 'running', pending: true });
    });

    it('eventually returns completed after polling through running', async () => {
        const getQueueStatus = jest.fn()
            .mockResolvedValueOnce({ status: 'running' })
            .mockResolvedValueOnce({ status: 'completed' });
        const r = await pollToTerminal({
            queueId: 'q', getQueueStatus, sleep: jest.fn().mockResolvedValue(undefined),
            pollIntervalMs: 10, maxWaitMs: 1000
        });
        expect(r.status).toBe('completed');
        expect(getQueueStatus).toHaveBeenCalledTimes(2);
    });
});
