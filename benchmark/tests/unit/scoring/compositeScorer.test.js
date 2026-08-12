const { calculateCompositeScore } = require('../../../src/services/scoring/compositeScorer');
const logger = require('../../../config/logger');

jest.mock('../../../config/logger', () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

describe('Composite Scorer', () => {
    it('prefers calibrated performance baselines over raw execution metrics', () => {
        const raw = calculateCompositeScore({
            latency: 5000,
            tokens_per_sec: 5,
            quality_score: 8
        }, 'knowledge');

        const calibrated = calculateCompositeScore({
            latency: 5000,
            tokens_per_sec: 5,
            quality_score: 8,
            performance_baseline: {
                latencyMs: 500,
                tokensPerSec: 60
            }
        }, 'knowledge');

        expect(calibrated.composite_score).toBeGreaterThan(raw.composite_score);
        expect(calibrated.normalized.latency).toBeGreaterThan(raw.normalized.latency);
        expect(calibrated.normalized.speed).toBeGreaterThan(raw.normalized.speed);
    });

    it('uses benchmark TTFT as part of responsiveness when available', () => {
        const fastStart = calculateCompositeScore({
            latency: 2000,
            tokens_per_sec: 40,
            time_to_first_token_ms: 250,
            quality_score: 8
        }, 'knowledge');

        const slowStart = calculateCompositeScore({
            latency: 2000,
            tokens_per_sec: 40,
            time_to_first_token_ms: 2200,
            quality_score: 8
        }, 'knowledge');

        expect(fastStart.composite_score).toBeGreaterThan(slowStart.composite_score);
        expect(fastStart.normalized.ttft).toBeGreaterThan(slowStart.normalized.ttft);
        expect(fastStart.normalized.responsiveness).toBeGreaterThan(slowStart.normalized.responsiveness);
    });

    describe('missing latency handling', () => {
        it('does not award a perfect responsiveness score for missing latency', () => {
            const missing = calculateCompositeScore({
                tokens_per_sec: 40,
                quality_score: 5
            }, 'knowledge');

            expect(missing.normalized.latency).toBeNull();
            expect(missing.normalized.responsiveness).toBeNull();

            // With latency unknown, quality+speed weights are renormalized —
            // the composite must not exceed what a genuinely instant response
            // (latency ~0) would earn.
            const instant = calculateCompositeScore({
                latency: 1,
                tokens_per_sec: 40,
                quality_score: 5
            }, 'knowledge');
            expect(missing.composite_score).toBeLessThanOrEqual(instant.composite_score);
        });

        it('treats zero, negative, and NaN latency as unknown', () => {
            for (const latency of [0, -100, 'not-a-number']) {
                const result = calculateCompositeScore({
                    latency,
                    tokens_per_sec: 40,
                    quality_score: 5
                }, 'knowledge');
                expect(result.normalized.latency).toBeNull();
            }
        });

        it('falls back to TTFT for responsiveness when only TTFT is known', () => {
            const result = calculateCompositeScore({
                tokens_per_sec: 40,
                time_to_first_token_ms: 400,
                quality_score: 5
            }, 'knowledge');

            expect(result.normalized.latency).toBeNull();
            expect(result.normalized.ttft).toBeGreaterThan(0);
            expect(result.normalized.responsiveness).toBe(result.normalized.ttft);
        });

        it('keeps the composite on the 0-100 scale when renormalizing', () => {
            const result = calculateCompositeScore({
                tokens_per_sec: 200,
                quality_score: 10
            }, 'knowledge');

            expect(result.composite_score).toBeLessThanOrEqual(100);
            expect(result.composite_score).toBeGreaterThanOrEqual(99);
        });
    });

    // Contract §2.9 (delta 0113): fast-garbage floor.
    describe('quality floor (delta 0113)', () => {
        it('caps composite at quality_score * 10 when quality_score = 0.4', () => {
            const result = calculateCompositeScore({
                latency: 100,
                tokens_per_sec: 100,
                quality_score: 0.4
            }, 'knowledge');

            expect(result.composite_score).toBe(4);
        });

        it('caps composite at quality_score * 10 when quality_score = 2.9', () => {
            const result = calculateCompositeScore({
                latency: 100,
                tokens_per_sec: 100,
                quality_score: 2.9
            }, 'knowledge');

            expect(result.composite_score).toBe(29);
        });

        it('applies the normal composite formula when quality_score = 3', () => {
            const result = calculateCompositeScore({
                latency: 100,
                tokens_per_sec: 100,
                quality_score: 3
            }, 'knowledge');

            // With floor gone, composite comfortably exceeds the floor threshold
            // of 30 because of fast latency+speed contribution.
            expect(result.composite_score).toBeGreaterThan(30);
        });
    });

    describe('category resolution (delta 0113)', () => {
        it('defaults to knowledge category and warns when category is missing', () => {
            logger.warn.mockClear();
            const result = calculateCompositeScore({
                latency: 1000,
                tokens_per_sec: 50,
                quality_score: 7
            });

            expect(result.composite_profile_used).toBe('category:knowledge');
            expect(result.profile).toBe('knowledge');
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('calculateCompositeScore'),
                expect.objectContaining({ defaulted_to: 'knowledge' })
            );
        });

        it('defaults to knowledge when a legacy profile name is passed', () => {
            logger.warn.mockClear();
            const result = calculateCompositeScore({
                latency: 1000,
                tokens_per_sec: 50,
                quality_score: 7
            }, 'interactive');

            expect(result.composite_profile_used).toBe('category:knowledge');
            expect(logger.warn).toHaveBeenCalled();
        });
    });
});
