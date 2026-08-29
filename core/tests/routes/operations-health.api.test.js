'use strict';

const express = require('express');
const request = require('supertest');

const mockHealthClient = {
  getOllamaTags: jest.fn(),
  getQdrantHealth: jest.fn(),
  probeOptionalRuntime: jest.fn(),
};
const mockCreateOperationsHealthClient = jest.fn(() => mockHealthClient);
const mockPublicOperationsHealthError = jest.fn((error) => (
  error?.safeMessage || 'The outbound request failed.'
));

jest.mock('../../models/ActivityLog', () => ({}));
jest.mock('../../models/PerformanceSnapshot', () => ({
  find: jest.fn(() => ({ lean: jest.fn(async () => []) })),
}));
jest.mock('../../src/services/operationsHealthClient', () => ({
  createOperationsHealthClient: mockCreateOperationsHealthClient,
  publicOperationsHealthError: mockPublicOperationsHealthError,
}));

const operationsRoutes = require('../../routes/operations');

function app() {
  const instance = express();
  instance.use('/api/operations', operationsRoutes);
  return instance;
}

const ORIGINAL_ENV = Object.freeze({
  CLAWDX_OLLAMA_URL: process.env.CLAWDX_OLLAMA_URL,
  OLLAMA_HOST: process.env.OLLAMA_HOST,
  OLLAMA_HOST_3: process.env.OLLAMA_HOST_3,
  OLLAMA_HOST_TERTIARY: process.env.OLLAMA_HOST_TERTIARY,
  QDRANT_URL: process.env.QDRANT_URL,
  VECTOR_STORE_TYPE: process.env.VECTOR_STORE_TYPE,
});

function restoreEnvironment() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('operations health API outbound projections', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CLAWDX_OLLAMA_URL = 'http://optional-runtime:11434';
    process.env.OLLAMA_HOST = 'http://ollama:11434';
    process.env.QDRANT_URL = 'http://qdrant:6333';
    process.env.VECTOR_STORE_TYPE = 'qdrant';
  });

  afterEach(restoreEnvironment);

  test('keeps service-level status fields while exposing only projected errors', async () => {
    mockHealthClient.getOllamaTags.mockRejectedValueOnce(Object.assign(
      new Error('connect ECONNREFUSED http://private-host:11434'),
      { safeMessage: 'The outbound request failed.' }
    ));
    mockHealthClient.getQdrantHealth.mockRejectedValueOnce(Object.assign(
      new Error('redirected to http://metadata.internal'),
      { safeMessage: 'The outbound service returned a redirect.' }
    ));
    mockHealthClient.probeOptionalRuntime.mockImplementation(async (pathname) => ({
      data: { models: pathname === '/api/tags' ? [{ name: 'model-a' }] : [] },
      json: true,
      ok: true,
      status: 200,
      url: `http://optional-runtime:11434${pathname}`,
    }));

    const response = await request(app()).get('/api/operations/health').expect(200);

    expect(response.body).toMatchObject({
      status: 'degraded',
      services: {
        ollama: {
          error: 'The outbound request failed.',
          host: 'http://ollama:11434',
          status: 'error',
        },
        qdrant: {
          error: 'The outbound service returned a redirect.',
          status: 'error',
          url: 'http://qdrant:6333',
        },
        clawdx: {
          host: 'http://optional-runtime:11434',
          models: 1,
          status: 'up',
        },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('private-host');
    expect(JSON.stringify(response.body)).not.toContain('metadata.internal');
    expect(mockCreateOperationsHealthClient).toHaveBeenCalledWith({
      ollamaUrl: 'http://ollama:11434',
      optionalRuntimeUrl: 'http://optional-runtime:11434',
      qdrantUrl: 'http://qdrant:6333',
    });
  });

  test('preserves the current unconfigured optional-runtime degraded projection', async () => {
    delete process.env.CLAWDX_OLLAMA_URL;
    delete process.env.OLLAMA_HOST_TERTIARY;
    delete process.env.OLLAMA_HOST_3;
    process.env.VECTOR_STORE_TYPE = 'memory';
    mockHealthClient.getOllamaTags.mockResolvedValue({
      data: { models: [] }, ok: true, status: 200,
    });
    mockHealthClient.probeOptionalRuntime.mockRejectedValue(Object.assign(
      new Error('configuration details'),
      { safeMessage: 'The optional runtime is not configured.' }
    ));

    const response = await request(app()).get('/api/operations/health').expect(200);

    expect(response.body.status).toBe('degraded');
    expect(response.body.services.clawdx).toEqual({
      error: 'The optional runtime is not configured.',
      host: '',
      status: 'down',
    });
  });
});
