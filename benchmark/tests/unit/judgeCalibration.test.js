'use strict';

const { validateCalibrationSet, evaluateCalibrationCase, summarizeCalibrationResults, isAccuracyCalibrationValid } = require('../../src/services/benchmark/judgeCalibration');

const entry = { prompt: '2 + 2?', response: '5', category: 'math', expert_scores: { overall: 0 } };

describe('calibration score presence', () => {
    test('requires complete, accurate grades in addition to correlation', () => {
        const good = { total: 20, scored: 20, correlation: 0.9, mae: 0.7, agreement_rate: 85 };
        expect(isAccuracyCalibrationValid(good)).toBe(true);
        expect(isAccuracyCalibrationValid({ ...good, scored: 3 })).toBe(false);
        expect(isAccuracyCalibrationValid({ ...good, correlation: 1, mae: 2 })).toBe(false);
        expect(isAccuracyCalibrationValid({ ...good, agreement_rate: 50 })).toBe(false);
        expect(isAccuracyCalibrationValid({ ...good, mae: null })).toBe(false);
    });
    test.each([null, undefined, '', ' ', false, Infinity, -1, 11])('does not turn invalid judge score %p into a matching zero', (quality_score) => {
        const result = evaluateCalibrationCase(entry, { quality_score, needs_review: false });
        expect(result).toMatchObject({ judge_score: null, absolute_error: null, within_tolerance: false });
        expect(summarizeCalibrationResults([result])).toMatchObject({ scored: 0, within_tolerance: 0, mae: null });
    });

    test.each([null, undefined, '', false, Infinity, -1, 11])('rejects invalid reference grade %p', (overall) => {
        expect(() => validateCalibrationSet([{ ...entry, expert_scores: { overall } }])).toThrow('invalid entries');
    });

    test('preserves a real zero and applies the default tolerance when omitted or null', () => {
        expect(evaluateCalibrationCase(entry, { quality_score: 0, needs_review: false }))
            .toMatchObject({ judge_score: 0, absolute_error: 0, within_tolerance: true, tolerance: 1 });
        expect(evaluateCalibrationCase({ ...entry, tolerance: null }, { quality_score: '0.5' }))
            .toMatchObject({ judge_score: 0.5, within_tolerance: true, tolerance: 1 });
        expect(evaluateCalibrationCase({ ...entry, tolerance: 0 }, { quality_score: 0.5 }))
            .toMatchObject({ within_tolerance: false, tolerance: 0 });
    });
});
