'use strict';

const { generateFillPrompt } = require('../../src/services/contextProbePayload');

describe('contextProbePayload', () => {
  it('asks for a multi-token decode sample instead of a one-word answer', () => {
    const { prompt } = generateFillPrompt(2048);

    expect(prompt).toContain('Output the integers 1 through 64');
    expect(prompt).toContain('Stop after 64');
    expect(prompt).not.toContain('exactly one word');
  });

  it('still fills approximately the requested prompt size', () => {
    const { estimatedTokens } = generateFillPrompt(4096);

    expect(estimatedTokens).toBeGreaterThanOrEqual(3900);
  });
});
