'use strict';

const mockGetStatus = jest.fn();
const mockRefreshStatus = jest.fn();
const mockListDocuments = jest.fn();

jest.mock('../../src/services/ragServiceClient', () => ({
  getRagServiceClient: () => ({
    getStatus: mockGetStatus,
    refreshStatus: mockRefreshStatus,
    listDocuments: mockListDocuments,
    searchSimilarChunks: jest.fn(),
    upsertDocumentWithChunks: jest.fn(),
    deleteDocument: jest.fn(),
    getDocument: jest.fn(),
    getDocumentChunks: jest.fn()
  })
}));

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const express = require('express');
const request = require('supertest');
const ragRouter = require('../../routes/rag');

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/rag', ragRouter);
  return instance;
}

describe('Core RAG proxy health contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListDocuments.mockResolvedValue({ documents: [] });
  });

  test('does not turn a reachable unhealthy RAG service into Healthy', async () => {
    mockGetStatus.mockResolvedValue({
      healthy: false,
      documentCount: 96,
      chunkCount: 1894,
      observedAt: '2026-08-30T12:00:00.000Z'
    });

    const response = await request(app()).get('/api/rag/metrics');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'success',
      reachable: true,
      healthy: false,
      observedAt: '2026-08-30T12:00:00.000Z',
      stats: { totalDocuments: 96, totalChunks: 1894 }
    });
  });

  test('preserves unknown metrics and health as null instead of zero or Healthy', async () => {
    mockGetStatus.mockResolvedValue({});

    const response = await request(app()).get('/api/rag/metrics');

    expect(response.status).toBe(200);
    expect(response.body.reachable).toBe(true);
    expect(response.body.healthy).toBeNull();
    expect(response.body.stats).toMatchObject({
      totalDocuments: null,
      totalChunks: null,
      avgChunksPerDoc: null,
      vectorDimension: null
    });
  });

  test('adds an observation timestamp to successful status projections', async () => {
    mockGetStatus.mockResolvedValue({ healthy: true });

    const response = await request(app()).get('/api/rag/status');

    expect(response.status).toBe(200);
    expect(response.body.data.healthy).toBe(true);
    expect(new Date(response.body.data.observedAt).toString()).not.toBe('Invalid Date');
  });

  test('proxies the active query-readiness refresh through the same public surface', async () => {
    mockRefreshStatus.mockResolvedValue({
      healthy: true,
      queryReady: true,
      dependencies: { embedding: { healthy: true, evidence: 'active' } }
    });

    const response = await request(app()).post('/api/rag/status/refresh');

    expect(response.status).toBe(200);
    expect(mockRefreshStatus).toHaveBeenCalledTimes(1);
    expect(response.body).toMatchObject({
      status: 'success',
      data: { healthy: true, queryReady: true }
    });
  });
});
