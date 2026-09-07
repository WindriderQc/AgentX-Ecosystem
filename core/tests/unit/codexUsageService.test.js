const {
  ingestCodexUsage,
  normalizePayload,
  valueSignal,
} = require('../../src/services/codexUsageService');

const SESSION_KEY = 'a'.repeat(64);

function payload(overrides = {}) {
  return {
    version: 1,
    source: 'codex-local',
    hostId: 'host-beta',
    observedAtMs: 1_800_000_000_000,
    sessions: [{
      sessionKey: SESSION_KEY,
      updatedAtMs: 1_800_000_000_000,
      model: 'gpt-5',
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      totalTokens: 120,
    }],
    ...overrides,
  };
}

describe('codexUsageService', () => {
  it('accepts privacy-safe counters and strips unknown payload fields', () => {
    const normalized = normalizePayload(payload({ prompt: 'must never be stored' }));

    expect(normalized).toEqual(expect.objectContaining({
      hostId: 'host-beta',
      sessions: [expect.objectContaining({ sessionKey: SESSION_KEY, totalTokens: 120 })],
    }));
    expect(normalized).not.toHaveProperty('prompt');
    expect(normalized.sessions[0]).not.toHaveProperty('prompt');
  });

  it('rejects unsupported or invalid producer contracts', () => {
    expect(() => normalizePayload(payload({ version: 2 }))).toThrow(/Unsupported/);
    expect(() => normalizePayload(payload({ source: 'unknown' }))).toThrow(/codex-local/);
    expect(() => normalizePayload(payload({ hostId: '../escape' }))).toThrow(/hostId/);
  });

  it('stores only token deltas after the first watermark', async () => {
    const Event = { bulkWrite: jest.fn().mockResolvedValue({ upsertedCount: 1 }) };
    const Watermark = {
      find: jest.fn(() => ({ lean: jest.fn().mockResolvedValue([{
        sessionKey: SESSION_KEY,
        model: 'gpt-5',
        inputTokens: 70,
        cachedInputTokens: 30,
        outputTokens: 10,
        reasoningOutputTokens: 2,
        totalTokens: 80,
      }]) })),
      bulkWrite: jest.fn().mockResolvedValue({}),
    };
    const Account = { updateOne: jest.fn() };

    const result = await ingestCodexUsage(payload(), { Event, Watermark, Account });

    const inserted = Event.bulkWrite.mock.calls[0][0][0].updateOne.update.$setOnInsert;
    expect(inserted).toEqual(expect.objectContaining({
      inputTokens: 30,
      cachedInputTokens: 10,
      outputTokens: 10,
      reasoningOutputTokens: 3,
      totalTokens: 40,
      source: 'codex-local-delta',
    }));
    expect(result).toEqual(expect.objectContaining({ acceptedSessions: 1, insertedEvents: 1, resetSessions: 0 }));
  });

  it('classifies subscription value without inventing API-equivalent savings', () => {
    expect(valueSignal({ sessions: 0, totalTokens: 0 }, 0)[0]).toBe('awaiting-data');
    expect(valueSignal({ sessions: 4, activeDays: 2, totalTokens: 500_000 }, 10)[0]).toBe('light');
    expect(valueSignal({ sessions: 20, activeDays: 12, totalTokens: 4_000_000 }, 20)[0]).toBe('strong');
  });
});
