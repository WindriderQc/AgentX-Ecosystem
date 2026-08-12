const request = require('supertest');

jest.mock('../../src/services/profiler/settingsService', () => ({
  getAll: jest.fn(),
  save: jest.fn(),
  DEFAULTS: {
    degradationThreshold: 30,
    contextFillPct: 25,
    numPredict: 64,
    warmup: true,
    testTimeoutSec: 60,
    baselineModel: 'qwen2.5:3b',
  },
}));

const app = require('../../server');
const settingsService = require('../../src/services/profiler/settingsService');

describe('Profiler Settings Routes', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/profiler/settings', () => {
    it('should return resolved settings', async () => {
      const mockSettings = {
        degradationThreshold: 30,
        contextFillPct: 25,
        numPredict: 64,
        warmup: true,
        testTimeoutSec: 60,
        baselineModel: 'qwen2.5:3b',
      };
      settingsService.getAll.mockResolvedValue(mockSettings);

      const response = await request(app).get('/api/profiler/settings');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockSettings);
      expect(settingsService.getAll).toHaveBeenCalledTimes(1);
    });

    it('should return 500 on service error', async () => {
      settingsService.getAll.mockRejectedValue(new Error('db failure'));

      const response = await request(app).get('/api/profiler/settings');

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ error: 'db failure' });
    });
  });

  describe('PUT /api/profiler/settings', () => {
    it('should save and return updated settings', async () => {
      const updated = {
        degradationThreshold: 50,
        contextFillPct: 25,
        numPredict: 64,
        warmup: true,
        testTimeoutSec: 60,
        baselineModel: 'qwen2.5:3b',
      };
      settingsService.save.mockResolvedValue(updated);

      const response = await request(app)
        .put('/api/profiler/settings')
        .send({ degradationThreshold: 50 });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(updated);
      expect(settingsService.save).toHaveBeenCalledWith({ degradationThreshold: 50 });
    });

    it('should return 500 on save error', async () => {
      settingsService.save.mockRejectedValue(new Error('write failed'));

      const response = await request(app)
        .put('/api/profiler/settings')
        .send({ numPredict: 128 });

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ error: 'write failed' });
    });
  });
});
