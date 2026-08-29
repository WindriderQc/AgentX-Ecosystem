const { Readable } = require('node:stream');

jest.mock('../../../src/helpers/outboundHttpTransport', () => ({
    createNodeFetchPeerTransport: () => async ({ fetchImpl, init, target }) => ({
        response: await fetchImpl(target, init),
        peerVerification: 'connect-time'
    })
}));

jest.mock('../../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const {
    warmupModel,
    MODEL_WARMUP_OPERATIONS,
    _internal: {
        MODEL_WARMUP_OPERATION_SPECS,
        createModelWarmupExecutor,
        modelWarmupRequest,
        operationMatches
    }
} = require('../../../src/services/benchmark/modelWarmup');
const {
    readBoundedJson
} = require('../../../../shared/outboundHttpExecutor');

function headers(values = {}) {
    const normalized = new Map(Object.entries(values)
        .map(([key, value]) => [key.toLowerCase(), String(value)]));
    return { get: (name) => normalized.get(String(name).toLowerCase()) ?? null };
}

function response(url, {
    body = '',
    headerValues = {},
    redirected = false,
    status = 200
} = {}) {
    return {
        body: Readable.from(body ? [body] : []),
        headers: headers(headerValues),
        redirected,
        status,
        url
    };
}

function okJson(data) {
    return response(undefined, { body: JSON.stringify(data) });
}

function passthroughTransport() {
    return async ({ fetchImpl, init, target }) => ({
        response: await fetchImpl(target, init),
        peerVerification: 'connect-time'
    });
}

function createTestExecutor(fetchImpl, options = {}) {
    return createModelWarmupExecutor({
        admitOllamaTargetResolved: async (target) => new URL(target).origin,
        coreUrl: options.coreUrl || 'http://localhost:3080',
        fetchImpl,
        getConfiguredHosts: () => [],
        transportAdapter: passthroughTransport()
    });
}

describe('modelWarmup', () => {
    const originalBenchmarkToken = process.env.AGENTX_BENCHMARK_TOKEN;

    afterEach(() => {
        jest.useRealTimers();
        if (originalBenchmarkToken === undefined) delete process.env.AGENTX_BENCHMARK_TOKEN;
        else process.env.AGENTX_BENCHMARK_TOKEN = originalBenchmarkToken;
    });

    it('closes all four operations over exact authority, method, path, search, mode, and byte contracts', () => {
        expect(Object.keys(MODEL_WARMUP_OPERATION_SPECS).sort())
            .toEqual(Object.values(MODEL_WARMUP_OPERATIONS).sort());
        expect([
            ['POST', '/api/generate', MODEL_WARMUP_OPERATIONS.UNLOAD_OTHERS],
            ['POST', '/api/generate', MODEL_WARMUP_OPERATIONS.UNLOAD_ONE],
            ['GET', '/api/ps', MODEL_WARMUP_OPERATIONS.PS],
            ['POST', '/api/inference/generate', MODEL_WARMUP_OPERATIONS.GENERATE]
        ].every(([method, path, operationId]) => operationMatches(
            MODEL_WARMUP_OPERATION_SPECS[operationId],
            method,
            new URL(path, 'http://service.test')
        ))).toBe(true);

        expect(MODEL_WARMUP_OPERATION_SPECS).toMatchObject({
            [MODEL_WARMUP_OPERATIONS.UNLOAD_OTHERS]: {
                allowSearch: false,
                responseMode: 'discard',
                policy: {
                    authoritySource: 'request-admitted',
                    deadlineMs: 5_000,
                    maxRequestBytes: 64 * 1024,
                    maxResponseBytes: 64 * 1024
                }
            },
            [MODEL_WARMUP_OPERATIONS.UNLOAD_ONE]: {
                allowSearch: false,
                responseMode: 'discard',
                policy: {
                    authoritySource: 'request-admitted',
                    deadlineMs: 5_000,
                    maxRequestBytes: 64 * 1024,
                    maxResponseBytes: 64 * 1024
                }
            },
            [MODEL_WARMUP_OPERATIONS.PS]: {
                allowSearch: false,
                responseMode: 'json',
                policy: {
                    authoritySource: 'request-admitted',
                    deadlineMs: 5_000,
                    maxRequestBytes: 0,
                    maxResponseBytes: 1024 * 1024
                }
            },
            [MODEL_WARMUP_OPERATIONS.GENERATE]: {
                allowSearch: false,
                responseMode: 'json',
                policy: {
                    authoritySource: 'configured',
                    deadlineMs: 600_000,
                    maxRequestBytes: 1024 * 1024,
                    maxResponseBytes: 1024 * 1024
                }
            }
        });
        expect(operationMatches(
            MODEL_WARMUP_OPERATION_SPECS[MODEL_WARMUP_OPERATIONS.PS],
            'POST',
            new URL('http://ollama:11434/api/ps')
        )).toBe(false);
        expect(operationMatches(
            MODEL_WARMUP_OPERATION_SPECS[MODEL_WARMUP_OPERATIONS.PS],
            'GET',
            new URL('http://ollama:11434/api/ps?next=/api/generate')
        )).toBe(false);
    });

    it('rejects operation/path mismatches and an unconfigured Core authority before dispatch', async () => {
        const fetchImpl = jest.fn();
        const executor = createTestExecutor(fetchImpl, { coreUrl: 'http://core.test:3080' });

        await expect(modelWarmupRequest(
            MODEL_WARMUP_OPERATIONS.PS,
            'http://ollama:11434/api/generate',
            { method: 'GET' },
            executor
        )).rejects.toThrow('not registered');
        await expect(modelWarmupRequest(
            MODEL_WARMUP_OPERATIONS.PS,
            'http://ollama:11434/api/ps?redirect=/api/generate',
            { method: 'GET' },
            executor
        )).rejects.toThrow('not registered');
        await expect(modelWarmupRequest(
            MODEL_WARMUP_OPERATIONS.GENERATE,
            'http://attacker.test:3080/api/inference/generate',
            { method: 'POST', body: '{}' },
            executor
        )).rejects.toMatchObject({
            code: 'OUTBOUND_TARGET_REJECTED',
            sinkId: MODEL_WARMUP_OPERATIONS.GENERATE
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rejects redirects without following them', async () => {
        const fetchImpl = jest.fn(async (url) => response(url, {
            body: 'redirect',
            headerValues: { location: 'http://attacker.test/private' },
            status: 307
        }));
        const executor = createTestExecutor(fetchImpl);

        await expect(modelWarmupRequest(
            MODEL_WARMUP_OPERATIONS.PS,
            'http://ollama:11434/api/ps',
            { method: 'GET' },
            executor
        )).rejects.toMatchObject({
            code: 'OUTBOUND_REDIRECT_REJECTED',
            sinkId: MODEL_WARMUP_OPERATIONS.PS,
            status: 307
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    });

    it('enforces request and response byte caps before retaining unbounded data', async () => {
        const oversizedResponseFetch = jest.fn(async (url) => response(url, {
            body: '{}',
            headerValues: { 'content-length': String(1024 * 1024 + 1) }
        }));
        const responseExecutor = createTestExecutor(oversizedResponseFetch);

        await expect(modelWarmupRequest(
            MODEL_WARMUP_OPERATIONS.PS,
            'http://ollama:11434/api/ps',
            { method: 'GET' },
            responseExecutor
        )).rejects.toMatchObject({
            code: 'OUTBOUND_RESPONSE_TOO_LARGE',
            sinkId: MODEL_WARMUP_OPERATIONS.PS
        });

        const requestFetch = jest.fn();
        const requestExecutor = createTestExecutor(requestFetch);
        await expect(modelWarmupRequest(
            MODEL_WARMUP_OPERATIONS.UNLOAD_ONE,
            'http://ollama:11434/api/generate',
            { method: 'POST', body: 'x'.repeat(64 * 1024 + 1) },
            requestExecutor
        )).rejects.toMatchObject({
            code: 'OUTBOUND_REQUEST_TOO_LARGE',
            sinkId: MODEL_WARMUP_OPERATIONS.UNLOAD_ONE
        });
        expect(requestFetch).not.toHaveBeenCalled();
    });

    it('propagates caller cancellation before dispatch without exposing the abort reason', async () => {
        const fetchImpl = jest.fn();
        const executor = createTestExecutor(fetchImpl);
        const controller = new AbortController();
        controller.abort('caller-controlled secret');

        await expect(modelWarmupRequest(
            MODEL_WARMUP_OPERATIONS.PS,
            'http://ollama:11434/api/ps',
            { method: 'GET', signal: controller.signal },
            executor
        )).rejects.toMatchObject({
            code: 'OUTBOUND_CALLER_ABORTED',
            message: 'The outbound request was cancelled.',
            sinkId: MODEL_WARMUP_OPERATIONS.PS
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('enforces the full response lifecycle deadline and cancels a stalled body', async () => {
        jest.useFakeTimers();
        const cancel = jest.fn(async () => ({ done: true }));
        const next = jest.fn(() => new Promise(() => {}));
        const fetchImpl = jest.fn(async (url) => ({
            body: {
                [Symbol.asyncIterator]: () => ({ next, return: cancel })
            },
            headers: headers(),
            redirected: false,
            status: 200,
            url
        }));
        const executor = createTestExecutor(fetchImpl);
        const managed = await modelWarmupRequest(
            MODEL_WARMUP_OPERATIONS.PS,
            'http://ollama:11434/api/ps',
            { method: 'GET' },
            executor
        );
        const readPromise = readBoundedJson(managed);
        const assertion = expect(readPromise).rejects.toMatchObject({
            code: 'OUTBOUND_DEADLINE_EXCEEDED',
            sinkId: MODEL_WARMUP_OPERATIONS.PS
        });

        await jest.advanceTimersByTimeAsync(5_001);
        await assertion;
        expect(next).toHaveBeenCalledTimes(1);
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('cancels non-2xx inventory bodies before warming and preserves the best-effort status', async () => {
        const destroy = jest.fn();
        const read = jest.fn(() => {
            throw new Error('non-2xx inventory body must not be read');
        });
        const _fetch = jest.fn()
            .mockResolvedValueOnce({
                body: {
                    destroy,
                    [Symbol.asyncIterator]: () => ({ next: read })
                },
                headers: headers(),
                redirected: false,
                status: 503
            })
            .mockResolvedValueOnce(okJson({ message: { content: 'ready' } }));

        const result = await warmupModel('http://localhost:11434', 'gemma4:e4b', {
            _fetch,
            preUnloadOthers: false
        });

        expect(result).toMatchObject({
            already_loaded: false,
            response: 'ready',
            success: true
        });
        expect(read).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledTimes(1);
    });

    it('preserves bounded status-first warmup errors', async () => {
        const _fetch = jest.fn()
            .mockResolvedValueOnce(okJson({ models: [{ name: 'gemma4:e4b' }] }))
            .mockResolvedValueOnce(response(undefined, {
                body: 'x'.repeat(150),
                status: 503
            }));

        const result = await warmupModel('http://localhost:11434', 'gemma4:e4b', { _fetch });

        expect(result.success).toBe(false);
        expect(result.error).toBe(`Warmup failed: HTTP 503 - ${'x'.repeat(100)}`);
    });

    it('sends the scoped token to Core without leaking it to direct Ollama calls', async () => {
        process.env.AGENTX_BENCHMARK_TOKEN = 'scoped-benchmark-token';
        const _fetch = jest.fn()
            .mockResolvedValueOnce(okJson({ models: [{ name: 'stale:7b' }] }))
            .mockResolvedValueOnce(okJson({}))
            .mockResolvedValueOnce(okJson({ message: { content: 'ready' } }));

        const result = await warmupModel('http://localhost:11434', 'gemma4:e4b', { _fetch });

        expect(result.success).toBe(true);
        expect(_fetch.mock.calls[1][1].headers).not.toHaveProperty('x-agentx-benchmark-token');
        expect(_fetch.mock.calls[2][1].headers).toMatchObject({
            'x-agentx-benchmark-token': 'scoped-benchmark-token'
        });
    });

    it('does not treat a same-family variant as already loaded', async () => {
        const _fetch = jest.fn()
            .mockResolvedValueOnce(okJson({ models: [{ name: 'gemma4:e4b' }] }))
            .mockResolvedValueOnce(okJson({})) // pre-unload keep_alive:0
            .mockResolvedValueOnce(okJson({ message: { content: 'ready' } }));

        const result = await warmupModel('http://localhost:11434', 'gemma4:26b', { _fetch });

        expect(result.success).toBe(true);
        expect(result.already_loaded).toBe(false);
        expect(result.pre_unloaded).toEqual(['gemma4:e4b']);
    });

    it('unloads and reloads an already-resident target when num_ctx differs', async () => {
        const _fetch = jest.fn()
            .mockResolvedValueOnce(okJson({
                models: [{ name: 'gemma4:e4b', context_length: 4096 }]
            }))
            .mockResolvedValueOnce(okJson({}))
            .mockResolvedValueOnce(okJson({ message: { content: 'ready' } }));

        const result = await warmupModel('http://localhost:11434', 'gemma4:e4b', {
            _fetch,
            num_ctx: 8192
        });

        expect(result).toMatchObject({
            already_loaded: false,
            reloaded_for_num_ctx: {
                loaded_num_ctx: 4096,
                requested_num_ctx: 8192
            },
            success: true
        });
        expect(JSON.parse(_fetch.mock.calls[1][1].body)).toEqual({
            model: 'gemma4:e4b',
            keep_alive: 0,
            stream: false
        });
        expect(_fetch.mock.calls[1][1].headers).not.toHaveProperty('x-agentx-benchmark-token');
        expect(JSON.parse(_fetch.mock.calls[2][1].body)).toMatchObject({
            model: 'gemma4:e4b',
            options: { num_ctx: 8192, num_predict: 1 }
        });
    });

    it('maps AbortError to timeout message instead of user-aborted wording', async () => {
        jest.useFakeTimers();
        let markWarmupDispatched;
        const warmupDispatched = new Promise(resolve => { markWarmupDispatched = resolve; });

        const _fetch = jest.fn()
            .mockResolvedValueOnce(okJson({ models: [{ name: 'qwen2.5:14b-instruct-q5_K_M' }] }))
            .mockImplementationOnce((_url, { signal }) => new Promise((_resolve, reject) => {
                markWarmupDispatched();
                const abort = () => reject(Object.assign(
                    new Error('The user aborted a request.'),
                    { name: 'AbortError' }
                ));
                if (signal.aborted) abort();
                else signal.addEventListener('abort', abort, { once: true });
            }));

        // preUnloadOthers=false keeps the original ps+warmup 2-call sequence;
        // pre-unload path is covered by dedicated tests below.
        const resultPromise = warmupModel('http://localhost:11434', 'qwen2.5:14b-instruct-q5_K_M', {
            _fetch,
            preUnloadOthers: false
        });
        await warmupDispatched;
        await jest.advanceTimersByTimeAsync(90_001);
        const result = await resultPromise;

        expect(result.success).toBe(false);
        expect(result.error).toContain('Warmup timed out after 90s');
        expect(result.error).not.toContain('user aborted');
    });

    it('throws normalized timeout message in strict mode', async () => {
        jest.useFakeTimers();
        let markWarmupDispatched;
        const warmupDispatched = new Promise(resolve => { markWarmupDispatched = resolve; });

        const _fetch = jest.fn()
            .mockResolvedValueOnce(okJson({ models: [{ name: 'qwen2.5:14b-instruct-q5_K_M' }] }))
            .mockImplementationOnce((_url, { signal }) => new Promise((_resolve, reject) => {
                markWarmupDispatched();
                const abort = () => reject(Object.assign(
                    new Error('The user aborted a request.'),
                    { name: 'AbortError' }
                ));
                if (signal.aborted) abort();
                else signal.addEventListener('abort', abort, { once: true });
            }));

        const resultPromise = warmupModel(
            'http://localhost:11434',
            'qwen2.5:14b-instruct-q5_K_M',
            { _fetch, strict: true, preUnloadOthers: false }
        );
        const assertion = expect(resultPromise).rejects.toThrow('Warmup timed out after 90s');
        await warmupDispatched;
        await jest.advanceTimersByTimeAsync(90_001);
        await assertion;
    });

    it('pre-unloads non-target non-embedding models before warmup', async () => {
        const _fetch = jest.fn()
            .mockResolvedValueOnce(okJson({
                models: [
                    { name: 'qwen2.5-coder:14b' },
                    { name: 'nomic-embed-text:v1.5' },
                    { name: 'deepseek-r1:14b' }
                ]
            }))
            .mockResolvedValueOnce(okJson({})) // unload qwen2.5-coder:14b
            .mockResolvedValueOnce(okJson({})) // unload deepseek-r1:14b
            .mockResolvedValueOnce(okJson({ message: { content: 'ready' } }));

        const result = await warmupModel('http://localhost:11434', 'gemma4:26b', { _fetch });

        expect(result.success).toBe(true);
        expect(result.pre_unloaded.sort()).toEqual(['deepseek-r1:14b', 'qwen2.5-coder:14b']);
    });

    it('keeps resolved unload attempts in pre_unloaded without draining non-2xx bodies', async () => {
        const destroy = jest.fn();
        const read = jest.fn(() => {
            throw new Error('non-2xx unload body must not be read');
        });
        const _fetch = jest.fn()
            .mockResolvedValueOnce(okJson({ models: [{ name: 'stale:7b' }] }))
            .mockResolvedValueOnce({
                body: {
                    destroy,
                    [Symbol.asyncIterator]: () => ({ next: read })
                },
                headers: headers(),
                redirected: false,
                status: 503
            })
            .mockResolvedValueOnce(okJson({ message: { content: 'ready' } }));

        const result = await warmupModel('http://localhost:11434', 'gemma4:e4b', { _fetch });

        expect(result).toMatchObject({
            pre_unloaded: ['stale:7b'],
            success: true
        });
        expect(read).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledTimes(1);
    });

    it('keeps caller-specified judge model loaded during pre-unload', async () => {
        const _fetch = jest.fn()
            .mockResolvedValueOnce(okJson({
                models: [{ name: 'qwen3:14b' }, { name: 'old-test:7b' }]
            }))
            .mockResolvedValueOnce(okJson({})) // unload old-test:7b
            .mockResolvedValueOnce(okJson({ message: { content: 'ready' } }));

        const result = await warmupModel('http://localhost:11434', 'gemma4:e4b', {
            _fetch,
            keepLoaded: ['qwen3:14b']
        });

        expect(result.success).toBe(true);
        expect(result.pre_unloaded).toEqual(['old-test:7b']);
    });

    it('skips pre-unload entirely when preUnloadOthers=false', async () => {
        const _fetch = jest.fn()
            .mockResolvedValueOnce(okJson({ models: [{ name: 'something:7b' }] }))
            .mockResolvedValueOnce(okJson({ message: { content: 'ready' } }));

        const result = await warmupModel('http://localhost:11434', 'gemma4:e4b', {
            _fetch,
            preUnloadOthers: false
        });

        expect(result.success).toBe(true);
        expect(result.pre_unloaded).toEqual([]);
        expect(_fetch).toHaveBeenCalledTimes(2);
    });

    it('skips pre-unload when target is already loaded', async () => {
        const _fetch = jest.fn()
            .mockResolvedValueOnce(okJson({ models: [{ name: 'gemma4:e4b' }] }))
            .mockResolvedValueOnce(okJson({ message: { content: 'ready' } }));

        const result = await warmupModel('http://localhost:11434', 'gemma4:e4b', { _fetch });

        expect(result.success).toBe(true);
        expect(result.already_loaded).toBe(true);
        expect(result.pre_unloaded).toEqual([]);
    });

    it('runs pre-unloads in parallel (wall-clock ≈ single call, not sum)', async () => {
        // Simulate 4 concurrent 100ms unloads. Serial would take ≥400ms;
        // parallel should finish in ~100ms plus test overhead.
        const delayMs = 100;
        const unloadCount = 4;
        const _fetch = jest.fn().mockImplementation((url) => {
            if (url.endsWith('/api/ps')) {
                return Promise.resolve(okJson({
                    models: Array.from({ length: unloadCount }, (_, i) => ({ name: `stale:${i}` }))
                }));
            }
            // /api/generate — either an unload (keep_alive:0) or the target warmup.
            // Small delay to measure parallelism.
            return new Promise(resolve =>
                setTimeout(() => resolve(okJson({ message: { content: 'ready' } })), delayMs)
            );
        });

        const start = Date.now();
        const result = await warmupModel('http://localhost:11434', 'gemma4:e4b', { _fetch });
        const elapsed = Date.now() - start;

        expect(result.success).toBe(true);
        expect(result.pre_unloaded).toHaveLength(unloadCount);
        // Serial would be >= unloadCount*delayMs (400ms) + warmup (100ms) = 500ms.
        // Parallel should be ~2*delayMs (one for all unloads concurrent + one for warmup).
        // Keep the threshold lax to avoid flakes on slow CI.
        expect(elapsed).toBeLessThan(unloadCount * delayMs);
    });
});
