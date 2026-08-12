const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/hostMonitorService', () => ({
  getAllHosts: jest.fn()
}));

jest.mock('../../src/services/ollamaEnrichmentService', () => ({
  getOllamaState: jest.fn()
}));

jest.mock('../../src/helpers/ollamaHostConfig', () => {
  const actual = jest.requireActual('../../src/helpers/ollamaHostConfig');
  return {
    ...actual,
    getConfiguredHosts: jest.fn()
  };
});

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const hostMonitorService = require('../../src/services/hostMonitorService');
const ollamaEnrichmentService = require('../../src/services/ollamaEnrichmentService');
const { getConfiguredHosts } = require('../../src/helpers/ollamaHostConfig');

const app = express();
app.use(express.json());
app.use('/api/hosts', require('../../routes/host-monitor'));

describe('host monitor routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/hosts/ollama-status', () => {
    it('includes configured Ollama hosts even when they have no Host document', async () => {
      getConfiguredHosts.mockReturnValue([
        { id: 'primary', name: 'Host Gamma', url: 'http://192.0.2.99:11434' },
        { id: 'secondary', name: 'Host Beta', url: 'http://192.0.2.12:11434' },
        { id: 'tertiary', name: 'Host Delta', url: 'http://192.0.2.66:11434' }
      ]);
      hostMonitorService.getAllHosts.mockResolvedValue([
        {
          hostId: 'host-gamma-agent',
          hostname: 'Host Gamma',
          ip: '192.0.2.99',
          ollamaHostKey: 'primary',
          ollamaUrl: 'http://192.0.2.99:11434',
          ollamaStatus: 'online',
          ollamaLatencyMs: 14,
          ollamaModels: ['ax/gemma4:26b-a4b-it-qat'],
          ollamaRunningModels: [{ name: 'ax/gemma4:26b-a4b-it-qat' }],
          ollamaVram: { totalMiB: 49152, usedMiB: 0 }
        }
      ]);
      ollamaEnrichmentService.getOllamaState.mockReturnValue({
        primary: {
          status: 'online',
          latencyMs: 22,
          models: ['qwen3:14b'],
          runningModels: [],
          vram: { totalMiB: 49152, usedMiB: 0 }
        },
        secondary: {
          status: 'offline',
          models: [],
          runningModels: []
        }
      });

      const res = await request(app)
        .get('/api/hosts/ollama-status')
        .expect(200);

      expect(res.body.status).toBe('success');
      expect(res.body.data.hosts).toHaveLength(3);

      const byKey = Object.fromEntries(res.body.data.hosts.map(host => [host.ollamaHostKey, host]));
      expect(byKey.primary).toMatchObject({
        hostId: 'host-gamma-agent',
        hostname: 'Host Gamma',
        ip: '192.0.2.99',
        ollamaStatus: 'online',
        ollamaLatencyMs: 14,
        ollamaModelCount: 1
      });
      expect(byKey.secondary).toMatchObject({
        hostId: 'secondary',
        hostname: 'Host Beta',
        ip: '192.0.2.12',
        ollamaStatus: 'offline'
      });
      expect(byKey.tertiary).toMatchObject({
        hostId: 'tertiary',
        hostname: 'Host Delta',
        ip: '192.0.2.66',
        ollamaStatus: 'unknown'
      });
    });
  });
});
