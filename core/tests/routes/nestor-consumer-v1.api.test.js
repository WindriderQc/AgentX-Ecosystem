'use strict';

const express = require('express');
const request = require('supertest');

const mockGetCapabilities = jest.fn();
const mockExportLegacyProfile = jest.fn();
const mockExportLegacyProfileV1 = jest.fn();
const mockGetMigrationNotesPage = jest.fn();
const mockExecuteInference = jest.fn();
const mockGetRouterSnapshot = jest.fn();
const mockGetMemoryStatus = jest.fn();
const mockSearchMemory = jest.fn();
const mockGetPersonalitySources = jest.fn();
const mockResolvePersonalityCandidate = jest.fn();
const mockGetNestorMetrics = jest.fn();
const mockGetPanelStatus = jest.fn();

jest.mock('../../src/services/nestorConsumerCapabilitiesService', () => ({
  getCapabilities: (...args) => mockGetCapabilities(...args),
}));
jest.mock('../../src/services/nestorConsumerProfileService', () => ({
  exportLegacyProfile: (...args) => mockExportLegacyProfile(...args),
  exportLegacyProfileV1: (...args) => mockExportLegacyProfileV1(...args),
  getMigrationNotesPage: (...args) => mockGetMigrationNotesPage(...args),
}));
jest.mock('../../src/services/nestorConsumerRuntimeService', () => ({
  executeInference: (...args) => mockExecuteInference(...args),
  getRouterSnapshot: (...args) => mockGetRouterSnapshot(...args),
}));
jest.mock('../../src/services/nestorConsumerMemoryService', () => ({
  getMemoryStatus: (...args) => mockGetMemoryStatus(...args),
  searchMemory: (...args) => mockSearchMemory(...args),
}));
jest.mock('../../src/services/nestorConsumerPersonalityService', () => ({
  getPersonalitySources: (...args) => mockGetPersonalitySources(...args),
  resolvePersonalityCandidate: (...args) => mockResolvePersonalityCandidate(...args),
}));
jest.mock('../../src/services/nestorConsumerMetricsService', () => ({
  getNestorMetrics: (...args) => mockGetNestorMetrics(...args),
}));
jest.mock('../../src/services/panelService', () => ({
  getPanelStatus: (...args) => mockGetPanelStatus(...args),
}));
jest.mock('../../config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

const createRoutes = require('../../routes/nestor-consumer-v1');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', {
      value: app.locals.forcedIp || '127.0.0.1',
      configurable: true,
    });
    next();
  });
  app.use('/api/consumers/nestor/v1', createRoutes({ systemHealth: { status: 'ok' } }));
  return app;
}

describe('Nestor v1 consumer contract routes', () => {
  const savedOperatorToken = process.env.AGENTX_OPERATOR_TOKEN;
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    if (savedOperatorToken === undefined) delete process.env.AGENTX_OPERATOR_TOKEN;
    else process.env.AGENTX_OPERATOR_TOKEN = savedOperatorToken;
    app = buildApp();
    mockGetCapabilities.mockResolvedValue({ contract: { name: 'agentx.nestor.consumer', version: '1.1.0' } });
    mockExportLegacyProfile.mockResolvedValue({ exists: true, authority: 'legacy-migration-only' });
    mockExportLegacyProfileV1.mockResolvedValue({
      exists: true,
      schemaVersion: 1,
      authority: 'legacy-migration-only',
    });
    mockGetMigrationNotesPage.mockResolvedValue({
      snapshotId: 'snapshot',
      sha256: 'hash',
      byteLength: 3,
      offset: 0,
      chunkBytes: 3,
      data: 'YWJj',
      nextOffset: 3,
      complete: true,
    });
    mockGetRouterSnapshot.mockResolvedValue({ readOnly: true, routes: {} });
    mockExecuteInference.mockResolvedValue({ reply: 'hello', callerDetail: 'nestor/desktop/chat' });
    mockGetMemoryStatus.mockResolvedValue({ sources: {} });
    mockSearchMemory.mockResolvedValue({ results: [], warnings: [] });
    mockGetPersonalitySources.mockResolvedValue({ sources: {} });
    mockResolvePersonalityCandidate.mockResolvedValue({ source: 'hermes', ref: 'hermes:SOUL.md' });
    mockGetNestorMetrics.mockResolvedValue({ calls: 0 });
    mockGetPanelStatus.mockResolvedValue({ portal: { summary: { healthy: 4 } } });
  });

  it('discovers the versioned contract and read-only migration export', async () => {
    const capabilities = await request(app)
      .get('/api/consumers/nestor/v1/capabilities')
      .expect(200);
    const migration = await request(app)
      .get('/api/consumers/nestor/v1/migration/profile?schemaVersion=2&includeRawNotes=true')
      .expect(200);

    expect(capabilities.body.data.contract.version).toBe('1.1.0');
    expect(migration.body.data.authority).toBe('legacy-migration-only');
    expect(mockExportLegacyProfile).toHaveBeenCalledWith({ includeRawNotes: true });
    expect(migration.headers['cache-control']).toBe('no-store');
  });

  it('keeps schema 1 as the default and requires explicit schema-2 negotiation', async () => {
    const legacy = await request(app)
      .get('/api/consumers/nestor/v1/migration/profile')
      .expect(200);
    const unsupported = await request(app)
      .get('/api/consumers/nestor/v1/migration/profile?schemaVersion=3')
      .expect(400);

    expect(legacy.body.data.schemaVersion).toBe(1);
    expect(mockExportLegacyProfileV1).toHaveBeenCalledWith({ includeRawNotes: false });
    expect(mockExportLegacyProfile).not.toHaveBeenCalled();
    expect(unsupported.body.code).toBe('NESTOR_MIGRATION_UNSUPPORTED_SCHEMA');
  });

  afterAll(() => {
    if (savedOperatorToken === undefined) delete process.env.AGENTX_OPERATOR_TOKEN;
    else process.env.AGENTX_OPERATOR_TOKEN = savedOperatorToken;
  });

  it('delegates byte-safe migration notes paging and disables caching', async () => {
    const response = await request(app)
      .get('/api/consumers/nestor/v1/migration/notes?snapshotId=snapshot&offset=4&limit=8')
      .expect(200);

    expect(mockGetMigrationNotesPage).toHaveBeenCalledWith({
      snapshotId: 'snapshot',
      offset: '4',
      limit: '8',
    });
    expect(response.body.data.data).toBe('YWJj');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('protects both migration endpoints with the stable operator-token error contract', async () => {
    app.locals.forcedIp = '172.18.0.5';
    const profile = await request(app)
      .get('/api/consumers/nestor/v1/migration/profile')
      .expect(403);
    const notes = await request(app)
      .get('/api/consumers/nestor/v1/migration/notes?snapshotId=snapshot')
      .expect(403);

    for (const response of [profile, notes]) {
      expect(response.body).toEqual(expect.objectContaining({
        ok: false,
        status: 'error',
        code: 'NESTOR_MIGRATION_OPERATOR_TOKEN_REQUIRED',
      }));
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(mockExportLegacyProfile).not.toHaveBeenCalled();
    expect(mockExportLegacyProfileV1).not.toHaveBeenCalled();
    expect(mockGetMigrationNotesPage).not.toHaveBeenCalled();
  });

  it('allows a remote migration export with a valid operator token', async () => {
    app.locals.forcedIp = '172.18.0.5';
    process.env.AGENTX_OPERATOR_TOKEN = 'operator-token';

    await request(app)
      .get('/api/consumers/nestor/v1/migration/profile')
      .set('X-AgentX-Operator-Token', 'operator-token')
      .expect(200);

    expect(mockExportLegacyProfileV1).toHaveBeenCalled();
    delete process.env.AGENTX_OPERATOR_TOKEN;
  });

  it('delegates inference, memory, personality, metrics, router, and panel summaries', async () => {
    const inference = await request(app)
      .post('/api/consumers/nestor/v1/inference')
      .send({ operation: 'chat', messages: [{ role: 'user', content: 'Hi' }] })
      .expect(200);
    await request(app).get('/api/consumers/nestor/v1/router').expect(200);
    await request(app).get('/api/consumers/nestor/v1/memory/status?source=agentx').expect(200);
    await request(app).post('/api/consumers/nestor/v1/memory/search').send({ source: 'agentx', query: 'x' }).expect(200);
    await request(app).get('/api/consumers/nestor/v1/personality/sources').expect(200);
    await request(app).post('/api/consumers/nestor/v1/personality/resolve').send({ source: 'hermes' }).expect(200);
    await request(app).get('/api/consumers/nestor/v1/metrics?hours=12&taskType=buddy_chat').expect(200);
    await request(app).get('/api/consumers/nestor/v1/panel-summary').expect(200);

    expect(inference.body.data.callerDetail).toBe('nestor/desktop/chat');
    expect(mockGetMemoryStatus).toHaveBeenCalledWith('agentx');
    expect(mockGetNestorMetrics).toHaveBeenCalledWith({ hours: '12', taskType: 'buddy_chat' });
    expect(mockGetPanelStatus).toHaveBeenCalledWith({ status: 'ok' });
  });

  it('returns a stable error envelope from bounded contract validation', async () => {
    const error = new Error('Unknown memory source: mars');
    error.statusCode = 400;
    error.code = 'UNKNOWN_MEMORY_SOURCE';
    mockSearchMemory.mockRejectedValue(error);

    const response = await request(app)
      .post('/api/consumers/nestor/v1/memory/search')
      .send({ source: 'mars', query: 'x' })
      .expect(400);

    expect(response.body).toEqual({
      ok: false,
      status: 'error',
      error: 'Unknown memory source: mars',
      message: 'Unknown memory source: mars',
      code: 'UNKNOWN_MEMORY_SOURCE',
    });
  });
});
