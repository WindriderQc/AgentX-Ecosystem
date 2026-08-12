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
        expect(result.drifted).toBe(false);
        expect(result.insufficient_data).toBe(true);
    });
});
