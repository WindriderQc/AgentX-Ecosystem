const {
  activeProfiles,
  activeProfileQueues,
  clearActiveProfilingState,
  findActiveProfilingForHost,
  listActiveProfiles,
  listActiveProfileQueues
} = require('../../../src/services/profiler/activeProfileState');

describe('activeProfileState', () => {
  beforeEach(() => {
    clearActiveProfilingState();
  });

  afterEach(() => {
    clearActiveProfilingState();
  });

  it('finds running single-profile jobs by normalized host URL', () => {
    activeProfiles.set('profile-1', {
      status: 'running',
      modelName: 'ax/model-a',
      hostId: 'host-gamma',
      hostUrl: 'http://192.0.2.99:11434/',
      depth: 'quick',
      currentStep: 'throughput',
      stepsCompleted: 1,
      stepsTotal: 5,
      startedAt: Date.now() - 1000
    });

    const matches = findActiveProfilingForHost({ hostUrl: 'http://192.0.2.99:11434' });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      type: 'profile',
      profileId: 'profile-1',
      modelName: 'ax/model-a',
      hostId: 'host-gamma',
      hostUrl: 'http://192.0.2.99:11434/'
    });
  });

  it('finds running profile queues by hostId and reports current model', () => {
    activeProfileQueues.set('queue-1', {
      status: 'running',
      hostId: 'host-beta',
      hostUrl: 'http://192.0.2.12:11434',
      hostName: 'Host Beta',
      depth: 'standard',
      currentIndex: 1,
      total: 3,
      models: [
        { name: 'ax/model-a', status: 'completed' },
        { name: 'ax/model-b', status: 'running' },
        { name: 'ax/model-c', status: 'pending' }
      ],
      startedAt: Date.now() - 2000
    });

    const matches = findActiveProfilingForHost({ hostId: 'host-beta' });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      type: 'profile-host',
      queueId: 'queue-1',
      hostId: 'host-beta',
      currentModel: 'ax/model-b'
    });
  });

  it('ignores completed jobs and stale trackers', () => {
    activeProfiles.set('done', {
      status: 'completed',
      hostId: 'host-gamma',
      hostUrl: 'http://192.0.2.99:11434',
      startedAt: Date.now()
    });
    activeProfileQueues.set('stale', {
      status: 'running',
      hostId: 'host-gamma',
      hostUrl: 'http://192.0.2.99:11434',
      currentIndex: 0,
      total: 1,
      models: [{ name: 'ax/model-a' }],
      startedAt: Date.now() - 25 * 60 * 60 * 1000
    });

    expect(findActiveProfilingForHost({ hostUrl: 'http://192.0.2.99:11434' })).toEqual([]);
    expect(listActiveProfiles()).toEqual([]);
    expect(listActiveProfileQueues()).toEqual([]);
  });
});
