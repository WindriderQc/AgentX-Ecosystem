const { assertJudgeInputUnmodified, assertJudgeOutputComplete } = require('../../src/services/scoring/judgeInput');

test.each([{ done_reason: 'length' }, { done: false }])('rejects explicitly incomplete judge output: %j', data => {
    expect(() => assertJudgeOutputComplete(data)).toThrow('quality was not evaluated');
});

test('completed and legacy verdicts without completion metadata retain their existing behavior', () => {
    expect(() => assertJudgeOutputComplete({ done: true, done_reason: 'stop' })).not.toThrow();
    expect(() => assertJudgeOutputComplete({})).not.toThrow();
});

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
