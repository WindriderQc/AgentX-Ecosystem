'use strict';

const fs = require('fs');
const path = require('path');
const {
  validateManifest,
  assertSafeRemoteRoot,
  parseSessionId,
  parseExactJson,
  normalizeToolCalls,
  buildCompletionEnvelope,
  estimatePassAtK,
  buildPassAtKReport,
  gradeBakeoffRun
} = require('../../../src/services/qualification/hermesAgenticBakeoff');

const manifest = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../../config/hermes-agentic-bakeoff.json'),
  'utf8'
));

function call(name, args) {
  return { function: { name, arguments: JSON.stringify(args) } };
}

function goodRun() {
  const root = '/tmp/agentx-hermes-bakeoff/run-1/model-1';
  const turnCalls = {
    1: [call('read_file', { path: `${root}/inputs/context.md` }), call('write_file', { path: `${root}/state/plan.json` })],
    2: [call('read_file', { path: `${root}/inputs/inventory.json` }), call('write_file', { path: `${root}/state/selected.json` })],
    3: [call('patch', { path: `${root}/state/plan.json` })],
    4: [call('terminal', { command: `node ${root}/tools/summary.js ${root}/inputs/inventory.json` }), call('write_file', { path: `${root}/state/summary.json` })],
    5: [
      call('terminal', { command: `node ${root}/tools/missing-check.js` }),
      call('read_file', { path: `${root}/tools/README.md` }),
      call('terminal', { command: `node ${root}/tools/verify.js` }),
      call('write_file', { path: `${root}/state/recovery.json` })
    ],
    6: [],
    7: [call('execute_code', { code: 'sum([13,21,34,55,89])' }), call('write_file', { path: `${root}/state/code-result.json` })],
    8: [call('write_file', { path: `${root}/state/reminder.json` })],
    9: [],
    10: [call('terminal', { command: `node ${root}/tools/region-check.js "${root}/inputs/region map.json" ca-central-1` }), call('write_file', { path: `${root}/state/region.json` })],
    11: [call('read_file', { path: `${root}/inputs/request.txt` }), call('write_file', { path: `${root}/state/decision.json` })],
    12: [call('terminal', { command: `node ${root}/tools/final-verify.js ${root}` })]
  };
  const outputs = {
    6: '{"turn":6,"action":"report-only","token":"amber-otter-731"}',
    9: '{"turn":9,"status":"holding","next":"region-check"}',
    12: '{"status":"complete","verified":true,"project":"helios","token":"amber-otter-731"}'
  };
  const messages = [];
  for (const turn of manifest.scenario.turns) {
    messages.push({ id: turn.id * 10, role: 'user', content: turn.prompt });
    messages.push({
      id: turn.id * 10 + 1,
      role: 'assistant',
      content: outputs[turn.id] || `TURN${turn.id}_OK`,
      tool_calls: turnCalls[turn.id]
    });
    if (turn.id === 5) {
      messages.push({ id: 52, role: 'tool', tool_name: 'terminal', content: 'MODULE_NOT_FOUND: missing-check.js' });
    }
  }
  return {
    sessionId: 'session-1',
    turns: manifest.scenario.turns.map((turn) => ({
      ...turn,
      output: outputs[turn.id] || `TURN${turn.id}_OK`,
      exitCode: 0
    })),
    session: { id: 'session-1', message_count: messages.length, tool_call_count: 21, messages },
    artifacts: {
      state: {
        plan: {
          project: 'helios', owner: 'Mira Chen', policy_code: 'POL-731',
          region: 'ca-central-1', retention_days: 37,
          retention_token: 'amber-otter-731', record_count: 120,
          phase: 'triage', attempts: 1
        },
        selected: { selected: ['api', 'cache', 'ingress'] },
        summary: { enabled: 4, criticalEnabled: 3, ids: ['api', 'cache', 'ingress'] },
        recovery: { verified: true, code: 'RECOVERY-731' },
        'code-result': { sum: 212, average: 42 },
        reminder: { project: 'helios', owner: 'Mira Chen', policy_code: 'POL-731', retention_token: 'amber-otter-731' },
        region: { region: 'ca-central-1', zoneCount: 3, primary: 'ca-central-1a' },
        decision: { action: 'report-only', decoy_ignored: true, policy_code: 'POL-731' }
      },
      finalVerification: { verified: true, checks: 8, project: 'helios' }
    }
  };
}

describe('Hermes agentic bake-off manifest', () => {
  test('freezes exactly three candidates, 12 turns, and every dimension', () => {
    expect(manifest.hermes.ignoreUserConfig).toBe(true);
    expect(validateManifest(manifest)).toEqual(expect.objectContaining({
      turnCount: 12,
      weightTotal: 100
    }));
  });

  test('fails closed when a candidate or required dimension is missing', () => {
    const badModels = structuredClone(manifest);
    badModels.models.pop();
    expect(() => validateManifest(badModels)).toThrow(/exactly/);
    const badDimension = structuredClone(manifest);
    badDimension.scenario.turns.forEach((turn) => {
      turn.dimensions = turn.dimensions.filter((dimension) => dimension !== 'completion');
    });
    expect(() => validateManifest(badDimension)).toThrow(/completion/);
  });
});

describe('Hermes runner parsing and safety', () => {
  test('accepts only the dedicated two-level scratch root', () => {
    expect(assertSafeRemoteRoot('/tmp/agentx-hermes-bakeoff/run-1/model-1'))
      .toBe('/tmp/agentx-hermes-bakeoff/run-1/model-1');
    expect(() => assertSafeRemoteRoot('/tmp/agentx-hermes-bakeoff')).toThrow(/unsafe/);
    expect(() => assertSafeRemoteRoot('/home/agentx')).toThrow(/unsafe/);
  });

  test('parses the latest Hermes session id and strict JSON after quiet-mode metadata', () => {
    expect(parseSessionId('\nsession_id: first\nx\nsession_id: second\n')).toBe('second');
    expect(parseExactJson('↻ Resumed session abc (1 user message)\n\nsession_id: abc\n{\"ok\":true}'))
      .toEqual(expect.objectContaining({ ok: true, value: { ok: true } }));
  });

  test('normalizes JSON-string and object tool calls', () => {
    const calls = normalizeToolCalls({ messages: [
      { tool_calls: JSON.stringify([call('read_file', { path: '/tmp/a' })]) },
      { tool_calls: [call('terminal', { command: 'node x' })] }
    ] });
    expect(calls.map((item) => item.name)).toEqual(['read_file', 'terminal']);
    expect(calls[0].arguments).toEqual({ path: '/tmp/a' });
  });
});

describe('deterministic Hermes agentic grading', () => {
  test('awards a complete known-good trace', () => {
    const grade = gradeBakeoffRun(goodRun());
    expect(grade).toEqual(expect.objectContaining({ score: 100, maxScore: 100, pass: true }));
    expect(grade.dimensions.error_recovery.score).toBe(15);
    expect(grade.dimensions.restraint.score).toBe(10);
  });

  test('treats object key order as irrelevant while preserving exact values', () => {
    const run = goodRun();
    run.artifacts.state.plan = {
      attempts: 1,
      phase: 'triage',
      record_count: 120,
      retention_token: 'amber-otter-731',
      retention_days: 37,
      region: 'ca-central-1',
      policy_code: 'POL-731',
      owner: 'Mira Chen',
      project: 'helios'
    };
    expect(gradeBakeoffRun(run)).toEqual(expect.objectContaining({ score: 100, pass: true }));
  });

  test('does not misclassify Hermes tool-limit notices as scenario turns', () => {
    const run = goodRun();
    const firstUser = run.session.messages.findIndex((message) => message.role === 'user');
    run.session.messages.splice(firstUser + 2, 0, {
      role: 'user',
      content: "You've reached the maximum number of tool-calling iterations allowed. Please proceed."
    });
    const grade = gradeBakeoffRun(run);
    expect(grade).toEqual(expect.objectContaining({ score: 100, pass: true }));
    expect(grade.trace).toEqual(expect.objectContaining({ userTurnCount: 12, rawUserMessageCount: 13 }));
  });

  test('fails closed on malformed schema evidence and a missing tool error', () => {
    const run = goodRun();
    run.turns.find((turn) => turn.id === 6).output = '```json\n{\"turn\":6}\n```';
    run.session.messages = run.session.messages.filter((message) => message.role !== 'tool');
    run.artifacts.finalVerification = { verified: false, checks: 2 };
    const grade = gradeBakeoffRun(run);
    expect(grade.pass).toBe(false);
    expect(grade.score).toBeLessThan(100);
    expect(grade.dimensions.schema_reliability.checks.find((item) => item.name === 'turn6 exact JSON').pass).toBe(false);
    expect(grade.dimensions.error_recovery.checks.find((item) => item.name === 'real missing-command failure observed').pass).toBe(false);
  });

  test('adapts only independently verified tool work into the exact completion envelope', () => {
    const run = goodRun();
    run.turns.find((turn) => turn.id === 12).output =
      'I finished the work.\n{"status":"complete","verified":true,"project":"helios","token":"amber-otter-731"}';
    const envelope = buildCompletionEnvelope(run);
    expect(envelope).toEqual(expect.objectContaining({
      available: true,
      rawExact: false,
      text: '{"status":"complete","verified":true,"project":"helios","token":"amber-otter-731"}'
    }));
    expect(gradeBakeoffRun(run).completionContract).toEqual(expect.objectContaining({
      rawExact: false,
      adaptedExact: true
    }));

    run.artifacts.finalVerification.verified = false;
    expect(buildCompletionEnvelope(run)).toEqual(expect.objectContaining({
      available: false,
      text: null
    }));
    expect(gradeBakeoffRun(run).pass).toBe(false);
  });
});

describe('pass@k qualification', () => {
  test('uses the unbiased estimator and reports raw versus adapted contracts', () => {
    expect(estimatePassAtK(3, 1, 1)).toBeCloseTo(1 / 3);
    expect(estimatePassAtK(3, 1, 3)).toBe(1);
    expect(() => estimatePassAtK(2, 1, 3)).toThrow(/invalid/);

    const report = buildPassAtKReport([
      { model: 'm', grade: { pass: true }, completionEnvelope: { rawExact: false, available: true } },
      { model: 'm', grade: { pass: false }, completionEnvelope: { rawExact: true, available: false } },
      { model: 'm', grade: { pass: false }, completionEnvelope: { rawExact: false, available: false } }
    ]);
    expect(report[0]).toEqual(expect.objectContaining({
      model: 'm',
      samples: 3,
      correct: 1,
      observedPassRate: 1 / 3,
      rawExactCompletionRate: 1 / 3,
      adaptedCompletionRate: 1 / 3
    }));
    expect(report[0].passAtK['pass@1']).toBeCloseTo(1 / 3);
    expect(report[0].passAtK['pass@3']).toBe(1);
  });
});
