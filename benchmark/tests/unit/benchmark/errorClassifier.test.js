/**
 * Unit tests for errorClassifier
 * Pure function - no mocks needed.
 */
const { classifyBenchmarkError } = require('../../../src/services/benchmark/errorClassifier');

describe('classifyBenchmarkError', () => {
    describe('infra errors by network pattern', () => {
        test.each([
            ['ECONNREFUSED'],
            ['ECONNRESET'],
            ['EPIPE'],
            ['ENOTFOUND'],
            ['EAI_AGAIN'],
            ['ETIMEDOUT'],
            ['ESOCKETTIMEDOUT'],
            ['socket hang up'],
            ['fetch failed'],
            ['NETWORK error occurred'],
            ['CONNECTION refused'],
            ['Out of Memory'],
            ['OUT_OF_MEMORY'],
            ['OOM detected'],
            ['CUDA out of memory'],
            ['DEVICE NOT FOUND'],
            ['UNEXPECTED EOF'],
            ['Broken Pipe'],
            ['No space left on device'],
            ['KILL signal received'],
            ['RUNNER crashed']
        ])('classifies "%s" as infra', (msg) => {
            const result = classifyBenchmarkError(msg);
            expect(result.infra).toBe(true);
            expect(result.type).toBe('infra');
        });
    });

    describe('infra errors by HTTP status', () => {
        test.each([
            ['HTTP 500: Internal Server Error', 500],
            ['HTTP 502: Bad Gateway', 502],
            ['HTTP 503: Service Unavailable', 503],
            ['HTTP 429: Too Many Requests', 429],
            ['HTTP 408: Request Timeout', 408],
        ])('classifies "%s" as infra with status %d', (msg, expectedStatus) => {
            const result = classifyBenchmarkError(msg);
            expect(result.infra).toBe(true);
            expect(result.httpStatus).toBe(expectedStatus);
        });
    });

    describe('infra errors by timeout wording', () => {
        test.each([
            ['Request timed out'],
            ['request timeout'],
            ['connection aborted'],
            ['AbortError']
        ])('classifies "%s" as infra', (msg) => {
            const result = classifyBenchmarkError(msg);
            expect(result.infra).toBe(true);
        });
    });

    describe('non-infra (model) errors', () => {
        test.each([
            ['Model returned malformed JSON'],
            ['The model refused to answer'],
            ['Context window exceeded'],
            ['HTTP 400: Bad Request'],
            ['HTTP 422: Unprocessable Entity'],
        ])('classifies "%s" as model error', (msg) => {
            const result = classifyBenchmarkError(msg);
            expect(result.infra).toBe(false);
            expect(result.type).toBe('model');
        });
    });

    describe('empty / null input', () => {
        it('handles empty string', () => {
            const result = classifyBenchmarkError('');
            expect(result.infra).toBe(false);
            expect(result.type).toBe('unknown');
        });

        it('handles null', () => {
            const result = classifyBenchmarkError(null);
            expect(result.infra).toBe(false);
            expect(result.type).toBe('unknown');
        });

        it('handles Error object', () => {
            const err = new Error('ECONNREFUSED 127.0.0.1:11434');
            const result = classifyBenchmarkError(err);
            expect(result.infra).toBe(true);
        });
    });

    describe('HTTP status parsing', () => {
        it('returns null httpStatus for non-HTTP errors', () => {
            const result = classifyBenchmarkError('ECONNREFUSED');
            expect(result.httpStatus).toBeNull();
        });

        it('returns null httpStatus for 200 OK (not an infra error)', () => {
            const result = classifyBenchmarkError('HTTP 200: OK');
            expect(result.infra).toBe(false);
            expect(result.httpStatus).toBe(200);
        });
    });
});
