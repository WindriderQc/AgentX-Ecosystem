const express = require('express');
const request = require('supertest');

const mockAggregate = jest.fn();

jest.mock('../../models/InferenceLog', () => ({
  aggregate: (...args) => mockAggregate(...args)
}));

const telemetryRoutes = require('../../routes/inference-telemetry');

function buildApp() {
  const app = express();
  app.use('/api/telemetry', telemetryRoutes);
  return app;
}

describe('Inference telemetry API', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('filters and summarizes hosts while deriving their top models', async () => {
    mockAggregate.mockResolvedValueOnce([
      {
        host: 'http://primary:11434',
        callCount: 4,
        count: 4,
        avgLatencyMs: 250,
        errorCount: 1,
        errorRate: 25,
        totalTokensIn: 120,
        totalTokensOut: 80,
        models: ['qwen3.5:9b', 'nomic-embed-text:v1.5', 'qwen3.5:9b', 'qwen3.5:9b']
      }
    ]);

    const beforeRequest = Date.now();
    const response = await request(app)
      .get('/api/telemetry/host-summary')
      .query({
        hours: 6,
        host: 'http://primary:11434',
        model: 'qwen3.5:9b',
        caller: 'proxy',
        callerDetailPrefix: 'nestor/',
        taskType: 'buddy_chat',
        status: 'success'
      })
      .expect(200);
    const afterRequest = Date.now();

    const pipeline = mockAggregate.mock.calls[0][0];
    const match = pipeline[0].$match;
    expect(match).toEqual(expect.objectContaining({
      host: 'http://primary:11434',
      model: 'qwen3.5:9b',
      caller: 'proxy',
      taskType: 'buddy_chat',
      status: 'success'
    }));
    expect(String(match.callerDetail)).toBe('/^nestor\\//');
    expect(match.timestamp.$gte).toBeInstanceOf(Date);
    expect(match.timestamp.$gte.getTime()).toBeGreaterThanOrEqual(beforeRequest - 6 * 3600000);
    expect(match.timestamp.$gte.getTime()).toBeLessThanOrEqual(afterRequest - 6 * 3600000);

    expect(response.body).toEqual({
      status: 'success',
      data: [{
        host: 'http://primary:11434',
        callCount: 4,
        count: 4,
        avgLatencyMs: 250,
        errorCount: 1,
        errorRate: 25,
        totalTokensIn: 120,
        totalTokensOut: 80,
        topModels: [
          { model: 'qwen3.5:9b', count: 3 },
          { model: 'nomic-embed-text:v1.5', count: 1 }
        ],
        hostIdentity: {
          key: 'http://primary:11434',
          displayName: 'primary',
          role: null,
          ip: 'primary',
          url: 'http://primary:11434'
        }
      }]
    });
  });

  it('returns the model and caller aggregate contracts', async () => {
    mockAggregate
      .mockResolvedValueOnce([{
        model: 'qwen3.5:9b',
        callCount: 5,
        avgLatencyMs: 300,
        errorCount: 1,
        errorRate: 20,
        avgTokensOut: 42,
        hosts: ['http://primary:11434']
      }])
      .mockResolvedValueOnce([{
        caller: 'proxy',
        callCount: 5,
        avgLatencyMs: 300,
        errorCount: 1,
        errorRate: 20
      }]);

    const modelResponse = await request(app)
      .get('/api/telemetry/model-summary')
      .expect(200);
    const callerResponse = await request(app)
      .get('/api/telemetry/caller-summary')
      .expect(200);

    expect(mockAggregate.mock.calls[0][0][1].$group._id).toBe('$model');
    expect(mockAggregate.mock.calls[1][0][1].$group._id).toBe('$caller');
    expect(modelResponse.body.data[0]).toEqual(expect.objectContaining({
      model: 'qwen3.5:9b',
      avgTokensOut: 42
    }));
    expect(callerResponse.body.data[0]).toEqual(expect.objectContaining({
      caller: 'proxy',
      errorRate: 20
    }));
  });

  it('combines host rows while keeping suspected cold starts off the serving-latency axis', async () => {
    const firstBucket = new Date('2026-07-17T01:00:00.000Z');
    const secondBucket = new Date('2026-07-17T01:15:00.000Z');
    mockAggregate.mockResolvedValueOnce([
      {
        _id: { bucket: firstBucket, host: 'http://primary:11434' },
        calls: 2,
        avgLatencyMs: 200,
        errors: 1,
        latencies: [100, 300, 80000]
      },
      {
        _id: { bucket: firstBucket, host: 'http://secondary:11434' },
        calls: 1,
        avgLatencyMs: 200,
        errors: 0,
        latencies: [200]
      },
      {
        _id: { bucket: secondBucket, host: 'http://primary:11434' },
        calls: 1,
        avgLatencyMs: 400,
        errors: 0,
        latencies: [400]
      }
    ]);

    const response = await request(app)
      .get('/api/telemetry/timeline')
      .query({ hours: 12, bucketMinutes: 15 })
      .expect(200);

    const pipeline = mockAggregate.mock.calls[0][0];
    expect(pipeline[1].$group._id.bucket.$dateTrunc.binSize).toBe(15);
    expect(response.body.data).toEqual([
      {
        bucket: firstBucket.toISOString(),
        calls: 3,
        avgLatencyMs: 200,
        p95LatencyMs: 300,
        errors: 1,
        byHost: {
          'http://primary:11434': 2,
          'http://secondary:11434': 1
        },
        coldStartSuspectedCount: 1,
        coldStartSuspectedMaxMs: 80000
      },
      {
        bucket: secondBucket.toISOString(),
        calls: 1,
        avgLatencyMs: 400,
        p95LatencyMs: 400,
        errors: 0,
        byHost: { 'http://primary:11434': 1 },
        coldStartSuspectedCount: 0,
        coldStartSuspectedMaxMs: null
      }
    ]);
  });

  it('zero-fills empty timeline buckets between observed timestamps', () => {
    const dense = telemetryRoutes.densifyTimeline([
      { bucket: '2026-07-17T01:00:00.000Z', calls: 2 },
      { bucket: '2026-07-17T03:00:00.000Z', calls: 1 },
    ], 60);

    expect(dense).toHaveLength(3);
    expect(dense[1]).toEqual(expect.objectContaining({
      bucket: '2026-07-17T02:00:00.000Z',
      calls: 0,
      avgLatencyMs: null,
      byHost: {},
    }));
  });

  it('bounds telemetry windows and timeline buckets to safe positive ranges', async () => {
    mockAggregate.mockResolvedValue([]);

    const beforeRequest = Date.now();
    await request(app)
      .get('/api/telemetry/timeline')
      .query({ hours: 999999, bucketMinutes: -20 })
      .expect(200);
    const afterRequest = Date.now();

    const pipeline = mockAggregate.mock.calls[0][0];
    const cutoff = pipeline[0].$match.timestamp.$gte.getTime();
    expect(cutoff).toBeGreaterThanOrEqual(beforeRequest - 720 * 3600000);
    expect(cutoff).toBeLessThanOrEqual(afterRequest - 720 * 3600000);
    expect(pipeline[1].$group._id.bucket.$dateTrunc.binSize).toBe(1);

    await request(app)
      .get('/api/telemetry/timeline')
      .query({ hours: -20, bucketMinutes: 999999 })
      .expect(200);

    const boundedPipeline = mockAggregate.mock.calls[1][0];
    expect(boundedPipeline[1].$group._id.bucket.$dateTrunc.binSize).toBe(1440);
  });

  it('returns a stable error envelope when telemetry storage fails', async () => {
    mockAggregate.mockRejectedValueOnce(new Error('telemetry unavailable'));

    const response = await request(app)
      .get('/api/telemetry/caller-summary')
      .expect(500);

    expect(response.body).toEqual({
      status: 'error',
      message: 'telemetry unavailable'
    });
  });
});
