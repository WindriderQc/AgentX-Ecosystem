'use strict';

jest.mock('../../config/logger', () => ({ warn: jest.fn() }));

const logger = require('../../config/logger');
const {
  FALLBACK_IDENTITY,
  extractIdentityKernel,
  loadNestorIdentityKernel,
  composeNestorPrompt,
  clearNestorIdentityCache
} = require('../../src/services/nestorPersonaService');

describe('Nestor persona kernel', () => {
  beforeEach(() => {
    clearNestorIdentityCache();
    jest.clearAllMocks();
  });

  test('extracts the one marked identity block and strips Markdown emphasis', () => {
    const source = [
      '# Nestor',
      '<!-- agentx:nestor-identity:start -->',
      'You are **Nestor**, warm and concise.',
      '<!-- agentx:nestor-identity:end -->',
      'Tool policy that must not enter Answer-Light.'
    ].join('\n');

    expect(extractIdentityKernel(source)).toBe('You are Nestor, warm and concise.');
  });

  test('loads the canonical block and composes lane-specific constraints', async () => {
    const identity = await loadNestorIdentityKernel({
      rolePath: 'virtual/Nestor.md',
      readFile: async () => [
        '<!-- agentx:nestor-identity:start -->',
        "You are Nestor, Example User's majordomo.",
        '<!-- agentx:nestor-identity:end -->'
      ].join('\n')
    });

    expect(composeNestorPrompt(identity, 'No tools in this lane.')).toBe(
      "You are Nestor, Example User's majordomo.\n\nNo tools in this lane."
    );
  });

  test('falls back safely when the canonical role is unavailable', async () => {
    const identity = await loadNestorIdentityKernel({
      rolePath: 'missing/Nestor.md',
      readFile: async () => { throw new Error('missing'); }
    });

    expect(identity).toBe(FALLBACK_IDENTITY);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('safe fallback'),
      expect.objectContaining({ rolePath: 'missing/Nestor.md', error: 'missing' })
    );
  });
});
