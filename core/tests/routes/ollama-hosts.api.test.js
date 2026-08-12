'use strict';

const express = require('express');
const request = require('supertest');

const mockFetch = jest.fn();
jest.mock('node-fetch', () => (...args) => mockFetch(...args));

const configuredHosts = [
  { id: 'primary', name: 'Host Alpha', url: 'http://primary:11434', priority: 1 },
  { id: 'secondary', name: 'Host Beta', url: 'http://secondary:11434', priority: 2 },
  { id: 'tertiary', name: 'Host Gamma', url: 'http://tertiary:11434', priority: 3 }
];

jest.mock('../../src/helpers/ollamaHostConfig', () => ({
  getConfiguredHosts: jest.fn(() => configuredHosts),
  validateHostUrl: jest.fn(() => ({ valid: false, host: null }))
}));

jest.mock('../../config/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
}));

const app = express();
app.use('/api/ollama-hosts', require('../../routes/ollama-hosts'));

function okJson(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => body
  });
}

function defaultFetch(url) {
  if (url.endsWith('/api/version')) {
    return okJson({ version: url.includes('secondary') ? '0.32.1' : '0.31.1' });
  }

  if (url.endsWith('/api/tags')) {
    return okJson({
      models: [
        { name: 'ax/gemma3:26b', details: { family: 'gemma3' } },
        { name: 'nomic-embed-text:v1.5', details: { family: 'nomic-bert' } },
        { name: 'fleet-diagnostic:latest', details: { family: 'llama' } }
      ]
    });
  }

  throw new Error(`Unexpected URL: ${url}`);
}

describe('Ollama hosts inventory API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockImplementation(defaultFetch);
  });

  it('adds complete installed inventory and Ollama version without changing legacy models', async () => {
    const response = await request(app)
      .get('/api/ollama-hosts')
      .expect(200);

    expect(response.body.data.total).toBe(3);
    expect(response.body.data.available).toBe(3);
    expect(response.body.data.hosts[0]).toEqual(expect.objectContaining({
      id: 'primary',
      available: true,
      ollamaVersion: '0.31.1',
      models: ['ax/gemma3:26b'],
      installedModels: [
        'ax/gemma3:26b',
        'nomic-embed-text:v1.5',
        'fleet-diagnostic:latest'
      ]
    }));
  });

  it('keeps a host available when only its version probe fails', async () => {
    mockFetch.mockImplementation((url) => {
      if (url === 'http://secondary:11434/api/version') {
        return Promise.reject(new Error('version timeout'));
      }
      return defaultFetch(url);
    });

    const response = await request(app)
      .get('/api/ollama-hosts')
      .expect(200);

    const secondary = response.body.data.hosts.find(host => host.id === 'secondary');
    expect(secondary.available).toBe(true);
    expect(secondary.ollamaVersion).toBeNull();
    expect(secondary.versionError).toBe('version timeout');
    expect(secondary.installedModels).toHaveLength(3);
  });

  it('marks a host unavailable when its model inventory probe fails', async () => {
    mockFetch.mockImplementation((url) => {
      if (url === 'http://primary:11434/api/tags') {
        return Promise.resolve({ ok: false, status: 503 });
      }
      return defaultFetch(url);
    });

    const response = await request(app)
      .get('/api/ollama-hosts')
      .expect(200);

    const primary = response.body.data.hosts.find(host => host.id === 'primary');
    expect(primary.available).toBe(false);
    expect(primary.models).toEqual([]);
    expect(primary.installedModels).toEqual([]);
    expect(primary.error).toBe('/api/tags returned HTTP 503');
  });

  it('returns the additive inventory fields on the per-host endpoint', async () => {
    const response = await request(app)
      .get('/api/ollama-hosts/primary/models')
      .expect(200);

    expect(response.body.data).toEqual(expect.objectContaining({
      available: true,
      models: ['ax/gemma3:26b'],
      installedModels: expect.arrayContaining(['nomic-embed-text:v1.5']),
      ollamaVersion: '0.31.1'
    }));
  });
});
