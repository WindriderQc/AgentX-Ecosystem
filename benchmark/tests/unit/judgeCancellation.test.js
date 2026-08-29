'use strict';

jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../src/helpers/httpAgent', () => ({
    getFetchOptions: jest.fn((url, options) => options)
}));

jest.mock('../../src/services/benchmark/http', () => ({
    benchmarkFetch: jest.fn()
}));

const { benchmarkFetch } = require('../../src/services/benchmark/http');
const {
    BENCHMARK_BATCH_STOPPED_CODE,
    callJudge
} = require('../../src/services/scoring/judgeCall');

function abortError() {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function rejectWhenAborted(signal) {
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
    });
}

const CONFIG = {
    host: 'http://judge.example:11434',
    model: 'judge:test',
    timeout: 30_000,
    max_retries: 2
};

beforeEach(() => {
    jest.clearAllMocks();
});
describe('judge caller cancellation', () => {
    it('aborts an active fetch with a stable code and does not retry', async () => {
        const fetchStarted = deferred();
        benchmarkFetch.mockImplementation((url, options) => {
            fetchStarted.resolve();
            return rejectWhenAborted(options.signal);
        });

        const controller = new AbortController();
        const pending = callJudge('evaluate this', {
            ...CONFIG,
            cancelSignal: controller.signal
        });

        await fetchStarted.promise;
        controller.abort(new Error('private operator reason'));

        await expect(pending).rejects.toMatchObject({
            name: 'BenchmarkBatchStoppedError',
            code: BENCHMARK_BATCH_STOPPED_CODE,
            message: 'Benchmark batch judging cancelled'
        });
        expect(benchmarkFetch).toHaveBeenCalledTimes(1);
    });

    it('keeps cancellation live through response-body consumption and does not retry', async () => {
        const bodyStarted = deferred();
        benchmarkFetch.mockImplementation(async (url, options) => ({
            ok: true,
            json: () => {
                bodyStarted.resolve();
                return rejectWhenAborted(options.signal);
            }
        }));

        const controller = new AbortController();
        const pending = callJudge('evaluate this', {
            ...CONFIG,
            signal: controller.signal
        });

        await bodyStarted.promise;
        controller.abort(new Error('must never escape'));

        await expect(pending).rejects.toMatchObject({
            code: BENCHMARK_BATCH_STOPPED_CODE,
            message: 'Benchmark batch judging cancelled'
        });
        expect(benchmarkFetch).toHaveBeenCalledTimes(1);
    });
});
