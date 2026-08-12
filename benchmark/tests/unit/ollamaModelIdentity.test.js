'use strict';

const {
  normalizeOllamaModelName,
  isSameOllamaModel
} = require('../../src/helpers/ollamaModelIdentity');

describe('ollamaModelIdentity', () => {
  it('normalizes latest aliases', () => {
    expect(normalizeOllamaModelName('gemma4:e4b:latest')).toBe('gemma4:e4b');
    expect(normalizeOllamaModelName(' gemma4:26b ')).toBe('gemma4:26b');
  });

  it('matches exact models case-insensitively', () => {
    expect(isSameOllamaModel('GEMMA4:26B', 'gemma4:26b')).toBe(true);
    expect(isSameOllamaModel('gemma4:26b:latest', 'gemma4:26b')).toBe(true);
  });

  it('does not collapse different variants in the same family', () => {
    expect(isSameOllamaModel('gemma4:e4b', 'gemma4:26b')).toBe(false);
    expect(isSameOllamaModel('qwen3:14b', 'qwen3:30b')).toBe(false);
  });
});
