// modelRouter.test.js

// Set env vars BEFORE requiring the module to ensure constants are initialized correctly
process.env.OLLAMA_HOST = 'http://primary:11434';
process.env.OLLAMA_HOST_SECONDARY = 'http://secondary:11434';
process.env.OLLAMA_HOST_TERTIARY = 'http://tertiary:11434';
process.env.MODEL_HEALTH_CACHE_TTL_MS = '0'; // Disable cache for tests

const fetch = require('node-fetch');
const logger = require('../../config/logger');
const modelRouter = require('../../src/services/modelRouter');
const { resolveAdvisoryHost } = require('../../src/helpers/schedulerClient');

// Mock dependencies
jest.mock('node-fetch');
jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../src/helpers/schedulerClient', () => ({
    resolveAdvisoryHost: jest.fn()
}));

// Mock AlertService
jest.mock('../../src/services/alertService', () => ({
    getAlertService: jest.fn(() => ({
        triggerAlert: jest.fn()
    }))
}));

describe('Model Router Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Default healthy fetch
        fetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: () => Promise.resolve({})
        });
        resolveAdvisoryHost.mockImplementation(async ({ fallbackHostUrl, fallbackHostId }) => ({
            source: 'fallback',
            hostId: fallbackHostId || null,
            hostUrl: fallbackHostUrl,
            reason: 'test fallback',
            claimId: null,
            claimExpiresAt: null,
            recommendation: null
        }));

        // Reset state
        modelRouter.resetToPrimary('test_setup');
    });

    describe('Task Classification & Model Selection', () => {
        it('should fall back to secondary for unknown models (advisory routing active)', () => {
            // Advisory system handles per-request routing dynamically.
            // getTargetForModel falls back to secondary (interactive host) for all unknown models.
            expect(modelRouter.getTargetForModel('qwen2.5:7b')).toBe('http://secondary:11434');
            expect(modelRouter.getTargetForModel('qwen3.5:9b')).toBe('http://secondary:11434');
        });

        it('should use fallback routing logic for unknown models', () => {
            // Unknown models fall back to secondary (interactive host)
            expect(modelRouter.getTargetForModel('unknown-model:70b')).toBe('http://secondary:11434');
            expect(modelRouter.getTargetForModel('unknown-model:32b')).toBe('http://secondary:11434');
            expect(modelRouter.getTargetForModel('some-random-small-model')).toBe('http://secondary:11434');
            // Embedding-like models fall back to the lightweight host so primary can stay single-model.
            expect(modelRouter.getTargetForModel('my-embedding-model')).toBe('http://secondary:11434');
        });

        it('should resolve model and host for task types', () => {
            const codeTask = modelRouter.getModelForTask('code_generation');
            expect(codeTask.host).toBe('primary');
            expect(codeTask.url).toBe('http://primary:11434');
            expect(codeTask.model).toBe('ax/gemma4:26b-a4b-it-qat');

            const chatTask = modelRouter.getModelForTask('quick_chat');
            expect(chatTask.host).toBe('secondary');
            expect(chatTask.url).toBe('http://secondary:11434');
        });

        it('should prefer scheduler advice for preferred models when available', async () => {
            resolveAdvisoryHost.mockResolvedValueOnce({
                source: 'scheduler',
                hostId: 'secondary',
                hostUrl: 'http://secondary:11434',
                reason: 'model already loaded',
                claimId: 'claim-123',
                claimExpiresAt: '2026-04-04T18:00:00Z',
                recommendation: { host: 'secondary', hostUrl: 'http://secondary:11434' }
            });

            const result = await modelRouter.routeRequest('hello', {
                preferredModel: 'qwen3.5:9b',
                caller: 'unit-test'
            });

            expect(result.target).toBe('http://secondary:11434');
            expect(result.source).toBe('scheduler');
            expect(result.claimId).toBe('claim-123');
        });

        it('should classify query strings using LLM', async () => {
            fetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ response: 'code_generation' })
            });

            const classification = await modelRouter.classifyQuery('write me a function');
            expect(classification).toBe('code_generation');
        });

        it('should handle classification timeouts/errors gracefully (default to general_chat)', async () => {
             // Logic catches error and returns 'general_chat'
             fetch.mockRejectedValueOnce(new Error('Timeout'));
             const classification = await modelRouter.classifyQuery('fail');
             expect(classification).toBe('general_chat');
        });
    });

    describe('Host Failover Logic', () => {
        it('should route to primary when healthy', async () => {
            // Mock healthy response for getModelHealth -> fetch /api/tags
            fetch.mockResolvedValue({ ok: true });

            const result = await modelRouter.classifyAndRoute('test message', { taskType: 'general_chat' });
            expect(result.host).toBe('http://primary:11434');
            expect(result.failedOver).toBe(false);
        });

        it('should fail over when primary is unhealthy', async () => {
            // Mock sequence:
            // 1. checkHostHealth(primary) -> fail
            // 2. checkHostHealth(secondary) -> success

            fetch.mockImplementation((url) => {
                if (url && url.includes('primary')) return Promise.resolve({ ok: false });
                return Promise.resolve({ ok: true });
            });


            const result = await modelRouter.classifyAndRoute('test message', { taskType: 'general_chat' });

            expect(result.host).toBe('http://secondary:11434');
            expect(result.failedOver).toBe(true);
        });
    });

    describe('State Management', () => {
        it('should allow manual host switching', () => {
            modelRouter.switchHost('http://secondary:11434', 'manual_test');
            const status = modelRouter.getFailoverStatus();
            expect(status.currentHost).toBe('http://secondary:11434');
            expect(status.isFailedOver).toBe(true);
            expect(status.reason).toBe('manual_test');
        });

        it('should allow resetting to primary', () => {
            modelRouter.switchHost('http://secondary:11434', 'manual_test');
            modelRouter.resetToPrimary();

            const status = modelRouter.getFailoverStatus();
            expect(status.currentHost).toBe('http://primary:11434');
            expect(status.isFailedOver).toBe(false);
        });
    });

    describe('Host Health Aggregation', () => {
        it('should return health for all configured hosts', async () => {
            fetch.mockResolvedValue({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ models: [{ name: 'qwen2.5:7b' }] })
            });

            const result = await modelRouter.getAllModelsHealth();

            expect(Array.isArray(result)).toBe(true);
            expect(result).toHaveLength(3);
            expect(result.map((entry) => entry.hostKey).sort()).toEqual(['primary', 'secondary', 'tertiary']);
            result.forEach((entry) => {
                expect(entry.status).toBe('online');
                expect(Array.isArray(entry.models)).toBe(true);
            });
        });
    });
});
