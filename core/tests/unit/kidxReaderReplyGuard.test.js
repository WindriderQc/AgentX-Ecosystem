'use strict';

const {
  extractRequestedLexeme,
  guardKidxReaderReply,
  replyMentionsLexeme
} = require('../../src/services/kidxReaderReplyGuard');

describe('KidX reader reply guard', () => {
  test.each([
    ['gigantesque', 'gigantesque'],
    ['Que veut dire gigantesque?', 'gigantesque'],
    ['Ça veut dire quoi flibertinou?', 'flibertinou'],
    ['Euh... dans mon livre il y a le mot farfelu, ça veut dire quoi?', 'farfelu']
  ])('extracts the requested word without parsing the whole utterance: %s', (text, expected) => {
    expect(extractRequestedLexeme(text)).toBe(expected);
  });

  test('matches accents and apostrophe variants without fuzzy word substitution', () => {
    expect(replyMentionsLexeme('Énorme veut dire très grand.', 'énorme')).toBe(true);
    expect(replyMentionsLexeme('Un flibertibou est rigolo.', 'flibertinou')).toBe(false);
  });

  test('replaces a silently substituted target with a deterministic uncertainty reply', () => {
    const result = guardKidxReaderReply({
      userText: 'Ça veut dire quoi flibertinou?',
      replyText: 'Un flibertibou est un personnage étourdi.'
    });

    expect(result).toMatchObject({
      guarded: true,
      reason: 'target-substituted',
      target: 'flibertinou'
    });
    expect(result.replyText).toContain('« flibertinou »');
    expect(result.replyText).toContain('Peux-tu l’épeler');
    expect(result.replyText).not.toContain('flibertibou');
  });

  test('preserves a definition that repeats the exact requested word', () => {
    const replyText = 'Farfelu veut dire bizarre ou rigolo.';
    expect(guardKidxReaderReply({
      userText: 'Que veut dire farfelu?',
      replyText
    })).toEqual({ replyText, guarded: false, reason: '', target: 'farfelu' });
  });
});
