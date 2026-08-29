'use strict';

const request = require('supertest');

jest.mock('../../src/helpers/ollamaHostConfig', () => ({
  getConfiguredHosts: jest.fn(() => ([{
    id: 'primary',
    name: 'Primary',
    url: 'http://127.0.0.1:11434'
  }])),
  readConfigFile: jest.fn(() => null)
}));

const app = require('../../server');

describe('GET /api/ollama-hosts outbound boundary', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('does not follow redirects from a configured Ollama target', async () => {
    global.fetch = jest.fn(async () => new Response('', {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data' }
    }));

    const response = await request(app).get('/api/ollama-hosts').expect(200);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/tags',
      expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) })
    );
    expect(response.body.hosts[0]).toMatchObject({ available: false, models: [] });
  });

  test('fails the host closed when its inventory body exceeds the bound', async () => {
    global.fetch = jest.fn(async () => new Response('{"models":[]}', {
      status: 200,
      headers: { 'content-length': String((1024 * 1024) + 1) }
    }));

    const response = await request(app).get('/api/ollama-hosts').expect(200);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(response.body.hosts[0]).toMatchObject({ available: false, models: [] });
  });
});
