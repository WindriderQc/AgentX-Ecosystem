const ModelRegistry = require('../../models/ModelRegistry');
const { connectTestDb, disconnectTestDb, clearTestDb } = require('../helpers/testDb');

describe('ModelRegistry host performance helpers', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    await connectTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('summarizes latest snapshots overall and per host', async () => {
    const model = await ModelRegistry.create({
      modelName: 'qwen2.5:7b',
      displayName: 'Qwen 2.5 7B',
      hostPerformance: [
        {
          hostUrl: 'http://primary:11434',
          hostId: 'primary',
          tokensPerSec: 19.1,
          latencyMs: 2200,
          testedAt: new Date('2026-03-10T12:00:00Z'),
          status: 'pass'
        },
        {
          hostUrl: 'http://primary:11434',
          hostId: 'primary',
          tokensPerSec: 0,
          latencyMs: 60000,
          testedAt: new Date('2026-03-10T11:00:00Z'),
          status: 'timeout'
        },
        {
          hostUrl: 'http://secondary:11434',
          hostId: 'secondary',
          tokensPerSec: 14.2,
          latencyMs: 3100,
          testedAt: new Date('2026-03-10T10:00:00Z'),
          status: 'pass'
        }
      ]
    });

    const summary = ModelRegistry.summarizeHostPerformance(model.toObject());

    expect(summary.latestAny.hostId).toBe('primary');
    expect(summary.latestPass.hostId).toBe('primary');
    expect(summary.byHost['http://primary:11434'].latest.status).toBe('pass');
    expect(summary.byHost['http://secondary:11434'].latestPass.tokensPerSec).toBe(14.2);
  });

  it('fetches latest host-performance summaries for multiple models', async () => {
    await ModelRegistry.create({
      modelName: 'qwen2.5:7b',
      displayName: 'Qwen 2.5 7B',
      hostPerformance: [
        {
          hostUrl: 'http://primary:11434',
          hostId: 'primary',
          tokensPerSec: 19.1,
          latencyMs: 2200,
          testedAt: new Date('2026-03-10T12:00:00Z'),
          status: 'pass'
        }
      ]
    });

    await ModelRegistry.create({
      modelName: 'llama3:8b',
      displayName: 'Llama 3 8B',
      hostPerformance: [
        {
          hostUrl: 'http://secondary:11434',
          hostId: 'secondary',
          tokensPerSec: 12.5,
          latencyMs: 3400,
          testedAt: new Date('2026-03-10T12:00:00Z'),
          status: 'pass'
        }
      ]
    });

    const summaries = await ModelRegistry.getLatestHostPerformanceForModels(['qwen2.5:7b', 'llama3:8b']);

    expect(Object.keys(summaries)).toHaveLength(2);
    expect(summaries['qwen2.5:7b'].latestPass.tokensPerSec).toBe(19.1);
    expect(summaries['llama3:8b'].latestAny.hostId).toBe('secondary');
  });
});