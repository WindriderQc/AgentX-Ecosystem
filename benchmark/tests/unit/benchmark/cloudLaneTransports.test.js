'use strict';

const { normalizeCandidate } = require('../../../src/services/benchmark/cloudLaneAccounting');
const {
    createOllamaTransport,
    createOpenAICompatibleTransport,
    createOpenRouterTransport,
    decimalToScaledInteger,
    normalizeOpenAIUsage,
    openRouterRates
} = require('../../../src/services/benchmark/cloudLaneTransports');

const DIGEST = 'b'.repeat(64);

function jsonResponse(body, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        statusText: ok ? 'OK' : 'Error',
        text: jest.fn(async () => JSON.stringify(body))
    };
}

function freeCandidate() {
    return normalizeCandidate({
        id: 'free-openrouter',
        tier: 'free_cloud',
        provider: 'openrouter',
        model: 'vendor/model:free',
        modelVersion: 'vendor/model-20260827',
        apiVersion: 'openrouter-chat-completions-v1',
        provenanceSource: 'https://openrouter.ai/api/v1/models',
        contextWindow: 32768,
        priceSnapshot: {
            provider: 'openrouter',
            model: 'vendor/model:free',
            modelVersion: 'vendor/model-20260827',
            effectiveAt: '2026-08-27T16:00:00.000Z',
            source: 'https://openrouter.ai/api/v1/models',
            rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        }
    }, 'worker');
}

function localCandidate() {
    return normalizeCandidate({
        id: 'local-ollama',
        tier: 'local',
        provider: 'ollama',
        model: 'qwen3:8b',
        modelVersion: 'qwen3-build-1',
        apiVersion: 'ollama-0.11.10',
        provenanceSource: 'local manifest',
        contextWindow: 32768,
        artifactDigest: DIGEST
    }, 'worker');
}

const contract = {
    maxOutputTokens: 64,
    temperature: 0,
    seed: 42,
    thinking: false,
    toolProtocol: 'openai-tools-v1'
};

const fixture = {
    messages: [{ role: 'user', content: 'Call the room tool.' }],
    tools: [{ type: 'function', function: { name: 'room', parameters: { type: 'object' } } }],
    maxInputTokens: 128
};

describe('cloud/local campaign transports', () => {
    test('converts per-token decimal provider prices to integer nanodollars per million', () => {
        expect(decimalToScaledInteger('0.0000005', 15)).toBe(500_000_000);
        expect(decimalToScaledInteger('5e-7', 15)).toBe(500_000_000);
        expect(openRouterRates({
            prompt: '0.0000005',
            completion: '0.000001',
            input_cache_read: '0.0000001',
            input_cache_write: '0'
        })).toEqual({ input: 500_000_000, output: 1_000_000_000, cacheRead: 100_000_000, cacheWrite: 0 });
    });

    test('separates cached input from ordinary OpenAI-compatible input usage', () => {
        expect(normalizeOpenAIUsage({
            prompt_tokens: 20,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 7, cache_write_tokens: 3 }
        })).toEqual({ input: 13, output: 4, cacheRead: 7, cacheWrite: 3 });
    });

    test('OpenRouter preflight checks live identity, price, context, and supported exact parameters', async () => {
        const candidate = freeCandidate();
        const fetchImpl = jest.fn(async (url, options) => {
            if (url.endsWith('/models')) {
                expect(options.headers.authorization).toBe('Bearer secret-for-test');
                return jsonResponse({
                    data: [{
                        id: candidate.model,
                        canonical_slug: candidate.modelVersion,
                        context_length: candidate.contextWindow,
                        pricing: { prompt: '0', completion: '0' },
                        supported_parameters: ['max_tokens', 'temperature', 'seed', 'tools']
                    }]
                });
            }
            const payload = JSON.parse(options.body);
            expect(payload).toMatchObject({
                model: candidate.model,
                max_tokens: 64,
                temperature: 0,
                seed: 42,
                stream: false,
                reasoning: { enabled: false }
            });
            expect(payload.tools).toEqual(fixture.tools);
            return jsonResponse({
                choices: [{
                    message: {
                        content: 'done',
                        tool_calls: [{ id: 'call-1', function: { name: 'room', arguments: '{"name":"kitchen"}' } }]
                    }
                }],
                usage: { prompt_tokens: 11, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } }
            });
        });
        const transport = createOpenRouterTransport({ apiKey: 'secret-for-test', fetchImpl });
        const identity = await transport.preflight({ candidate, plan: { contract } });
        const result = await transport.execute({ candidate, fixture, contract });

        expect(identity).toMatchObject({ ready: true, modelVersion: candidate.modelVersion, contextWindow: 32768 });
        expect(result).toMatchObject({
            ok: true,
            usage: { input: 9, output: 3, cacheRead: 2, cacheWrite: 0 },
            response: { text: 'done', toolCalls: [{ id: 'call-1', name: 'room', arguments: { name: 'kitchen' } }] }
        });
        expect(JSON.stringify(result)).not.toContain('secret-for-test');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    test('OpenRouter rejects live catalog parameter drift before execution', async () => {
        const candidate = freeCandidate();
        const fetchImpl = jest.fn(async () => jsonResponse({
            data: [{
                id: candidate.model,
                canonical_slug: candidate.modelVersion,
                context_length: candidate.contextWindow,
                pricing: { prompt: '0', completion: '0' },
                supported_parameters: ['max_tokens', 'temperature']
            }]
        }));
        const transport = createOpenRouterTransport({ apiKey: 'secret-for-test', fetchImpl });
        await expect(transport.preflight({ candidate, plan: { contract } }))
            .rejects.toMatchObject({ code: 'GENERATION_PARAMETER_UNSUPPORTED' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    test('Ollama preflight verifies live digest, runtime version, and context before exact chat', async () => {
        const candidate = localCandidate();
        const fetchImpl = jest.fn(async (url, options) => {
            if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: candidate.model, digest: DIGEST }] });
            if (url.endsWith('/api/version')) return jsonResponse({ version: '0.11.10' });
            if (url.endsWith('/api/show')) {
                expect(JSON.parse(options.body)).toEqual({ model: candidate.model });
                return jsonResponse({ model_info: { 'qwen3.context_length': 32768 } });
            }
            const payload = JSON.parse(options.body);
            expect(payload).toMatchObject({
                model: candidate.model,
                stream: false,
                think: false,
                options: { num_predict: 64, num_ctx: 192, temperature: 0, seed: 42 }
            });
            return jsonResponse({
                done: true,
                message: { content: 'done', tool_calls: [{ function: { name: 'room', arguments: { name: 'kitchen' } } }] },
                prompt_eval_count: 9,
                eval_count: 2
            });
        });
        const transport = createOllamaTransport({ baseUrl: 'http://ollama.invalid:11434', fetchImpl });
        await expect(transport.execute({ candidate, fixture, contract })).rejects.toMatchObject({ code: 'PREFLIGHT_REQUIRED' });
        const identity = await transport.preflight({ candidate });
        const result = await transport.execute({ candidate, fixture, contract });

        expect(identity).toMatchObject({ artifactDigest: DIGEST, apiVersion: 'ollama-0.11.10', contextWindow: 32768 });
        expect(result).toMatchObject({
            ok: true,
            usage: { input: 9, output: 2, cacheRead: 0, cacheWrite: 0 },
            response: { text: 'done' }
        });
        expect(fetchImpl).toHaveBeenCalledTimes(4);
    });

    test('Ollama execution fails closed when HTTP 200 omits the exact terminal receipt', async () => {
        const candidate = localCandidate();
        const fetchImpl = jest.fn(async (url) => {
            if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: candidate.model, digest: DIGEST }] });
            if (url.endsWith('/api/version')) return jsonResponse({ version: '0.11.10' });
            if (url.endsWith('/api/show')) return jsonResponse({ model_info: { 'qwen3.context_length': 32768 } });
            return jsonResponse({ message: { content: 'plausible but incomplete' } });
        });
        const transport = createOllamaTransport({ baseUrl: 'http://ollama.invalid:11434', fetchImpl });
        await transport.preflight({ candidate });

        await expect(transport.execute({ candidate, fixture, contract })).resolves.toMatchObject({
            ok: false,
            error: { code: 'OLLAMA_RESPONSE_INCOMPLETE' }
        });
    });

    test('generic OpenAI-compatible transports refuse unverified model metadata', () => {
        expect(() => createOpenAICompatibleTransport({
            provider: 'example',
            baseUrl: 'https://api.example.invalid/v1',
            apiKey: 'secret-for-test'
        })).toThrow(expect.objectContaining({ code: 'MODEL_RESOLVER_REQUIRED' }));
    });
});
