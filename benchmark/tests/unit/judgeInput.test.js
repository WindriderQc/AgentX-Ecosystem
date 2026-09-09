const { assertJudgeInputUnmodified } = require('../../src/services/scoring/judgeInput');

test.each(['truncation', 'condensation'])('rejects reported upstream %s', change => {
    expect(() => assertJudgeInputUnmodified({ agentx_contract: { contextBudget: {
        transformations: { [change]: { applied: true } }
    } } })).toThrow('quality was not evaluated');
});

test('an estimate alone does not pretend truncation was measured', () => {
    expect(() => assertJudgeInputUnmodified({ agentx_contract: { contextBudget: {
        input: { fits: false }, transformations: { upstreamTruncationRisk: true }
    } } })).not.toThrow();
    expect(() => assertJudgeInputUnmodified({})).not.toThrow();
});
