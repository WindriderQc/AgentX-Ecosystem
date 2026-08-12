'use strict';

const {
  buildAdaptedName,
  parseAdaptedName,
  isAdaptedModel,
  AX_PREFIX
} = require('../../../src/services/profiler/namingConvention');

describe('namingConvention', () => {
  describe('AX_PREFIX', () => {
    it('exports AX_PREFIX constant equal to "ax/"', () => {
      expect(AX_PREFIX).toBe('ax/');
    });
  });

  describe('buildAdaptedName', () => {
    it('builds prefixed adapted name', () => {
      expect(buildAdaptedName('llama3.1:8b-q4_K_M')).toBe(
        'ax/llama3.1:8b-q4_K_M'
      );
    });

    it('handles models without explicit quant tag', () => {
      expect(buildAdaptedName('llama3.2:3b')).toBe(
        'ax/llama3.2:3b'
      );
    });

    it('returns as-is if already prefixed', () => {
      expect(buildAdaptedName('ax/gemma2:9b')).toBe(
        'ax/gemma2:9b'
      );
    });

    it('throws on empty modelName', () => {
      expect(() => buildAdaptedName('')).toThrow('modelName is required');
    });
  });

  describe('parseAdaptedName', () => {
    it('extracts base model from a prefixed adapted name', () => {
      expect(parseAdaptedName('ax/llama3.1:8b-q4_K_M')).toEqual({
        baseName: 'llama3.1:8b-q4_K_M'
      });
    });

    it('handles complex model names', () => {
      expect(parseAdaptedName('ax/deepseek-r1:14b-q5_K_M')).toEqual({
        baseName: 'deepseek-r1:14b-q5_K_M'
      });
    });

    it('returns null for non-adapted models', () => {
      expect(parseAdaptedName('llama3.1:8b-q4_K_M')).toBeNull();
    });
  });

  describe('isAdaptedModel', () => {
    it('returns true for ax/-prefixed names', () => {
      expect(isAdaptedModel('ax/llama3.1:8b-q4_K_M')).toBe(true);
    });

    it('returns false for base names', () => {
      expect(isAdaptedModel('llama3.1:8b-q4_K_M')).toBe(false);
    });

    it('returns false for names with "ax" in other positions', () => {
      expect(isAdaptedModel('axolotl:7b')).toBe(false);
    });
  });
});
