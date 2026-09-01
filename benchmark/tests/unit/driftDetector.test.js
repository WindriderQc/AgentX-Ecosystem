// benchmark/tests/unit/driftDetector.test.js
jest.mock('../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const { detectDrift, DRIFT_THRESHOLDS } = require('../../src/services/benchmark/driftDetector');

describe('Drift Detector', () => {
    it('should detect no drift when distributions are similar', () => {
        const current = { mean: 7.2, variance: 1.5, count: 50 };
        const historical = { mean: 7.0, variance: 1.4, count: 200 };

        const result = detectDrift(current, historical);
        expect(result.drifted).toBe(false);
        expect(result.reasons).toHaveLength(0);
    });

    it('should detect drift when mean shifts beyond threshold', () => {
        const current = { mean: 5.5, variance: 1.5, count: 50 };
        const historical = { mean: 7.0, variance: 1.4, count: 200 };

        const result = detectDrift(current, historical);
        expect(result.drifted).toBe(true);
        expect(result.reasons).toContain('mean_shift');
        expect(result.mean_delta).toBeCloseTo(1.5, 1);
    });

    it('should detect drift when variance doubles', () => {
        const current = { mean: 7.0, variance: 3.2, count: 50 };
        const historical = { mean: 7.0, variance: 1.4, count: 200 };

        const result = detectDrift(current, historical);
        expect(result.drifted).toBe(true);
        expect(result.reasons).toContain('variance_spike');
    });

    it('should handle insufficient data gracefully', () => {
        const current = { mean: 7.0, variance: 1.5, count: 2 };
        const historical = { mean: 7.0, variance: 1.4, count: 5 };

        const result = detectDrift(current, historical);
        expect(result.drifted).toBeNull();
        expect(result.insufficient_data).toBe(true);
        expect(result.mean_delta).toBeNull();
        expect(result.variance_ratio).toBeNull();
    });

    it('detects variance emerging from a zero-variance baseline', () => {
        const current = { mean: 7.0, variance: 0.5, count: 50 };
        const historical = { mean: 7.0, variance: 0, count: 200 };

        const result = detectDrift(current, historical);
        expect(result.drifted).toBe(true);
        expect(result.reasons).toContain('variance_spike');
        expect(result.variance_ratio).toBeNull();
    });

    it('keeps two exact zero-variance cohorts comparable', () => {
        const current = { mean: 7.0, variance: 0, count: 50 };
        const historical = { mean: 7.0, variance: 0, count: 200 };

        const result = detectDrift(current, historical);
        expect(result.drifted).toBe(false);
        expect(result.variance_ratio).toBe(1);
    });

    it('fails closed on non-finite or invalid statistics', () => {
        for (const current of [
            { mean: Number.NaN, variance: 1, count: 50 },
            { mean: 7, variance: -1, count: 50 },
            { mean: 7, variance: 1, count: Number.POSITIVE_INFINITY }
        ]) {
            const result = detectDrift(current, { mean: 7, variance: 1, count: 200 });
            expect(result).toMatchObject({
                drifted: null,
                reasons: ['invalid_statistics'],
                mean_delta: null,
                variance_ratio: null,
                insufficient_data: true,
                invalid_data: true
            });
        }
    });
});
