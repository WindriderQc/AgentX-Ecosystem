'use strict';

const { classifyPersona } = require('../../src/services/personaDisposition');

describe('personaDisposition', () => {
  test.each(['Testin', 'testin', ' TESTIN '])('keeps %s as a non-selectable test fixture', (name) => {
    expect(classifyPersona({ name, uiConfig: { type: 'chat' } })).toEqual(expect.objectContaining({
      kind: 'test_fixture',
      selectable: false,
      routeStatus: 'test_only'
    }));
  });

  test('does not infer test status from ordinary persona names', () => {
    expect(classifyPersona({ name: 'testing_mentor', uiConfig: { type: 'chat' } }))
      .toEqual(expect.objectContaining({ kind: 'prompt_asset', selectable: true }));
  });
});
