'use strict';

jest.mock('../../../src/services/profiler/profilerOrchestrator', () => ({
  profile: jest.fn().mockResolvedValue({ ok: true })
}));
jest.mock('../../../src/services/profiler/hostProfileService', () => ({
  getById: jest.fn()
}));
jest.mock('../../../src/services/profiler/modelProfileService', () => ({
  getAll: jest.fn()
}));
jest.mock('../../../src/services/hostTestService', () => ({
  checkHost: jest.fn()
}));
jest.mock('../../../src/clients/coreApiClient', () => ({
  getDedicationStatuses: jest.fn().mockResolvedValue([]),
  resolveHostKey: jest.fn(),
  restoreDedication: jest.fn().mockResolvedValue(undefined),
  claimHostForBenchmark: jest.fn().mockResolvedValue({ claimed: true }),
  releaseBenchmarkClaim: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../../../config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}));

const orchestrator = require('../../../src/services/profiler/profilerOrchestrator');
const hostProfileService = require('../../../src/services/profiler/hostProfileService');
const modelProfileService = require('../../../src/services/profiler/modelProfileService');
const hostTestService = require('../../../src/services/hostTestService');
const coreApiClient = require('../../../src/clients/coreApiClient');
const { activeProfileQueues, clearActiveProfilingState } = require('../../../src/services/profiler/activeProfileState');
const { startProfileHostQueue } = require('../../../routes/profiler/pipeline');

const flushPromises = () => new Promise(resolve => setImmediate(resolve));

describe('profile-host queue depth selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearActiveProfilingState();
    hostProfileService.getById.mockResolvedValue({
      hostId: 'host-beta',
      hostUrl: 'http://localhost:11434',
      displayName: 'Example Host'
    });
    hostTestService.checkHost.mockResolvedValue({
      available: true,
      models: ['llama3:8b']
    });
    modelProfileService.getAll.mockResolvedValue([]);
    orchestrator.profile.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    clearActiveProfilingState();
  });

  it('defaults a per-host profile queue to standard depth', async () => {
    const started = await startProfileHostQueue({ hostId: 'host-beta', skipRecentDays: 0 });

    expect(started.depth).toBe('standard');
    expect(activeProfileQueues.get(started.queueId).depth).toBe('standard');

    await flushPromises();
    expect(orchestrator.profile).toHaveBeenCalledWith(
      'llama3:8b',
      'host-beta',
      'http://localhost:11434',
      'standard',
      expect.any(Object)
    );
  });

  it('stops the queue when the host claim is rejected', async () => {
    coreApiClient.claimHostForBenchmark.mockResolvedValue({ claimed: false, reason: 'benchmark batch-42 holds this host' });

    const started = await startProfileHostQueue({ hostId: 'host-beta', skipRecentDays: 0 });
    await flushPromises();

    const tracker = activeProfileQueues.get(started.queueId);
    expect(tracker.cancelled).toBe(true);
    expect(tracker.status).toBe('cancelled');
    expect(tracker.error).toMatch(/reserved/i);
    expect(tracker.models[0].status).toBe('failed');
    expect(orchestrator.profile).not.toHaveBeenCalled();
    expect(coreApiClient.releaseBenchmarkClaim).not.toHaveBeenCalled();
  });

  it('proceeds unclaimed when the claim call itself fails (core unreachable)', async () => {
    coreApiClient.claimHostForBenchmark.mockRejectedValue(new Error('ECONNREFUSED'));

    const started = await startProfileHostQueue({ hostId: 'host-beta', skipRecentDays: 0 });
    await flushPromises();

    const tracker = activeProfileQueues.get(started.queueId);
    expect(tracker.models[0].status).toBe('completed');
    expect(orchestrator.profile).toHaveBeenCalled();
    // No claim was held, so nothing to release
    expect(coreApiClient.releaseBenchmarkClaim).not.toHaveBeenCalled();
  });

  it('releases the claim after a claimed profile completes', async () => {
    coreApiClient.claimHostForBenchmark.mockResolvedValue({ claimed: true });

    const started = await startProfileHostQueue({ hostId: 'host-beta', skipRecentDays: 0 });
    await flushPromises();

    const tracker = activeProfileQueues.get(started.queueId);
    expect(tracker.models[0].status).toBe('completed');
    expect(coreApiClient.releaseBenchmarkClaim).toHaveBeenCalledWith('http://localhost:11434', expect.stringMatching(/^profile-/));
  });

  it('honors explicit full depth for a per-host profile queue', async () => {
    const started = await startProfileHostQueue({ hostId: 'host-beta', depth: 'full', skipRecentDays: 0 });

    expect(started.depth).toBe('full');

    await flushPromises();
    expect(orchestrator.profile).toHaveBeenCalledWith(
      'llama3:8b',
      'host-beta',
      'http://localhost:11434',
      'full',
      expect.any(Object)
    );
  });
});
