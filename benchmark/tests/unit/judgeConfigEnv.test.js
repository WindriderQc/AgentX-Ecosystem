/**
 * Judge Config Env Override Tests
 * Verifies JUDGE_MODEL, JUDGE_HOST, JUDGE_TEMPERATURE, JUDGE_NUM_PREDICT,
 * JUDGE_NUM_CTX environment variables override JUDGE_CONFIG defaults.
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
});

function loadFresh() {
    jest.resetModules();
    // Re-register mocks after module reset
    jest.doMock('../../config/logger', () => ({
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
    }));
    jest.doMock('../../src/helpers/httpAgent', () => ({
        getFetchOptions: jest.fn((url, opts) => opts)
    }));
    return require('../../src/services/scoring/judgeCall');
}

describe('JUDGE_CONFIG env overrides', () => {
    it('uses JUDGE_MODEL from env', () => {
        process.env.JUDGE_MODEL = 'custom-judge:latest';
        const { JUDGE_CONFIG } = loadFresh();
        expect(JUDGE_CONFIG.model).toBe('custom-judge:latest');
    });

    it('falls back to hardcoded model when JUDGE_MODEL is unset', () => {
        delete process.env.JUDGE_MODEL;
        const { JUDGE_CONFIG } = loadFresh();
        expect(JUDGE_CONFIG.model).toBe('qwen2.5:7b-instruct-q5_K_M');
    });

    it('uses JUDGE_HOST from env (takes priority over OLLAMA_HOST)', () => {
        process.env.JUDGE_HOST = 'http://10.0.0.1:11434';
        process.env.OLLAMA_HOST = 'http://10.0.0.2:11434';
        const { JUDGE_CONFIG } = loadFresh();
        expect(JUDGE_CONFIG.host).toBe('http://10.0.0.1:11434');
    });

    it('falls back to OLLAMA_HOST when JUDGE_HOST is unset', () => {
        delete process.env.JUDGE_HOST;
        process.env.OLLAMA_HOST = 'http://10.0.0.2:11434';
        const { JUDGE_CONFIG } = loadFresh();
        expect(JUDGE_CONFIG.host).toBe('http://10.0.0.2:11434');
    });

    it('uses JUDGE_TEMPERATURE from env', () => {
        process.env.JUDGE_TEMPERATURE = '0.5';
        const { JUDGE_CONFIG } = loadFresh();
        expect(JUDGE_CONFIG.temperature).toBe(0.5);
    });

    it('uses JUDGE_NUM_PREDICT from env', () => {
        process.env.JUDGE_NUM_PREDICT = '1200';
        const { JUDGE_CONFIG } = loadFresh();
        expect(JUDGE_CONFIG.num_predict).toBe(1200);
    });

    it('uses JUDGE_NUM_CTX from env', () => {
        process.env.JUDGE_NUM_CTX = '16384';
        const { JUDGE_CONFIG } = loadFresh();
        expect(JUDGE_CONFIG.num_ctx).toBe(16384);
    });

    it('preserves non-overridden defaults when env vars are set', () => {
        process.env.JUDGE_MODEL = 'override-model';
        const { JUDGE_CONFIG } = loadFresh();
        expect(JUDGE_CONFIG.timeout).toBe(60000);
        expect(JUDGE_CONFIG.max_retries).toBe(2);
    });
});
