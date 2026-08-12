'use strict';

const {
  modelNameIdentityKey,
  normalizeModelName,
  modelsMatch
} = require('../../src/helpers/modelNameNormalization');

describe('normalizeModelName', () => {
  it('strips ax/ prefix', () => {
    expect(normalizeModelName('ax/gemma4:26b')).toBe('gemma4:26b');
  });

  it('strips known wrapper prefixes', () => {
    expect(normalizeModelName('library/qwen2.5:7b')).toBe('qwen2.5:7b');
    expect(normalizeModelName('hf.co/Jackrong/Qwopus3.6-27B-Coder-MTP-GGUF:Q5_K_M'))
      .toBe('Jackrong/Qwopus3.6-27B-Coder-MTP-GGUF:Q5_K_M');
  });

  it('preserves owner/model names after wrapper stripping', () => {
    expect(normalizeModelName('VladimirGav/gemma4-26b-16GB-VRAM'))
      .toBe('VladimirGav/gemma4-26b-16GB-VRAM');
    expect(normalizeModelName('ax/igorls/gemma-4-E4B-it-heretic-GGUF:latest'))
      .toBe('igorls/gemma-4-E4B-it-heretic-GGUF');
  });

  it('strips :latest suffix', () => {
    expect(normalizeModelName('gemma4:26b:latest')).toBe('gemma4:26b');
    expect(normalizeModelName('gemma4:26b:LATEST')).toBe('gemma4:26b');
  });

  it('strips :latest together with ax/ prefix', () => {
    expect(normalizeModelName('ax/gemma4:26b:latest')).toBe('gemma4:26b');
  });

  it('leaves bare names untouched', () => {
    expect(normalizeModelName('gemma4:26b')).toBe('gemma4:26b');
    expect(normalizeModelName('qwen2.5:7b-instruct-q5_K_M')).toBe('qwen2.5:7b-instruct-q5_K_M');
  });

  it('handles whitespace and nullish input', () => {
    expect(normalizeModelName('  gemma4:26b  ')).toBe('gemma4:26b');
    expect(normalizeModelName(null)).toBe('');
    expect(normalizeModelName(undefined)).toBe('');
    expect(normalizeModelName('')).toBe('');
  });

  it('does not collapse tag variants', () => {
    // Tag variants address different weights/quantizations — must stay distinct.
    expect(normalizeModelName('gemma4:e4b-it-q8_0')).toBe('gemma4:e4b-it-q8_0');
    expect(normalizeModelName('gemma4:e4b')).toBe('gemma4:e4b');
  });

  it('does not strip trailing slashes or trailing namespace markers', () => {
    expect(normalizeModelName('gemma4:26b/')).toBe('gemma4:26b/');
    expect(normalizeModelName('/gemma4:26b')).toBe('/gemma4:26b');
  });
});

describe('modelNameIdentityKey', () => {
  it('case-folds normalized names for comparisons without changing normalizeModelName output', () => {
    expect(normalizeModelName('ax/Qwen3.5:9b')).toBe('Qwen3.5:9b');
    expect(modelNameIdentityKey('ax/Qwen3.5:9b')).toBe('qwen3.5:9b');
    expect(modelNameIdentityKey('qwen3.5:9b')).toBe('qwen3.5:9b');
  });

  it('is idempotent for owner/model names', () => {
    expect(modelNameIdentityKey('ax/igorls/gemma-4-E4B-it-heretic-GGUF:latest'))
      .toBe('igorls/gemma-4-e4b-it-heretic-gguf');
    expect(modelNameIdentityKey('igorls/gemma-4-E4B-it-heretic-GGUF'))
      .toBe('igorls/gemma-4-e4b-it-heretic-gguf');
    expect(modelNameIdentityKey('gemma-4-E4B-it-heretic-GGUF'))
      .toBe('gemma-4-e4b-it-heretic-gguf');
  });
});

describe('modelsMatch', () => {
  it('matches exact equal strings', () => {
    expect(modelsMatch('gemma4:26b', 'gemma4:26b')).toBe(true);
  });

  it('matches ax/ prefix against bare name', () => {
    expect(modelsMatch('ax/gemma4:26b', 'gemma4:26b')).toBe(true);
    expect(modelsMatch('gemma4:26b', 'ax/gemma4:26b')).toBe(true);
  });

  it('matches wrapped owner/model names without collapsing the owner namespace', () => {
    expect(modelsMatch(
      'ax/igorls/gemma-4-E4B-it-heretic-GGUF:latest',
      'igorls/gemma-4-E4B-it-heretic-GGUF'
    )).toBe(true);
    expect(modelsMatch(
      'igorls/gemma-4-E4B-it-heretic-GGUF',
      'gemma-4-E4B-it-heretic-GGUF'
    )).toBe(false);
  });

  it('matches :latest variants', () => {
    expect(modelsMatch('gemma4:26b:latest', 'gemma4:26b')).toBe(true);
  });

  it('matches case variants of the same normalized model name', () => {
    expect(modelsMatch('ax/Qwen3.5:9b', 'qwen3.5:9b')).toBe(true);
  });

  it('matches tag-prefix (bare family → specific tag)', () => {
    expect(modelsMatch('gemma4', 'gemma4:26b')).toBe(true);
    expect(modelsMatch('gemma4:26b', 'gemma4')).toBe(true);
  });

  it('does NOT match different tag variants of the same family', () => {
    // These are different quantizations; comparing equal would be wrong.
    expect(modelsMatch('gemma4:e4b', 'gemma4:e4b-it-q8_0')).toBe(false);
    expect(modelsMatch('gemma4:26b', 'gemma4:31b')).toBe(false);
  });

  it('does NOT match across families', () => {
    expect(modelsMatch('gemma4:26b', 'qwen2.5:7b')).toBe(false);
  });

  it('rejects nullish inputs', () => {
    expect(modelsMatch(null, 'gemma4:26b')).toBe(false);
    expect(modelsMatch('gemma4:26b', null)).toBe(false);
    expect(modelsMatch('', '')).toBe(false);
  });

  it('matches ax/ + :latest composite against bare', () => {
    expect(modelsMatch('ax/gemma4:26b:latest', 'gemma4:26b')).toBe(true);
  });
});
