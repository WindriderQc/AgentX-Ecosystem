'use strict';

const { runHarness, runScenario, makeScriptedTransport } = require('../../../src/services/qualification/toolCallHarness');
const { SCENARIOS_V1, fixtureFingerprint, getScenario } = require('../../../src/services/qualification/toolCallFixtures');

describe('golden dry-run (acceptance criterion 4)', () => {
  test('reference transcripts pass every scenario with zero production tools', async () => {
    const report = await runHarness(makeScriptedTransport(), {
      artifact: { model: 'golden-reference', digest: 'golden', host: 'none' },
      contractSnapshot: { source: 'golden-dry-run' }
    });

    expect(report.toolCallOutcomes.reliability.graded).toBe(SCENARIOS_V1.length);
    expect(report.toolCallOutcomes.reliability.passed).toBe(SCENARIOS_V1.length);
    expect(report.toolCallOutcomes.reliability.ratio).toBe(1);
    expect(report.toolCallOutcomes.classificationCounts).toEqual({ ok: SCENARIOS_V1.length });
    // quality is deliberately absent from this harness (criterion: separation)
    expect(report.quality).toBeNull();
  });

  test('report records fingerprint, versions, and artifact identity (criterion 2)', async () => {
    const report = await runHarness(makeScriptedTransport(), {
      artifact: { model: 'golden-reference', digest: 'sha256:abc', host: 'http://mock' },
      contractSnapshot: { capabilities: { tools: { supported: true } } }
    });
    expect(report.harnessVersion).toBe('toolcall-harness.v1');
    expect(report.fixtureVersion).toBe('toolcall-fixtures.v1');
    expect(report.fixtureFingerprint).toBe(fixtureFingerprint());
    expect(report.fixtureFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(report.artifact.model).toBe('golden-reference');
    expect(report.contractSnapshot.capabilities.tools.supported).toBe(true);
    for (const row of report.toolCallOutcomes.scenarios) {
      expect(row.dimensions).toBeTruthy();
      expect(row.classification).toBe('ok');
    }
  });

  test('fixture fingerprint is stable across calls', () => {
    expect(fixtureFingerprint()).toBe(fixtureFingerprint());
  });
});

describe('adversarial scripted transports fail the right dimensions', () => {
  test('bad agent that fakes an email send fails s6 with a forbidden final', async () => {
    const transport = makeScriptedTransport({
      s6_no_capability_honest: [{ content: "C'est fait, courriel envoyé à ton frère!" }]
    });
    const result = await runScenario(transport, getScenario('s6_no_capability_honest'));
    expect(result.pass).toBe(false);
    expect(result.dimensions.visibleFinal.pass).toBe(false);
  });

  test('agent that calls a tool on the no-call scenario fails selection', async () => {
    const transport = makeScriptedTransport({
      s5_no_call_direct: [
        { toolCalls: [{ name: 'get_weather', args: { city: 'Montréal', unit: 'celsius' } }] },
        { content: '2 + 2 font 4.' }
      ]
    });
    const result = await runScenario(transport, getScenario('s5_no_call_direct'));
    expect(result.dimensions.selection.pass).toBe(false);
    expect(result.classification).toBe('contract_violation');
  });

  test('agent that never finalizes is classified no_final_answer', async () => {
    const transport = makeScriptedTransport({
      s1_selection_basic: [
        { toolCalls: [{ name: 'add_personal_task', args: { title: 'acheter du lait' } }] },
        { toolCalls: [{ name: 'list_personal_tasks', args: {} }] },
        { toolCalls: [{ name: 'list_personal_tasks', args: {} }] }
      ]
    });
    const result = await runScenario(transport, getScenario('s1_selection_basic'));
    expect(result.transcript.finalText).toBeNull();
    expect(result.classification).toBe('no_final_answer');
  });

  test('unsupported transport is classified and excluded from grading (criterion 3)', async () => {
    const transport = makeScriptedTransport({
      s1_selection_basic: [{ toolSupport: false }]
    });
    const result = await runScenario(transport, getScenario('s1_selection_basic'));
    expect(result.dimensions).toBeNull();
    expect(result.classification).toBe('unsupported_no_tool_call_surface');
  });

  test('unscripted extra call is recorded by the mock boundary and fails execution', async () => {
    const transport = makeScriptedTransport({
      s3_args_schema: [
        { toolCalls: [{ name: 'get_weather', args: { city: 'Montréal', unit: 'celsius' } }] },
        { toolCalls: [{ name: 'get_weather', args: { city: 'Québec', unit: 'celsius' } }] },
        { content: 'Il fait -3 °C à Montréal.' }
      ]
    });
    const result = await runScenario(transport, getScenario('s3_args_schema'));
    expect(result.dimensions.execution.pass).toBe(false);
    expect(result.dimensions.execution.reason).toMatch(/unscripted_call/);
  });
});
