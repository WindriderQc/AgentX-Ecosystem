'use strict';

const mockAcquireWorkloadAdmission = jest.fn();
const mockReleaseWorkloadAdmission = jest.fn();
const mockStartHeartbeat = jest.fn();

jest.mock('../../../src/clients/coreApiClient', () => ({
    acquireWorkloadAdmission: (...args) => mockAcquireWorkloadAdmission(...args),
    releaseWorkloadAdmission: (...args) => mockReleaseWorkloadAdmission(...args)
}));

jest.mock('../../../src/services/benchmark/benchmarkClaimLifecycle', () => ({
    startBenchmarkClaimHeartbeat: (...args) => mockStartHeartbeat(...args)
}));

jest.mock('../../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const {
    beginManagedWorkload,
    runManagedWorkload,
    withManagedWorkloadRoute
} = require('../../../src/services/benchmark/workloadAdmissionLifecycle');

function heartbeatHarness() {
    let failure = null;
    let stopped = false;
    const heartbeat = jest.fn(() => { stopped = true; });
    heartbeat.ready = Promise.resolve();
    heartbeat.drain = jest.fn(async () => { stopped = true; });
    heartbeat.assertActive = jest.fn(() => {
        if (failure) throw failure;
        if (stopped) throw new Error('heartbeat stopped');
        return true;
    });
    heartbeat.getFailure = jest.fn(() => failure);
    heartbeat.fail = error => { failure = error; };
    return heartbeat;
}

function responseHarness() {
    const res = {
        statusCode: 200,
        headersSent: false,
        status: jest.fn(code => {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(() => {
            res.headersSent = true;
            return res;
        })
    };
    return res;
}

describe('managed benchmark workload admission lifecycle', () => {
    let heartbeat;
    let heartbeatOptions;

    beforeEach(() => {
        jest.clearAllMocks();
        heartbeat = heartbeatHarness();
        heartbeatOptions = null;
        mockAcquireWorkloadAdmission.mockResolvedValue({ acquired: true });
        mockReleaseWorkloadAdmission.mockResolvedValue({ released: true });
        mockStartHeartbeat.mockImplementation((_hosts, _id, _ttl, options) => {
            heartbeatOptions = options;
            return heartbeat;
        });
    });

    test('binds the exact host intent and releases only after the task and heartbeat drain', async () => {
        const order = [];
        heartbeat.drain.mockImplementation(async () => { order.push('drain'); });
        mockReleaseWorkloadAdmission.mockImplementation(async () => {
            order.push('release');
            return { released: true };
        });

        const result = await runManagedWorkload('judge-1', {
            requestId: 'judge-request-1',
            kind: 'judge',
            batchId: 'batch-1',
            hosts: ['http://judge:11434']
        }, async ({ signal, assertActive }) => {
            expect(signal.aborted).toBe(false);
            expect(assertActive()).toBe(true);
            order.push('task');
            return 'done';
        });

        expect(result).toBe('done');
        expect(mockAcquireWorkloadAdmission).toHaveBeenCalledWith('judge-1', expect.objectContaining({
            requestId: 'judge-request-1',
            kind: 'judge',
            batchId: 'batch-1',
            hosts: ['http://judge:11434']
        }));
        expect(order).toEqual(['task', 'release', 'drain']);
    });

    test('heartbeat rejection aborts the shared signal and retains admission for TTL recovery', async () => {
        const lifecycle = await beginManagedWorkload('judge-fatal', { hosts: ['http://judge:11434'] });
        const lost = Object.assign(new Error('Core rejected heartbeat'), { code: 'BENCHMARK_CLAIM_LOST' });
        heartbeat.fail(lost);
        heartbeatOptions.onFatal(lost);

        expect(lifecycle.signal.aborted).toBe(true);
        expect(lifecycle.signal.reason).toBe(lost);
        expect(() => lifecycle.assertActive()).toThrow('Core rejected heartbeat');

        await lifecycle.abandon();
        expect(heartbeat.drain).toHaveBeenCalledTimes(1);
        expect(mockReleaseWorkloadAdmission).not.toHaveBeenCalled();
    });

    test('buffers route success until the exact admission release succeeds', async () => {
        const order = [];
        const res = responseHarness();
        res.json.mockImplementation(body => {
            order.push(`send:${body.status}`);
            res.headersSent = true;
            return res;
        });
        heartbeat.drain.mockImplementation(async () => { order.push('drain'); });
        mockReleaseWorkloadAdmission.mockImplementation(async () => {
            order.push('release');
            return { released: true };
        });
        const wrapped = withManagedWorkloadRoute('judge-health', () => ({}), async (_req, routeRes) => {
            order.push('handler');
            routeRes.json({ status: 'success' });
        });

        await wrapped({ body: {} }, res, jest.fn());

        expect(order).toEqual(['handler', 'release', 'drain', 'send:success']);
        expect(res.statusCode).toBe(200);
    });

    test('replaces a buffered success with an error when release cannot be attested', async () => {
        mockReleaseWorkloadAdmission.mockResolvedValue({ released: false, reason: 'stale admission' });
        const res = responseHarness();
        const sendJson = res.json;
        const wrapped = withManagedWorkloadRoute('judge-health', () => ({}), async (_req, routeRes) => {
            routeRes.json({ status: 'success' });
        });

        await wrapped({ body: {} }, res, jest.fn());

        expect(res.statusCode).toBe(409);
        expect(sendJson).toHaveBeenCalledWith(expect.objectContaining({
            status: 'error',
            code: 'WORKLOAD_ADMISSION_RELEASE_FAILED'
        }));
        expect(heartbeat.drain).not.toHaveBeenCalled();
    });

    test('renews an ambiguous admission until durable reconciliation resolves, then releases it', async () => {
        let resolveRecovery;
        const reconciliationPromise = new Promise(resolve => { resolveRecovery = resolve; });
        const lifecycle = await beginManagedWorkload('judge-recovery', { hosts: ['http://judge:11434'] });
        const reason = Object.assign(new Error('result invalidation pending'), {
            retainAdmission: true,
            reconciliationPromise
        });

        const retained = await lifecycle.retainForRecovery(reason);
        expect(retained).toMatchObject({ retained: true, holdMs: null });
        expect(mockReleaseWorkloadAdmission).not.toHaveBeenCalled();
        expect(heartbeat.drain).not.toHaveBeenCalled();

        resolveRecovery({ resolved: true });
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));

        expect(mockReleaseWorkloadAdmission).toHaveBeenCalledWith('judge-recovery');
        expect(heartbeat.drain).toHaveBeenCalledTimes(1);
    });
});
