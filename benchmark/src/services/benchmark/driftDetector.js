/**
 * Drift Detector
 * Compares current batch score distribution to historical baseline.
 * Flags when judge scoring patterns shift significantly.
 */

const logger = require('../../../config/logger');

const DRIFT_THRESHOLDS = {
    mean_shift: 1.0,
    variance_ratio: 2.0,
    min_sample_size: 10
};

/**
 * Compare current batch stats to historical baseline.
 * @param {Object} current  - { mean, variance, count }
 * @param {Object} historical - { mean, variance, count }
 * @returns {Object} { drifted, reasons, mean_delta, variance_ratio, insufficient_data }
 */
function detectDrift(current, historical) {
    if (current.count < DRIFT_THRESHOLDS.min_sample_size ||
        historical.count < DRIFT_THRESHOLDS.min_sample_size) {
        return {
            drifted: false,
            reasons: [],
            mean_delta: 0,
            variance_ratio: 1,
            insufficient_data: true
        };
    }

    const reasons = [];
    const meanDelta = Math.abs(current.mean - historical.mean);
    const varianceRatio = historical.variance > 0
        ? current.variance / historical.variance
        : 1;

    if (meanDelta > DRIFT_THRESHOLDS.mean_shift) {
        reasons.push('mean_shift');
    }

    if (varianceRatio > DRIFT_THRESHOLDS.variance_ratio) {
        reasons.push('variance_spike');
    }

    const drifted = reasons.length > 0;

    if (drifted) {
        logger.warn('Judge drift detected', {
            mean_delta: Math.round(meanDelta * 100) / 100,
            variance_ratio: Math.round(varianceRatio * 100) / 100,
            reasons,
            current_count: current.count,
            historical_count: historical.count
        });
    }

    return {
        drifted,
        reasons,
        mean_delta: Math.round(meanDelta * 100) / 100,
        variance_ratio: Math.round(varianceRatio * 100) / 100,
        insufficient_data: false
    };
}

module.exports = { detectDrift, DRIFT_THRESHOLDS };
