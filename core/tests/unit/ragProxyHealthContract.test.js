'use strict';

const mockGetStatus = jest.fn();
const mockGetMetrics = jest.fn();
const mockRefreshStatus = jest.fn();
const mockListDocuments = jest.fn();

jest.mock('../../src/services/ragServiceClient', () => ({
  getRagServiceClient: () => ({
    getStatus: mockGetStatus,
    getMetrics: mockGetMetrics,
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

  test('relays the complete RAG metrics without document-page reconstruction or health fields', async () => {
    const metrics = {
      totals: { documents: 351, chunks: 1053 },
      bySource: [{ source: 'corpus', documents: 351, chunks: 1053 }],
      lastIngest: { timestamp: '2026-09-08T00:00:00.000Z', source: 'corpus' }
    };
    mockGetMetrics.mockResolvedValue(metrics);

    const response = await request(app()).get('/api/rag/metrics');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'success', data: metrics });
    expect(mockGetStatus).not.toHaveBeenCalled();
    expect(mockListDocuments).not.toHaveBeenCalled();
  });

  test('preserves unknown owner metrics without inventing zeros', async () => {
    const metrics = { totals: { documents: null, chunks: null }, bySource: null, lastIngest: null };
    mockGetMetrics.mockResolvedValue(metrics);

    const response = await request(app()).get('/api/rag/metrics');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(metrics);
  });

  test('reports unavailable metrics without falling back to status or a document page', async () => {
    mockGetMetrics.mockRejectedValue(Object.assign(new Error('RAG metrics unavailable'), { status: 503 }));
    await request(app()).get('/api/rag/metrics').expect(503);
    expect(mockGetStatus).not.toHaveBeenCalled();
    expect(mockListDocuments).not.toHaveBeenCalled();
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
