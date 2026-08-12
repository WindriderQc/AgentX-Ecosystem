'use strict';

const { validateArgsAgainstSchema, gradeScenario } = require('../../../src/services/qualification/toolCallGrader');
const { getScenario, getToolByName } = require('../../../src/services/qualification/toolCallFixtures');

describe('validateArgsAgainstSchema (dependency-free subset)', () => {
  const weather = getToolByName('get_weather').parameters;

  test('accepts valid arguments', () => {
    const r = validateArgsAgainstSchema({ city: 'Montréal', unit: 'celsius' }, weather);
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  test('rejects missing required property', () => {
    const r = validateArgsAgainstSchema({ city: 'Montréal' }, weather);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/unit: required/);
  });

  test('rejects enum violation', () => {
    const r = validateArgsAgainstSchema({ city: 'Montréal', unit: 'kelvin' }, weather);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/not in enum/);
  });

  test('rejects wrong type and unexpected property', () => {
    const r = validateArgsAgainstSchema({ city: 42, unit: 'celsius', bogus: true }, weather);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/expected string/);
    expect(r.errors.join(' ')).toMatch(/unexpected property/);
  });
});

describe('gradeScenario dimensions', () => {
  const s1 = getScenario('s1_selection_basic');

  function transcriptFor(overrides = {}) {
    return {
      calls: [{ name: 'add_personal_task', args: { title: 'acheter du lait' } }],
      executions: [{ ordinal: 0, name: 'add_personal_task', args: { title: 'acheter du lait' }, known: true, offered: true, scripted: true, result: { ok: true }, error: null }],
      finalText: 'C\'est noté : acheter du lait est sur ta liste.',
      toolSupport: true,
      ...overrides
    };
  }

  test('happy path passes every dimension with classification ok', () => {
    const g = gradeScenario(transcriptFor(), s1);
    expect(g.pass).toBe(true);
    expect(g.classification).toBe('ok');
    for (const dim of Object.values(g.dimensions)) expect(dim.pass).toBe(true);
  });

  test('forbidden distractor call fails selection', () => {
    const s2 = getScenario('s2_selection_distractor');
    const g = gradeScenario(transcriptFor({
      calls: [{ name: 'create_dev_ticket', args: { title: 'dentiste', service: 'core', objective: 'x' } }],
      finalText: 'Ticket créé pour le dentiste.'
    }), s2);
    expect(g.dimensions.selection.pass).toBe(false);
    expect(g.classification).toBe('contract_violation');
  });

  test('hallucinated unknown tool is classified explicitly', () => {
    const g = gradeScenario(transcriptFor({
      calls: [{ name: 'send_email', args: {} }],
      finalText: 'Courriel envoyé à ta liste... lait'
    }), s1);
    expect(g.dimensions.selection.pass).toBe(false);
    expect(g.classification).toBe('hallucinated_call');
  });

  test('schema-invalid arguments fail schemaValid', () => {
    const g = gradeScenario(transcriptFor({
      calls: [{ name: 'add_personal_task', args: { titre: 'acheter du lait' } }]
    }), s1);
    expect(g.dimensions.schemaValid.pass).toBe(false);
    expect(g.dimensions.schemaValid.reason).toMatch(/required property missing|unexpected property/);
  });

  test('argument-value error fails argsCorrect while schema stays valid', () => {
    const g = gradeScenario(transcriptFor({
      calls: [{ name: 'add_personal_task', args: { title: 'acheter du pain' } }]
    }), s1);
    expect(g.dimensions.schemaValid.pass).toBe(true);
    expect(g.dimensions.argsCorrect.pass).toBe(false);
  });

  test('no visible final is classified no_final_answer', () => {
    const g = gradeScenario(transcriptFor({ finalText: '' }), s1);
    expect(g.dimensions.visibleFinal.pass).toBe(false);
    expect(g.classification).toBe('no_final_answer');
  });

  test('tool XML leak in final is classified leaked_tool_xml', () => {
    const g = gradeScenario(transcriptFor({
      finalText: 'Noté pour le lait <tool_call>{"name":"add_personal_task"}</tool_call>'
    }), s1);
    expect(g.dimensions.visibleFinal.pass).toBe(false);
    expect(g.classification).toBe('leaked_tool_xml');
  });

  test('unsupported artifact is classified, never scored', () => {
    const g = gradeScenario({ calls: [], executions: [], finalText: '', toolSupport: false }, s1);
    expect(g.dimensions).toBeNull();
    expect(g.pass).toBe(false);
    expect(g.classification).toBe('unsupported_no_tool_call_surface');
  });
});

describe('gradeScenario recovery contract (s4)', () => {
  const s4 = getScenario('s4_exec_error_recovery');

  const errorThenRetryExecs = [
    { ordinal: 0, name: 'lookup_word', args: { word: 'gigantesqe', language: 'fr' }, known: true, offered: true, scripted: true, result: null, error: 'not_found' },
    { ordinal: 1, name: 'lookup_word', args: { word: 'gigantesque', language: 'fr' }, known: true, offered: true, scripted: true, result: { ok: true }, error: null }
  ];

  test('corrected retry passes recovery', () => {
    const g = gradeScenario({
      calls: [
        { name: 'lookup_word', args: { word: 'gigantesqe', language: 'fr' } },
        { name: 'lookup_word', args: { word: 'gigantesque', language: 'fr' } }
      ],
      executions: errorThenRetryExecs,
      finalText: 'Gigantesque veut dire très grand, énorme.',
      toolSupport: true
    }, s4);
    expect(g.dimensions.recovery.pass).toBe(true);
    expect(g.pass).toBe(true);
  });

  test('honest failure without retry passes recovery', () => {
    const g = gradeScenario({
      calls: [{ name: 'lookup_word', args: { word: 'gigantesqe', language: 'fr' } }],
      executions: [errorThenRetryExecs[0]],
      finalText: 'Je n\'ai pas trouvé ce mot dans le lexique.',
      toolSupport: true
    }, s4);
    expect(g.dimensions.recovery.pass).toBe(true);
  });

  test('claiming success after the failed call fails recovery', () => {
    const g = gradeScenario({
      calls: [{ name: 'lookup_word', args: { word: 'gigantesqe', language: 'fr' } }],
      executions: [errorThenRetryExecs[0]],
      finalText: 'gigantesqe veut dire très grand.',
      toolSupport: true
    }, s4);
    expect(g.dimensions.recovery.pass).toBe(false);
    expect(g.dimensions.recovery.reason).toMatch(/claimed success/);
  });
});
