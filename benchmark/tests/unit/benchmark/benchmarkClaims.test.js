/**
 * Unit tests for benchmark claim lifecycle helpers.
 *
 * Verifies:
 *   - acquireBenchmarkClaims: claims all requested hosts or throws before
 *     model warmup can unload pinned production models.
 *   - releaseBenchmarkClaims: calls release for every acquired URL, never
 *     throws even when core returns an error — so batch finally-blocks
 *     don't mask the original failure.
 *
 * The helpers live in benchmarkClaimLifecycle.js and are also re-exported
 * from batchOrchestrator for backward-compatible tests.
 */

jest.mock('../../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// Mock the core API client so we can control claim/release outcomes
jest.mock('../../../src/clients/coreApiClient', () => ({
    claimHostForBenchmark: jest.fn(),
    heartbeatBenchmarkClaim: jest.fn(),
    releaseBenchmarkClaim: jest.fn(),
    // Other functions referenced by batchOrchestrator — no-op defaults
    getDedicationStatuses: jest.fn(() => Promise.resolve([])),
    resolveHostKey: jest.fn(() => Promise.resolve(null)),
    restoreDedication: jest.fn(() => Promise.resolve({}))
}));

const coreApiClient = require('../../../src/clients/coreApiClient');
const {
    acquireBenchmarkClaims,
    releaseBenchmarkClaims,
    estimateBenchmarkClaimDurationMs,
    startBenchmarkClaimHeartbeat
} = require('../../../src/services/benchmark/benchmarkClaimLifecycle');

describe('benchmark coordination helpers', () => {
    beforeEach(() => {
        coreApiClient.claimHostForBenchmark.mockReset();
        coreApiClient.releaseBenchmarkClaim.mockReset();
        coreApiClient.heartbeatBenchmarkClaim.mockReset();
    });

    describe('startBenchmarkClaimHeartbeat', () => {
        it('makes an ownership rejection fatal to the active run', async () => {
            const onFatal = jest.fn();
            coreApiClient.heartbeatBenchmarkClaim.mockResolvedValue({ heartbeat: false, reason: 'generation changed' });
            const stop = startBenchmarkClaimHeartbeat(['http://a:11434'], 'batch-lost', 30_000, { onFatal, intervalMs: 60_000 });
            await stop.ready;
            expect(() => stop.assertActive()).toThrow(expect.objectContaining({ code: 'BENCHMARK_CLAIM_LOST' }));
            expect(onFatal).toHaveBeenCalledWith(expect.objectContaining({ code: 'BENCHMARK_CLAIM_LOST' }));
            stop();
        });

        it('treats Core heartbeat transport failure as fatal', async () => {
            coreApiClient.heartbeatBenchmarkClaim.mockRejectedValue(new Error('core unavailable'));
            const stop = startBenchmarkClaimHeartbeat(['http://a:11434'], 'batch-error', 30_000, { intervalMs: 60_000 });
            await stop.ready;
            expect(() => stop.assertActive()).toThrow(/core unavailable/);
            stop();
        });
    });

    describe('acquireBenchmarkClaims', () => {
        const BATCH = 'batch-test-1';

        it('returns every host URL when all claims succeed', async () => {
            coreApiClient.claimHostForBenchmark.mockResolvedValue({ claimed: true });

            const acquired = await acquireBenchmarkClaims(
                ['http://a:11434', 'http://b:11434'],
                BATCH,
                60_000
            );

            expect(acquired).toEqual(['http://a:11434', 'http://b:11434']);
            expect(coreApiClient.claimHostForBenchmark).toHaveBeenCalledTimes(2);
            expect(coreApiClient.claimHostForBenchmark).toHaveBeenCalledWith(
                'http://a:11434',
                BATCH,
                60_000,
                { source: 'benchmark', owner: 'agentx-benchmark' }
            );
        });

        it('throws and releases earlier claims when any claim is rejected', async () => {
            coreApiClient.claimHostForBenchmark
                .mockResolvedValueOnce({ claimed: true })
                .mockResolvedValueOnce({ claimed: false, reason: 'already claimed by batch other' });
            coreApiClient.releaseBenchmarkClaim.mockResolvedValue({ released: true });

            await expect(
                acquireBenchmarkClaims(
                    ['http://a:11434', 'http://b:11434'],
                    BATCH,
                    30_000
                )
            ).rejects.toThrow('Unable to reserve benchmark host http://b:11434');

            expect(coreApiClient.releaseBenchmarkClaim).toHaveBeenCalledWith('http://a:11434', BATCH);
        });

        it('throws on network errors instead of continuing with remaining hosts', async () => {
            coreApiClient.claimHostForBenchmark
                .mockRejectedValueOnce(new Error('ECONNREFUSED'))
                .mockResolvedValueOnce({ claimed: true });

            await expect(
                acquireBenchmarkClaims(
                    ['http://a:11434', 'http://b:11434'],
                    BATCH,
                    30_000
                )
            ).rejects.toThrow('Unable to reserve benchmark host http://a:11434');

            expect(coreApiClient.claimHostForBenchmark).toHaveBeenCalledTimes(1);
        });

        it('returns empty array when called with no hosts', async () => {
            const acquired = await acquireBenchmarkClaims([], BATCH, 30_000);
            expect(acquired).toEqual([]);
            expect(coreApiClient.claimHostForBenchmark).not.toHaveBeenCalled();
        });
    });

    describe('releaseBenchmarkClaims', () => {
        const BATCH = 'batch-test-2';

        it('calls releaseBenchmarkClaim for every acquired host', async () => {
            coreApiClient.releaseBenchmarkClaim.mockResolvedValue({ released: true });

            await expect(releaseBenchmarkClaims(
                ['http://a:11434', 'http://b:11434'],
                BATCH
            )).resolves.toMatchObject({ released: 2, failed: 0 });

            expect(coreApiClient.releaseBenchmarkClaim).toHaveBeenCalledTimes(2);
            expect(coreApiClient.releaseBenchmarkClaim).toHaveBeenCalledWith('http://a:11434', BATCH);
            expect(coreApiClient.releaseBenchmarkClaim).toHaveBeenCalledWith('http://b:11434', BATCH);
        });

        it('never throws when a release fails — batch finally-blocks must not be disturbed', async () => {
            coreApiClient.releaseBenchmarkClaim
                .mockRejectedValueOnce(new Error('core unreachable'))
                .mockResolvedValueOnce({ released: true });

            await expect(
                releaseBenchmarkClaims(['http://a:11434', 'http://b:11434'], BATCH)
            ).resolves.toMatchObject({ released: 1, failed: 1 });

            // Both attempts should still have been made
            expect(coreApiClient.releaseBenchmarkClaim).toHaveBeenCalledTimes(2);
        });

        it('no-ops on empty list', async () => {
            await expect(releaseBenchmarkClaims([], BATCH))
                .resolves.toEqual({ released: 0, failed: 0, details: [] });
            expect(coreApiClient.releaseBenchmarkClaim).not.toHaveBeenCalled();
        });

        it('reports released=false honestly without claiming success', async () => {
            coreApiClient.releaseBenchmarkClaim.mockResolvedValue({
                released: false,
                reason: 'claim generation changed'
            });

            await expect(releaseBenchmarkClaims(['http://a:11434'], BATCH))
                .resolves.toEqual({
                    released: 0,
                    failed: 1,
                    details: [{
                        hostUrl: 'http://a:11434',
                        released: false,
                        reason: 'claim generation changed',
                        runtimeRestore: null,
                        pinRestore: null
                    }]
                });
        });
    });

    describe('estimateBenchmarkClaimDurationMs', () => {
        it('adds a judge-phase budget to the execution estimate', () => {
            const estimateMs = estimateBenchmarkClaimDurationMs({
                hostCount: 1,
                modelCount: 2,
                promptCount: 3,
                executionConfig: {
                    judge_drain_timeout_ms: 30 * 60 * 1000,
                    judge_stall_timeout_ms: 30_000
                },
                executionMode: 'throughput',
                judgeConfig: { concurrency: 2 }
            });

            expect(estimateMs).toBe(270_000);
        });

        it('keeps a too-small explicit estimate from dropping the judge-phase buffer', () => {
            const estimateMs = estimateBenchmarkClaimDurationMs({
                hostCount: 1,
                modelCount: 2,
                promptCount: 1,
                executionConfig: {
                    estimated_duration_ms: 1_000,
                    judge_drain_timeout_ms: 120_000,
                    judge_stall_timeout_ms: 30_000
                },
                executionMode: 'throughput',
                judgeConfig: { concurrency: 2 }
            });

            expect(estimateMs).toBe(90_000);
        });
    });

    describe('end-to-end: acquire then release', () => {
        it('acquires, then releases the same hosts on normal completion', async () => {
            coreApiClient.claimHostForBenchmark.mockResolvedValue({ claimed: true });
            coreApiClient.releaseBenchmarkClaim.mockResolvedValue({ released: true });

            const batchId = 'batch-e2e';
            const hosts = ['http://a:11434', 'http://b:11434'];

            const acquired = await acquireBenchmarkClaims(hosts, batchId, 10_000);
            expect(acquired).toEqual(hosts);

            await releaseBenchmarkClaims(acquired, batchId);

            expect(coreApiClient.releaseBenchmarkClaim.mock.calls.map(c => c[0])).toEqual(hosts);
        });

        it('simulates batch throwing — releases still run (finally semantics)', async () => {
            coreApiClient.claimHostForBenchmark.mockResolvedValue({ claimed: true });
            coreApiClient.releaseBenchmarkClaim.mockResolvedValue({ released: true });

            const batchId = 'batch-throw';
            const hosts = ['http://a:11434'];

            // Simulate the orchestrator's try/finally pattern
            const claimed = await acquireBenchmarkClaims(hosts, batchId, 10_000);
            let caughtError = null;
            try {
                throw new Error('batch exploded');
            } catch (err) {
                caughtError = err;
            } finally {
                await releaseBenchmarkClaims(claimed, batchId);
            }

            expect(caughtError).toBeInstanceOf(Error);
            expect(coreApiClient.releaseBenchmarkClaim).toHaveBeenCalledWith('http://a:11434', batchId);
        });
    });
});
