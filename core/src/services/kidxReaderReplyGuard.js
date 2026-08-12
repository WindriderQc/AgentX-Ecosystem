'use strict';

function normalizeLexeme(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’]/g, "'")
    .toLowerCase();
}

function extractRequestedLexeme(text) {
  const input = String(text || '').trim();
  if (!input) return '';
  const plainWord = input.match(/^[«"“']?([\p{L}][\p{L}'’-]{1,39})[»"”'?!.,;:]*$/u);
  if (plainWord?.[1]) return plainWord[1].replace(/[’]/g, "'");
  const word = "([\\p{L}][\\p{L}'’-]{2,39})";
  const patterns = [
    new RegExp(`(?:^|\\s)(?:le\\s+|du\\s+)?mot\\s+[«\"“']?${word}`, 'iu'),
    new RegExp(`(?:^|\\s)(?:ça|ca|cela)\\s+veut\\s+dire\\s+quoi\\s+[«\"“']?${word}`, 'iu'),
    new RegExp(`(?:^|\\s)que\\s+veut\\s+dire\\s+[«\"“']?${word}`, 'iu'),
    new RegExp(`(?:^|\\s)(?:c'est|cest)\\s+quoi\\s+[«\"“']?${word}`, 'iu')
  ];
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match?.[1]) return match[1].replace(/[’]/g, "'");
  }
  return '';
}

function replyMentionsLexeme(replyText, lexeme) {
  const target = normalizeLexeme(lexeme);
  if (!target) return true;
  const tokens = String(replyText || '').match(/[\p{L}][\p{L}'’-]*/gu) || [];
  return tokens.some((token) => normalizeLexeme(token) === target);
}

function guardKidxReaderReply({ userText, replyText } = {}) {
  const target = extractRequestedLexeme(userText);
  if (!target || replyMentionsLexeme(replyText, target)) {
    return { replyText: String(replyText || ''), guarded: false, reason: '', target };
  }
  return {
    replyText: `Je ne veux pas inventer : je ne suis pas certain d’avoir bien entendu « ${target} ». `
      + 'Peux-tu l’épeler ou me montrer le mot ?',
    guarded: true,
    reason: 'target-substituted',
    target
  };
}

module.exports = {
  extractRequestedLexeme,
  guardKidxReaderReply,
  normalizeLexeme,
  replyMentionsLexeme
};
