'use strict';

const {
  sanitizeNestorReply,
  toSpeakableNestorText,
  extractCompletionMeta,
  completionWasLimited
} = require('../../src/services/nestorReplyPolicy');

describe('Nestor reply policy', () => {
  test('removes hidden reasoning while retaining the final user-facing answer', () => {
    expect(sanitizeNestorReply(
      '<think>private chain of thought</think>\nRéponse finale: Bonjour Example User.'
    )).toBe('Bonjour Example User.');
    expect(sanitizeNestorReply(
      'Analyse interne: choose lane\nLa réponse utile.'
    )).toBe('La réponse utile.');
  });

  test('preserves an exact escalation signal but removes an embedded control token', () => {
    expect(sanitizeNestorReply('[[NESTOR_ESCALATE:requires-tools]]'))
      .toBe('[[NESTOR_ESCALATE:requires-tools]]');
    expect(sanitizeNestorReply('Texte [[NESTOR_ESCALATE:requires-tools]] public.'))
      .toBe('Texte  public.');
  });

  test('turns presentation markup into speech without reading headings, URLs, or code', () => {
    expect(toSpeakableNestorText('### Inconnus: **aucun** — voir https://internal.invalid `traceId`'))
      .toBe('aucun — voir');
    expect(toSpeakableNestorText('```json\n{"internal":true}\n```')).toBe('');
  });

  test('detects explicit and defensive output-limit evidence', () => {
    expect(extractCompletionMeta({
      stats: { completion: { reason: 'length' }, usage: { completionTokens: 160 } }
    })).toEqual({ reason: 'length', tokens: 160 });
    expect(completionWasLimited({ completionReason: 'length', completionTokens: 20 }, 160)).toBe(true);
    expect(completionWasLimited({ completionTokens: 160 }, 160)).toBe(true);
    expect(completionWasLimited({ completionReason: 'stop', completionTokens: 42 }, 160)).toBe(false);
  });
});
