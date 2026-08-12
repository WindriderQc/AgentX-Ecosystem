const request = require('supertest');

jest.mock('../../src/services/profiler/adaptationService', () => ({
  getAdaptation: jest.fn(),
  getAdaptedRoster: jest.fn(),
  deployToHost: jest.fn(),
  validateModelfile: jest.fn(),
  hashModelfile: jest.fn()
}));
jest.mock('../../src/services/profiler/hostProfileService', () => ({
  getById: jest.fn()
}));
jest.mock('../../models/ModelAdaptation', () => ({
  findOne: jest.fn()
}));

const app = require('../../server');
const adaptationService = require('../../src/services/profiler/adaptationService');
const hostProfileService = require('../../src/services/profiler/hostProfileService');
const ModelAdaptation = require('../../models/ModelAdaptation');

const HOST_ID = 'host-gamma';

describe('Adapt Routes', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/profiler/adapt/:modelName/:hostId/validate', () => {
    it('should validate Modelfile content and return result', async () => {
      hostProfileService.getById.mockResolvedValue({
        hostId: HOST_ID,
        hostUrl: 'http://localhost:11434'
      });
      adaptationService.validateModelfile.mockResolvedValue({
        valid: true,
        errors: [],
        warnings: []
      });

      const response = await request(app)
        .post(`/api/profiler/adapt/llama3:8b/${HOST_ID}/validate`)
        .send({ content: 'FROM llama3:8b\nPARAMETER num_ctx 4096' });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        valid: true,
        errors: [],
        warnings: []
      });
      expect(adaptationService.validateModelfile).toHaveBeenCalledWith(
        'FROM llama3:8b\nPARAMETER num_ctx 4096',
        'http://localhost:11434'
      );
    });

    it('should return 400 when content is missing', async () => {
      const response = await request(app)
        .post(`/api/profiler/adapt/llama3:8b/${HOST_ID}/validate`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: 'Missing Modelfile content' });
    });
  });

  describe('DELETE /api/profiler/adapt/:modelName/:hostId/deploy', () => {
    it('should remove adapted model from host', async () => {
      hostProfileService.getById.mockResolvedValue({
        hostId: HOST_ID,
        hostUrl: 'http://localhost:11434'
      });
      ModelAdaptation.findOne.mockResolvedValue({
        modelName: 'llama3:8b',
        hostId: HOST_ID,
        adaptedName: 'ax-llama3-8b-host-a',
        deployment: { status: 'deployed' },
        save: jest.fn().mockResolvedValue()
      });

      // Mock global fetch for the Ollama DELETE call
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({ ok: true });

      const response = await request(app)
        .delete(`/api/profiler/adapt/llama3:8b/${HOST_ID}/deploy`);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        removed: true,
        adaptedName: 'ax-llama3-8b-host-a'
      });
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/delete',
        expect.objectContaining({
          method: 'DELETE',
          body: JSON.stringify({ name: 'ax-llama3-8b-host-a' })
        })
      );

      global.fetch = originalFetch;
    });
  });

  describe('GET /api/profiler/adapt/:modelName/:hostId/history', () => {
    it('should return deployment history', async () => {
      const history = [
        { status: 'deployed', deployedAt: '2026-04-01T00:00:00.000Z', modelfileHash: 'sha256:abc123' },
        { status: 'removed', deployedAt: '2026-04-02T00:00:00.000Z', modelfileHash: 'sha256:abc123' }
      ];
      adaptationService.getAdaptation.mockResolvedValue({
        modelName: 'llama3:8b',
        hostId: HOST_ID,
        deployment: { history }
      });

      const response = await request(app)
        .get(`/api/profiler/adapt/llama3:8b/${HOST_ID}/history`);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([...history].reverse());
    });
  });

  describe('GET /api/profiler/adapt/:modelName/:hostId/export', () => {
    it('should return Modelfile as downloadable text', async () => {
      const content = 'FROM llama3:8b\nPARAMETER num_ctx 4096';
      adaptationService.getAdaptation.mockResolvedValue({
        modelName: 'llama3:8b',
        hostId: HOST_ID,
        modelfile: { content }
      });

      const response = await request(app)
        .get(`/api/profiler/adapt/llama3:8b/${HOST_ID}/export`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/plain/);
      expect(response.headers['content-disposition']).toMatch(/attachment/);
      expect(response.text).toBe(content);
    });
  });
});
