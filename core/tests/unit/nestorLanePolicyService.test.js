'use strict';

const { selectNestorLane } = require('../../src/services/nestorLanePolicyService');

describe('Nestor deterministic auto-lane policy', () => {
  test.each([
    ['Bonjour, qui es-tu?', 'bounded-answer'],
    ['Que veut dire gigantesque?', 'bounded-answer'],
    ['Translate this sentence into French.', 'bounded-answer']
  ])('keeps a bounded answer local: %s', (text, reason) => {
    expect(selectNestorLane(text, 'auto')).toEqual({
      requestedLane: 'auto',
      lane: 'answer_light',
      source: 'deterministic-policy-v1',
      reason
    });
  });

  test.each([
    ['Ajoute acheter du lait à ma liste', 'action-or-secretary'],
    ['Consulte ma liste personnelle et dis-moi ce qui est dû', 'action-or-secretary'],
    ['Qu’est-ce que j’ai sur ma liste?', 'action-or-secretary'],
    ['What is on my personal list?', 'action-or-secretary'],
    ['Tu te souviens de mon imprimante?', 'memory'],
    ['Quel est le statut du système AgentX?', 'live-platform'],
    ['Fais un plan exhaustif de cette architecture', 'deep-or-council'],
    ['Ceci est une urgence médicale', 'high-stakes'],
    ['Utilise Nestor complet avec tes outils', 'explicit-complete']
  ])('routes a complete-brain request: %s', (text, reason) => {
    expect(selectNestorLane(text, 'auto')).toEqual({
      requestedLane: 'auto',
      lane: 'front_door',
      source: 'deterministic-policy-v1',
      reason
    });
  });

  test('preserves explicit diagnostic overrides', () => {
    expect(selectNestorLane('Ajoute du lait', 'answer_light')).toMatchObject({
      requestedLane: 'answer_light',
      lane: 'answer_light',
      source: 'explicit'
    });
    expect(selectNestorLane('Bonjour', 'front_door')).toMatchObject({
      requestedLane: 'front_door',
      lane: 'front_door',
      source: 'explicit'
    });
  });

  test('keeps the historical missing-lane default on the complete front door', () => {
    expect(selectNestorLane('Bonjour')).toMatchObject({
      requestedLane: 'front_door',
      lane: 'front_door',
      source: 'explicit'
    });
  });
});
