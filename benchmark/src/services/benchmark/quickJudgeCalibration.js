const QUICK_JUDGE_CALIBRATION_CASES = Object.freeze([
    {
        id: 'json_basic',
        title: 'JSON Basic',
        prompt: 'Respond ONLY as JSON: {"overall": 8, "explanation": "ok"}',
        purpose: 'Confirms the judge can follow a minimal JSON-only response contract.',
        passCriteria: 'The response must parse as JSON and include a numeric overall score.',
        validatorKey: 'numeric-overall'
    },
    {
        id: 'json_multi_dim',
        title: 'JSON Multi-Dimension',
        prompt: 'Score this response. Return ONLY JSON with numeric keys: {"accuracy": 8, "completeness": 7, "overall": 7.5, "explanation": "brief"}',
        purpose: 'Checks whether the judge can emit multiple numeric dimensions without collapsing to prose.',
        passCriteria: 'The response must include overall and at least one additional numeric dimension.',
        validatorKey: 'multi-dimension-json'
    },
    {
        id: 'range_guard',
        title: 'Range Guard',
        prompt: 'Return ONLY JSON with overall score in 0-10: {"overall": 5, "explanation": "range test"}',
        purpose: 'Verifies that the judge stays inside the expected 0-10 scoring range.',
        passCriteria: 'The response must include a numeric overall value between 0 and 10 inclusive.',
        validatorKey: 'bounded-overall'
    },
    {
        id: 'consistency_a',
        title: 'Consistency A',
        prompt: 'Evaluate this fixed response. Return ONLY JSON: {"overall": 6.5, "explanation": "consistency"}',
        purpose: 'First half of a duplicate prompt pair used to detect score drift.',
        passCriteria: 'The response must include a numeric overall score.',
        validatorKey: 'numeric-overall'
    },
    {
        id: 'consistency_b',
        title: 'Consistency B',
        prompt: 'Evaluate this fixed response. Return ONLY JSON: {"overall": 6.5, "explanation": "consistency"}',
        purpose: 'Second half of the duplicate prompt pair used to detect score drift.',
        passCriteria: 'The response must include a numeric overall score and remain close to Consistency A.',
        validatorKey: 'numeric-overall'
    }
]);

const CALIBRATION_VALIDATORS = {
    'numeric-overall': (scores) => typeof scores?.overall === 'number',
    'multi-dimension-json': (scores) => {
        const numericKeys = Object.keys(scores || {}).filter((key) => typeof scores[key] === 'number');
        return numericKeys.length >= 2 && typeof scores?.overall === 'number';
    },
    'bounded-overall': (scores) => typeof scores?.overall === 'number' && scores.overall >= 0 && scores.overall <= 10
};

function getQuickJudgeCalibrationCases() {
    return QUICK_JUDGE_CALIBRATION_CASES.map((testCase) => ({ ...testCase }));
}

function getQuickJudgeCalibrationProtocol() {
    return {
        kind: 'quick-live-check',
        title: 'Quick Judge Calibration',
        description: 'Runs five real judge calls to verify JSON reliability, score-range handling, consistency, and latency.',
        disclaimer: 'This is a fast live protocol check, not the human-grounded accuracy calibration used for deeper validation.',
        tests: getQuickJudgeCalibrationCases().map(({ validatorKey, ...testCase }) => testCase)
    };
}

function evaluateQuickJudgeCalibrationCase(testCase, scores) {
    const validator = CALIBRATION_VALIDATORS[testCase?.validatorKey];
    if (!validator) {
        throw new Error(`Unknown quick judge calibration validator: ${testCase?.validatorKey || 'missing'}`);
    }
    return validator(scores);
}

module.exports = {
    getQuickJudgeCalibrationCases,
    getQuickJudgeCalibrationProtocol,
    evaluateQuickJudgeCalibrationCase
};
