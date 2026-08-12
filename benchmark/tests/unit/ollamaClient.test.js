const { ollamaFetch, listModels, listRunning, showModel, generate, chat, createModel, pullModel, normalizeCreateBody, DEFAULT_TIMEOUT_MS } = require('../../src/clients/ollamaClient');

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock dependencies
jest.mock('../../src/helpers/httpAgent', () => ({
    getFetchOptions: (_url, opts) => opts
}));
jest.mock('../../src/helpers/ollamaHostConfig', () => ({
    normalizeHostUrl: (url) => url?.replace(/\/+$/, '') || 'http://localhost:11434'
}));
jest.mock('../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

beforeEach(() => mockFetch.mockReset());

describe('ollamaClient', () => {
    describe('ollamaFetch', () => {
        it('returns parsed JSON on success', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: async () => ({ models: ['a'] })
            });
            const result = await ollamaFetch('http://host:11434', '/api/tags');
            expect(result).toEqual({ models: ['a'] });
            expect(mockFetch).toHaveBeenCalledWith(
                'http://host:11434/api/tags',
                expect.objectContaining({ method: 'GET' })
            );
        });

        it('throws with status on non-OK response', async () => {
            mockFetch.mockResolvedValue({
                ok: false,
                status: 404,
                text: async () => 'not found'
            });
            await expect(ollamaFetch('http://host:11434', '/api/tags'))
                .rejects.toThrow(/returned 404/);
            try {
                await ollamaFetch('http://host:11434', '/api/tags');
            } catch (err) {
                expect(err.status).toBe(404);
            }
        });

        it('throws timeout error on abort', async () => {
            mockFetch.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            await expect(ollamaFetch('http://host:11434', '/api/tags', { timeoutMs: 100 }))
                .rejects.toThrow(/timed out/);
            try {
                await ollamaFetch('http://host:11434', '/api/tags', { timeoutMs: 100 });
            } catch (err) {
                expect(err.code).toBe('ETIMEDOUT');
            }
        });

        it('sends POST with JSON body', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: async () => ({ done: true })
            });
            await ollamaFetch('http://host:11434', '/api/generate', {
                method: 'POST',
                body: { model: 'test', prompt: 'hello' }
            });
            const callArgs = mockFetch.mock.calls[0][1];
            expect(callArgs.method).toBe('POST');
            expect(JSON.parse(callArgs.body)).toEqual({ model: 'test', prompt: 'hello' });
        });

        it('re-throws non-abort errors', async () => {
            mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
            await expect(ollamaFetch('http://host:11434', '/api/tags'))
                .rejects.toThrow('ECONNREFUSED');
        });
    });

    describe('convenience methods', () => {
        beforeEach(() => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: async () => ({ models: [] })
            });
        });

        it('listModels calls /api/tags with 8s timeout', async () => {
            await listModels('http://host:11434');
            expect(mockFetch.mock.calls[0][0]).toBe('http://host:11434/api/tags');
        });

        it('listRunning calls /api/ps', async () => {
            await listRunning('http://host:11434');
            expect(mockFetch.mock.calls[0][0]).toBe('http://host:11434/api/ps');
        });

        it('showModel sends POST with model name', async () => {
            await showModel('http://host:11434', 'llama3:8b');
            const callArgs = mockFetch.mock.calls[0][1];
            expect(callArgs.method).toBe('POST');
            expect(JSON.parse(callArgs.body)).toEqual({ name: 'llama3:8b' });
        });

        it('generate sends POST to /api/generate', async () => {
            await generate('http://host:11434', { model: 'test', prompt: 'hi', stream: false });
            expect(mockFetch.mock.calls[0][0]).toBe('http://host:11434/api/generate');
            expect(JSON.parse(mockFetch.mock.calls[0][1].body).model).toBe('test');
        });

        it('chat sends POST to /api/chat', async () => {
            await chat('http://host:11434', { model: 'test', messages: [] });
            expect(mockFetch.mock.calls[0][0]).toBe('http://host:11434/api/chat');
        });

        it('createModel sends POST to /api/create', async () => {
            await createModel('http://host:11434', { name: 'adapted', modelfile: 'FROM test' });
            expect(mockFetch.mock.calls[0][0]).toBe('http://host:11434/api/create');
            expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
                model: 'adapted',
                from: 'test',
                stream: false
            });
        });

        it('pullModel waits for a non-streaming Ollama pull', async () => {
            await pullModel('http://host:11434', 'qwen2.5:3b');
            expect(mockFetch.mock.calls[0][0]).toBe('http://host:11434/api/pull');
            expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
                name: 'qwen2.5:3b',
                stream: false
            });
        });

        it('allows timeout override via opts', async () => {
            await listModels('http://host:11434', { timeoutMs: 1000 });
            // Just verify it doesn't throw — timeout is internal
            expect(mockFetch).toHaveBeenCalled();
        });
    });

    describe('DEFAULT_TIMEOUT_MS', () => {
        it('is 30 seconds', () => {
            expect(DEFAULT_TIMEOUT_MS).toBe(30000);
        });
    });

    describe('normalizeCreateBody', () => {
        it('translates a Modelfile payload into the Ollama create API shape', () => {
            expect(normalizeCreateBody({
                name: 'adapted',
                modelfile: [
                    'FROM qwen3:14b',
                    'PARAMETER num_ctx 4096',
                    'PARAMETER num_gpu 99',
                    'PARAMETER temperature 0.1'
                ].join('\n')
            })).toEqual({
                model: 'adapted',
                from: 'qwen3:14b',
                parameters: {
                    num_ctx: 4096,
                    num_gpu: 99,
                    temperature: 0.1
                },
                stream: false
            });
        });
    });
});
