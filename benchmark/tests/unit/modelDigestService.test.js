jest.mock('../../src/clients/ollamaClient', () => ({
    listModels: jest.fn()
}));

jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const { listModels } = require('../../src/clients/ollamaClient');
const {
    getModelDigest,
    clearModelDigestCache,
    _internal
} = require('../../src/services/benchmark/modelDigestService');

describe('modelDigestService', () => {
    beforeEach(() => {
        clearModelDigestCache();
        listModels.mockReset();
    });

    test('returns matching digest from /api/tags', async () => {
        listModels.mockResolvedValue({
            models: [{ name: 'qwen3:30b', digest: 'sha256:abc' }]
        });

        await expect(getModelDigest('http://host:11434', 'qwen3:30b')).resolves.toBe('sha256:abc');
    });

    test('does not borrow a digest from a different namespaced artifact', async () => {
        listModels.mockResolvedValue({
            models: [{ name: 'ax/qwen3:30b', digest: 'sha256:def' }]
        });

        await expect(getModelDigest('http://host:11434', 'qwen3:30b')).resolves.toBeNull();
    });

    test('returns null and negative-caches host failures', async () => {
        listModels.mockRejectedValue(new Error('host down'));

        await expect(getModelDigest('http://host:11434', 'qwen3:30b')).resolves.toBeNull();
        await expect(getModelDigest('http://host:11434', 'qwen3:30b')).resolves.toBeNull();
        expect(listModels).toHaveBeenCalledTimes(1);
    });

    test('namesEquivalent preserves namespaces and accepts only the latest alias', () => {
        expect(_internal.namesEquivalent('ax/qwen3:30b', 'qwen3:30b')).toBe(false);
        expect(_internal.namesEquivalent('qwen3:30b', 'ax/qwen3:30b')).toBe(false);
        expect(_internal.namesEquivalent('qwen3:latest', 'qwen3')).toBe(true);
    });
});
