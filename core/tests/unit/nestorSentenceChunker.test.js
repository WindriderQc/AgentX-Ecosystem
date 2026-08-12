'use strict';

const {
  NestorSentenceChunker,
  punctuationBoundary,
  boundedBoundary
} = require('../../src/services/nestorSentenceChunker');

describe('NestorSentenceChunker', () => {
  test('emits complete sentences across arbitrary token boundaries', () => {
    const sentences = [];
    const chunker = new NestorSentenceChunker((sentence) => sentences.push(sentence), {
      minimum: 10,
      maximum: 100
    });

    chunker.push('Bonjour Example User. Voici la');
    chunker.push(' suite de la réponse!');
    chunker.finish();

    expect(sentences).toEqual([
      'Bonjour Example User.',
      'Voici la suite de la réponse!'
    ]);
  });

  test('bounds punctuation-free speech so first audio cannot wait forever', () => {
    const sentences = [];
    const chunker = new NestorSentenceChunker((sentence) => sentences.push(sentence), {
      minimum: 12,
      maximum: 24
    });

    chunker.push('Une longue réponse sans ponctuation mais avec plusieurs mots');
    chunker.finish();

    expect(sentences.length).toBeGreaterThan(1);
    expect(sentences.join(' ')).toBe('Une longue réponse sans ponctuation mais avec plusieurs mots');
    expect(sentences[0].length).toBeLessThanOrEqual(24);
  });

  test('exposes deterministic boundary helpers', () => {
    expect(punctuationBoundary('Courte. Une phrase complète.', 12)).toBe(28);
    expect(boundedBoundary('alpha beta gamma delta', 6, 16)).toBe(16);
  });

  test('applies a speech-only transform without changing boundary detection', () => {
    const sentences = [];
    const chunker = new NestorSentenceChunker((sentence) => sentences.push(sentence), {
      minimum: 6,
      maximum: 100,
      transform: (sentence) => sentence.replace(/^Inconnus:\s*/i, '')
    });

    chunker.push('Inconnus: aucun.');
    chunker.finish();

    expect(sentences).toEqual(['aucun.']);
  });
});
