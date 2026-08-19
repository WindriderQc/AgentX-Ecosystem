const Roundtable = require('../../models/Roundtable');

function baseDocument(overrides = {}) {
  return new Roundtable({
    question: 'How should the council proceed?',
    panelConfig: [{
      agentId: 'codex-reviewer',
      role: 'Codex reviewer',
      runtime: 'codex',
      systemPrompt: 'Provide an operational assessment.'
    }],
    synthesizerConfig: {
      model: 'ax/gemma4:26b-a4b-it-qat',
      systemPrompt: 'Synthesize the council.'
    },
    ...overrides
  });
}

describe('Roundtable v2 model', () => {
  test('redacts private model reasoning from serialized Council records', () => {
    const doc = baseDocument();
    doc.turns = [{
      agentId: 'critic', role: 'Critic', round: 1, model: 'model-a',
      response: 'Final answer.', thinking: 'private reasoning'
    }];
    doc.synthesis = {
      model: 'model-b', response: 'Synthesis.', thinking: 'private synthesis'
    };

    const serialized = doc.toJSON();
    expect(serialized.turns[0].response).toBe('Final answer.');
    expect(serialized.turns[0]).not.toHaveProperty('thinking');
    expect(serialized.synthesis).not.toHaveProperty('thinking');
  });

  test('stores real-runtime participants without accepting command or endpoint overrides', () => {
    const doc = baseDocument({
      panelConfig: [{
        agentId: 'codex-reviewer',
        role: 'Codex reviewer',
        runtime: 'codex',
        runtimeConfig: {
          sessionKey: 'roundtable-council',
          endpoint: 'http://attacker.invalid',
          command: 'rm -rf /'
        },
        systemPrompt: 'Provide an operational assessment.'
      }]
    });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.panelConfig[0].model).toBe('runtime-managed');
    expect(doc.panelConfig[0].runtimeConfig.toObject()).toEqual({
      sessionKey: 'roundtable-council',
      sessionId: null
    });
  });

  test('persists approval-gated governance state', () => {
    const doc = baseDocument({
      governance: { requireApproval: true }
    });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.governance.decisionStatus).toBe('deliberating');
  });

  test('rejects unsupported participant runtime types', () => {
    const doc = baseDocument();
    doc.panelConfig[0].runtime = 'untrusted-shell';
    expect(doc.validateSync()?.errors['panelConfig.0.runtime']).toBeDefined();
  });
});
