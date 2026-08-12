'use strict';

jest.mock('../../../config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}));

const {
  activeProfiles,
  activeProfileQueues,
  clearActiveProfilingState
} = require('../../../src/services/profiler/activeProfileState');
const { assertNoActiveProfiling } = require('../../../src/services/benchmark/batchOrchestrator');

describe('assertNoActiveProfiling (server-side benchmark launch guard)', () => {
  beforeEach(() => clearActiveProfilingState());
  afterEach(() => clearActiveProfilingState());

  it('passes when no profiling is active', () => {
    expect(() => assertNoActiveProfiling(['http://192.0.2.119:11434'])).not.toThrow();
  });

  it('throws when a profile job owns one of the hosts', () => {
    activeProfiles.set('abc123', {
      status: 'running',
      modelName: 'qwen3:8b',
      hostId: 'host-alpha',
      hostUrl: 'http://192.0.2.119:11434',
      startedAt: Date.now()
    });

    expect(() => assertNoActiveProfiling(['http://192.0.2.119:11434']))
      .toThrow(/active profile job \(qwen3:8b\)/);
    try {
      assertNoActiveProfiling(['http://192.0.2.119:11434']);
    } catch (err) {
      expect(err.conflict).toBe('profiling_active');
      expect(err.hostUrl).toBe('http://192.0.2.119:11434');
    }
  });

  it('throws when a profile queue owns one of the hosts', () => {
    activeProfileQueues.set('q1', {
      status: 'running',
      hostId: 'host-beta',
      hostUrl: 'http://192.0.2.12:11434',
      currentIndex: 1,
      total: 4,
      models: [{ name: 'a' }, { name: 'gemma3:12b' }],
      startedAt: Date.now()
    });

    expect(() => assertNoActiveProfiling(['http://192.0.2.12:11434']))
      .toThrow(/active profile queue \(gemma3:12b, 2\/4\)/);
  });

  it('matches hosts by normalized URL (trailing slash, case)', () => {
    activeProfiles.set('abc123', {
      status: 'running',
      modelName: 'qwen3:8b',
      hostId: 'host-alpha',
      hostUrl: 'http://192.0.2.119:11434',
      startedAt: Date.now()
    });

    expect(() => assertNoActiveProfiling(['HTTP://192.0.2.119:11434/']))
      .toThrow(/profiling to finish/);
  });

  it('ignores completed or failed profile jobs', () => {
    activeProfiles.set('abc123', {
      status: 'completed',
      modelName: 'qwen3:8b',
      hostId: 'host-alpha',
      hostUrl: 'http://192.0.2.119:11434',
      startedAt: Date.now()
    });

    expect(() => assertNoActiveProfiling(['http://192.0.2.119:11434'])).not.toThrow();
  });
});
