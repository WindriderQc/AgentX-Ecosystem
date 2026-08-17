'use strict';

const {
  BOOTSTRAP_SOUL,
  bootstrapSoul,
  getPersonality,
} = require('../../src/services/personalityAdapters');

describe('personalityAdapters product boundary', () => {
  test.each([
    ['standalone', null],
    ['agentx', 'agentx:buddy.soul'],
  ])('resolves the %s product-owned soul', async (source, ref) => {
    await expect(getPersonality({ source, soulFallback: 'A bounded soul.' }))
      .resolves.toEqual({ soul: 'A bounded soul.', ref });
  });

  test('returns null when no product soul is configured', async () => {
    await expect(getPersonality({ source: 'standalone' })).resolves.toBeNull();
  });

  test('rejects private or unknown personality sources', async () => {
    await expect(getPersonality({ source: 'external-runtime' }))
      .rejects.toThrow('unknown personality source');
  });

  test('uses a stable Agent X bootstrap soul', async () => {
    await expect(bootstrapSoul()).resolves.toBe(BOOTSTRAP_SOUL);
    expect(BOOTSTRAP_SOUL).toContain('AgentX');
  });
});
