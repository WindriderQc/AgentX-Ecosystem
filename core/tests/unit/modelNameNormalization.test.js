'use strict';

const {
  normalizeModelName,
  modelNameIdentityKey,
  modelLookupNames,
  modelsMatch
} = require('../../src/helpers/modelNameNormalization');

describe('exact model name normalization', () => {
  it('normalizes only whitespace and the implicit :latest alias', () => {
    expect(normalizeModelName(' owner/model:latest ')).toBe('owner/model');
    expect(normalizeModelName('owner/model:q4_K_M')).toBe('owner/model:q4_K_M');
  });

  it('preserves namespaces as artifact identity', () => {
    expect(normalizeModelName('ax/gemma4:26b')).toBe('ax/gemma4:26b');
    expect(normalizeModelName('library/qwen2.5:7b')).toBe('library/qwen2.5:7b');
    expect(modelLookupNames('ax/gemma4:26b')).toEqual(['ax/gemma4:26b']);
  });

  it('matches exact tags case-insensitively and accepts :latest only', () => {
    expect(modelsMatch('Owner/Model:latest', 'owner/model')).toBe(true);
    expect(modelNameIdentityKey('Owner/Model:latest')).toBe('owner/model');
  });

  it('does not collapse namespaces, families, or tag variants', () => {
    expect(modelsMatch('ax/gemma4:26b', 'gemma4:26b')).toBe(false);
    expect(modelsMatch('gemma4', 'gemma4:26b')).toBe(false);
    expect(modelsMatch('gemma4:26b-q4', 'gemma4:26b-q8')).toBe(false);
  });
});
