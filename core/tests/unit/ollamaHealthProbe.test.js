'use strict';

const {
  DEFAULT_TIMEOUT_MS,
  probeOllamaHealth,
  refreshOllamaHealth,
} = require('../../src/services/ollamaHealthProbe');

describe('ollamaHealthProbe', () => {
  it('reports a successful live tags probe with a normalized host', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    const result = await probeOllamaHealth({
      host: '192.0.2.199:11434/',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith('http://192.0.2.199:11434/api/tags', {
      method: 'GET',
      timeout: DEFAULT_TIMEOUT_MS,
    });
    expect(result).toEqual(expect.objectContaining({
      healthy: true,
      host: 'http://192.0.2.199:11434',
      message: 'Connected',
    }));
  });

  it('reports a non-success response without throwing', async () => {
    const result = await probeOllamaHealth({
      host: 'http://ollama.example:11434',
      fetchImpl: jest.fn().mockResolvedValue({ ok: false, status: 503 }),
      timeoutMs: 750,
    });

    expect(result).toEqual(expect.objectContaining({
      healthy: false,
      message: 'HTTP 503',
    }));
  });

  it('reports connection failures and missing configuration without throwing', async () => {
    const connectionFailure = await probeOllamaHealth({
      host: 'http://ollama.example:11434',
      fetchImpl: jest.fn().mockRejectedValue(new Error('connect refused')),
    });
    const missingHost = await probeOllamaHealth({ host: '' });

    expect(connectionFailure).toEqual(expect.objectContaining({
      healthy: false,
      message: 'connect refused',
    }));
    expect(missingHost).toEqual(expect.objectContaining({
      healthy: false,
      host: null,
      message: 'OLLAMA_HOST is not configured',
    }));
  });

  it('replaces stale boot state with the latest probe result', async () => {
    const systemHealth = {
      ollama: { status: 'error', lastCheck: 'stale', error: 'boot failure' },
    };

    const next = await refreshOllamaHealth(systemHealth, {
      host: 'http://ollama.example:11434',
      fetchImpl: jest.fn().mockResolvedValue({ ok: true, status: 200 }),
    });

    expect(next.status).toBe('connected');
    expect(next.error).toBeNull();
    expect(next.lastCheck).not.toBe('stale');
    expect(systemHealth.ollama).toEqual(next);
  });
});
