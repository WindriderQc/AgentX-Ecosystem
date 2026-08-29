'use strict';

const {
  hasExplicitProbeMetadata,
  hasLegacyCoreCanarySignature,
  isPlaygroundConversation,
  playgroundHistoryFilter
} = require('../../src/services/conversationSurfacePolicy');

describe('conversationSurfacePolicy', () => {
  test('uses explicit namespaced metadata for current internal probes', () => {
    expect(hasExplicitProbeMetadata({ tags: ['agentx:benchmark-canary'] })).toBe(true);
    expect(hasExplicitProbeMetadata({
      source: 'external',
      clientRef: 'benchmark-canary/qwen38'
    })).toBe(true);

    expect(isPlaygroundConversation({
      source: 'external',
      clientRef: 'customer-benchmark',
      title: 'Compare our release canary'
    })).toBe(true);
  });

  test('recognizes only the anchored legacy Core canary signature', () => {
    expect(hasLegacyCoreCanarySignature({
      title: 'Reply exactly FINAL_CORE_QWEN38_OK'
    })).toBe(true);
    expect(hasLegacyCoreCanarySignature({
      title: 'Probe',
      messages: [{ role: 'user', content: '  Reply exactly FINAL_CORE_SMALL_7B_OK  ' }]
    })).toBe(true);

    for (const title of [
      'Can you explain the FINAL_CORE_QWEN38_OK probe?',
      'Write a benchmark canary plan',
      'Reply exactly FINAL_CORE_QWEN38_OK please'
    ]) {
      expect(isPlaygroundConversation({ title, messages: [] })).toBe(true);
    }
  });

  test('publishes a database filter without mutating or deleting records', () => {
    const filter = playgroundHistoryFilter();
    expect(filter).toEqual({ $nor: expect.any(Array) });
    expect(filter.$nor).toHaveLength(4);
    expect(JSON.stringify(filter)).not.toMatch(/delete|archive/i);
  });
});
