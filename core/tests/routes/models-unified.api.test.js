const express = require('express');
const request = require('supertest');

const mockGetAllModels = jest.fn();
const mockGetModelSources = jest.fn();

jest.mock('../../src/services/modelAggregator', () => ({
  getAllModels: (...args) => mockGetAllModels(...args),
  getModelSources: (...args) => mockGetModelSources(...args)
}));

jest.mock('../../src/services/modelReadinessService', () => ({
  isReadyStage: jest.fn((stage) => ['profiled', 'adapted', 'benchmarked'].includes(stage))
}));

describe('Unified models routes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REQUIRE_PROFILED_MODELS;

    mockGetAllModels.mockResolvedValue([
      {
        name: 'gemma4:26b',
        displayName: 'Gemma 4 26B',
        readiness: { stage: 'adapted' },
        deployment: { status: 'available' }
      },
      {
        name: 'mystery-model',
        displayName: 'Mystery Model',
        readiness: { stage: 'available' },
        deployment: { status: 'available' }
      }
    ]);

    mockGetModelSources.mockResolvedValue({
      ollama: { hosts: [{ url: 'http://secondary:11434', name: 'Host Beta' }], count: 2 },
      custom: { count: 0 },
      registry: { count: 2 }
    });

    app = express();
    app.use('/api/models', require('../../routes/models-unified'));
  });

  it('returns /all as a flat array with readiness data', async () => {
    const response = await request(app)
      .get('/api/models/all?host=http%3A%2F%2Fsecondary%3A11434&status=available')
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body[0].readiness).toEqual({ stage: 'adapted' });
    expect(response.headers['x-require-profiled-models']).toBe('false');
    expect(mockGetAllModels).toHaveBeenCalledWith(expect.objectContaining({
      filters: expect.objectContaining({
        host: 'http://secondary:11434',
        status: 'available'
      })
    }));
  });

  it('marks unprofiled models as chat-blocked when REQUIRE_PROFILED_MODELS=true', async () => {
    process.env.REQUIRE_PROFILED_MODELS = 'true';

    const response = await request(app)
      .get('/api/models/all')
      .expect(200);

    expect(response.body[0].chatAllowed).toBe(true);
    expect(response.body[1].chatAllowed).toBe(false);
    expect(response.headers['x-require-profiled-models']).toBe('true');
  });

  it('returns /catalog with envelope metadata for the catalog UI', async () => {
    const response = await request(app)
      .get('/api/models/catalog')
      .expect(200);

    expect(response.body.status).toBe('success');
    expect(response.body.data.models).toHaveLength(2);
    expect(response.body.data.sources.ollama.count).toBe(2);
    expect(response.body.data.config.requireProfiledModels).toBe(false);
    expect(mockGetAllModels).toHaveBeenCalledWith(expect.objectContaining({
      useCache: false,
      deduplicateOllama: false
    }));
  });
});
