const { warmupModel } = require('../../../src/services/benchmark/modelWarmup');

jest.mock('../../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

function okJson(data) {
    return {
        ok: true,
        status: 200,
        json: async () => data
    };
}

describe('modelWarmup', () => {
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

    it('maps AbortError to timeout message instead of user-aborted wording', async () => {
        const abortErr = new Error('The user aborted a request.');
        abortErr.name = 'AbortError';

        const _fetch = jest.fn()
            .mockResolvedValueOnce(okJson({ models: [{ name: 'qwen2.5:14b-instruct-q5_K_M' }] }))
            .mockRejectedValueOnce(abortErr);

        // preUnloadOthers=false keeps the original ps+warmup 2-call sequence;
        // pre-unload path is covered by dedicated tests below.
        const result = await warmupModel('http://localhost:11434', 'qwen2.5:14b-instruct-q5_K_M', {
            _fetch,
            preUnloadOthers: false
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Warmup timed out after 90s');
        expect(result.error).not.toContain('user aborted');
    });

    it('throws normalized timeout message in strict mode', async () => {
        const abortErr = new Error('The user aborted a request.');
        abortErr.name = 'AbortError';

        const _fetch = jest.fn()
            .mockResolvedValueOnce(okJson({ models: [{ name: 'qwen2.5:14b-instruct-q5_K_M' }] }))
            .mockRejectedValueOnce(abortErr);

        await expect(
            warmupModel('http://localhost:11434', 'qwen2.5:14b-instruct-q5_K_M', {
                _fetch, strict: true, preUnloadOthers: false
            })
        ).rejects.toThrow('Warmup timed out after 90s');
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
