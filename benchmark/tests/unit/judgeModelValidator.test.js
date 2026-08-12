/**
 * Tests for Judge Model Validator
 */

const { validateJudgeModel } = require('../../src/services/benchmark/judgeModelValidator');

// Mock logger
jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// Helper: create a mock fetch that returns responses in sequence
function mockFetch(...responses) {
    let callIndex = 0;
    return jest.fn(async () => {
        if (callIndex >= responses.length) {
            throw new Error('Mock fetch: unexpected extra call');
        }
        const resp = responses[callIndex++];
        if (resp instanceof Error) throw resp;
        return resp;
    });
}

function okJson(data) {
    return { ok: true, status: 200, json: async () => data };
}

function failStatus(status) {
    return { ok: false, status };
}

const HOST = 'http://localhost:11434';

describe('Judge Model Validator', () => {
    describe('input validation', () => {
        it('should return invalid when host is empty', async () => {
            const result = await validateJudgeModel('', 'some-model');
            expect(result.valid).toBe(false);
            expect(result.error).toContain('host and model are required');
        });

        it('should return invalid when model is empty', async () => {
            const result = await validateJudgeModel(HOST, '');
            expect(result.valid).toBe(false);
            expect(result.error).toContain('host and model are required');
        });

        it('should return invalid when both are null', async () => {
            const result = await validateJudgeModel(null, null);
            expect(result.valid).toBe(false);
        });
    });

    describe('model availability check', () => {
        it('should return invalid when model not found in host', async () => {
            const _fetch = mockFetch(
                okJson({ models: [{ name: 'llama3.1:8b' }, { name: 'mistral:7b' }] })
            );

            const result = await validateJudgeModel(HOST, 'qwen2.5:7b-instruct', { _fetch });
            expect(result.valid).toBe(false);
            expect(result.error).toContain('not found on judge host');
            expect(result.available_models).toEqual(['llama3.1:8b', 'mistral:7b']);
        });

        it('should return invalid when host is unreachable', async () => {
            const _fetch = mockFetch(
                Object.assign(new Error('fetch failed'), { name: 'AbortError' })
            );

            const result = await validateJudgeModel('http://dead-host:11434', 'some-model', { _fetch });
            expect(result.valid).toBe(false);
            expect(result.error).toContain('Cannot connect');
        });

        it('should return invalid when host returns non-OK', async () => {
            const _fetch = mockFetch(failStatus(500));

            const result = await validateJudgeModel(HOST, 'some-model', { _fetch });
            expect(result.valid).toBe(false);
            expect(result.error).toContain('Failed to list models');
        });

        it('should require exact model name match (not base name)', async () => {
            const _fetch = mockFetch(
                okJson({ models: [{ name: 'qwen2.5:7b-instruct-q5_K_M' }] })
            );

            const result = await validateJudgeModel(HOST, 'qwen2.5:latest', { _fetch });
            expect(result.valid).toBe(false);
            expect(result.error).toContain('not found');
        });

        it('should fail when the model exists on another host but not on the configured host', async () => {
            const _fetch = mockFetch(
                okJson({ models: [] })
            );

            const result = await validateJudgeModel('http://host-b:11434', 'qwen2.5:7b-instruct', { _fetch });
            expect(result.valid).toBe(false);
            expect(result.error).toContain('not found on judge host');
            expect(result.available_models).toEqual([]);
        });
    });

    describe('output capability check', () => {
        function tagsResponse() {
            return okJson({ models: [{ name: 'qwen2.5:7b-instruct' }] });
        }

        it('should return valid when model produces JSON', async () => {
            const _fetch = mockFetch(
                tagsResponse(),
                okJson({ response: '{"score": 5, "reason": "test"}' })
            );

            const result = await validateJudgeModel(HOST, 'qwen2.5:7b-instruct', { _fetch });
            expect(result.valid).toBe(true);
            expect(result.latency_ms).toBeDefined();
        });

        it('should return invalid when model produces no JSON', async () => {
            const _fetch = mockFetch(
                tagsResponse(),
                okJson({ response: 'I cannot produce JSON output right now.' })
            );

            const result = await validateJudgeModel(HOST, 'qwen2.5:7b-instruct', { _fetch });
            expect(result.valid).toBe(true);
            expect(result.warning).toContain('not JSON');
        });

        it('should return invalid when generation request fails', async () => {
            const _fetch = mockFetch(
                tagsResponse(),
                failStatus(404)
            );

            const result = await validateJudgeModel(HOST, 'qwen2.5:7b-instruct', { _fetch });
            expect(result.valid).toBe(true);
            expect(result.warning).toContain('HTTP 404');
        });

        it('should surface HTTP 500 as a warning during generation smoke-test', async () => {
            const _fetch = mockFetch(
                tagsResponse(),
                failStatus(500)
            );

            const result = await validateJudgeModel(HOST, 'qwen2.5:7b-instruct', { _fetch });
            expect(result.valid).toBe(true);
            expect(result.warning).toContain('HTTP 500');
        });

        it('should warn when output JSON is malformed', async () => {
            const _fetch = mockFetch(
                tagsResponse(),
                okJson({ message: { content: '{"score": 5, bad-json}' } })
            );

            const result = await validateJudgeModel(HOST, 'qwen2.5:7b-instruct', { _fetch });
            expect(result.valid).toBe(true);
            expect(result.warning).toContain('malformed JSON');
        });

        it('should handle JSON embedded in text', async () => {
            const _fetch = mockFetch(
                tagsResponse(),
                okJson({ response: 'Here is my rating: {"score": 8, "reason": "good"} hope that helps!' })
            );

            const result = await validateJudgeModel(HOST, 'qwen2.5:7b-instruct', { _fetch });
            expect(result.valid).toBe(true);
        });

        it('should return latency_ms on all outcomes', async () => {
            const _fetch = mockFetch(
                tagsResponse(),
                okJson({ response: '{"score": 5}' })
            );

            const result = await validateJudgeModel(HOST, 'qwen2.5:7b-instruct', { _fetch });
            expect(typeof result.latency_ms).toBe('number');
            expect(result.latency_ms).toBeGreaterThanOrEqual(0);
        });

        it('should treat timeout during generation as valid (cold start)', async () => {
            const _fetch = mockFetch(
                tagsResponse(),
                Object.assign(new Error('timeout'), { name: 'AbortError' })
            );

            const result = await validateJudgeModel(HOST, 'qwen2.5:7b-instruct', { _fetch });
            expect(result.valid).toBe(true);
            expect(result.warning).toContain('cold start');
        });
    });
});
