'use strict';

const express = require('express');
const request = require('supertest');
const { Readable } = require('stream');

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));
jest.mock('../../src/utils/fetchWithTimeout', () => jest.fn());

const fetchWithTimeout = require('../../src/utils/fetchWithTimeout');
const routes = require('../../routes/snapshots.routes');
const { recoveryTokensMatch } = require('../../src/middleware/recoveryAuth');

function createApp() {
  const app = express();
  app.use('/api/rag', routes);
  return app;
}

function qdrantResponse(result, extra = {}) {
  return {
    ok: true,
    status: 200,
    json: jest.fn(async () => ({ result })),
    buffer: jest.fn(async () => Buffer.from('snapshot')),
    body: Readable.from([Buffer.from('snapshot')]),
    ...extra
  };
}

describe('recovery snapshot authorization and projection', () => {
  const previousToken = process.env.AGENTX_RECOVERY_TOKEN;
  const previousRestore = process.env.AGENTX_RESTORE_REHEARSAL_ENABLED;

  beforeEach(() => {
    fetchWithTimeout.mockReset();
    process.env.AGENTX_RECOVERY_TOKEN = 'test-recovery-token';
    delete process.env.AGENTX_RESTORE_REHEARSAL_ENABLED;
  });

  afterAll(() => {
    if (previousToken === undefined) delete process.env.AGENTX_RECOVERY_TOKEN;
    else process.env.AGENTX_RECOVERY_TOKEN = previousToken;
    if (previousRestore === undefined) delete process.env.AGENTX_RESTORE_REHEARSAL_ENABLED;
    else process.env.AGENTX_RESTORE_REHEARSAL_ENABLED = previousRestore;
  });

  test('uses a timing-safe fixed-length digest comparison and fails closed on missing values', () => {
    expect(recoveryTokensMatch('secret', 'secret')).toBe(true);
    expect(recoveryTokensMatch('secret', 'wrong')).toBe(false);
    expect(recoveryTokensMatch('secret', 'much-longer-wrong-value')).toBe(false);
    expect(recoveryTokensMatch('', '')).toBe(false);
    expect(recoveryTokensMatch(undefined, 'secret')).toBe(false);
  });

  test.each([
    ['get', '/api/rag/snapshots'],
    ['post', '/api/rag/snapshots'],
    ['get', '/api/rag/snapshots/one.snapshot/download'],
    ['delete', '/api/rag/snapshots/one.snapshot'],
    ['post', '/api/rag/snapshots/one.snapshot/restore']
  ])('requires the recovery token for %s %s', async (method, url) => {
    const response = await request(createApp())[method](url).expect(403);
    expect(response.body).toEqual({
      ok: false,
      code: 'RECOVERY_AUTH_REQUIRED',
      error: 'Recovery snapshot authorization required'
    });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  test('fails closed when the server token is absent', async () => {
    delete process.env.AGENTX_RECOVERY_TOKEN;
    await request(createApp())
      .get('/api/rag/snapshots')
      .set('X-AgentX-Recovery-Token', 'caller-token')
      .expect(403);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  test('sanitizes direct list and create responses', async () => {
    const hostile = {
      name: 'one.snapshot',
      creation_time: '2026-08-28T00:00:00.000Z',
      size: 42,
      checksum: 'abcdef1234567890',
      url: 'http://qdrant:6333/private',
      qdrantUrl: 'http://qdrant:6333',
      root: '/qdrant/storage',
      path: '/private/snapshot'
    };
    fetchWithTimeout
      .mockResolvedValueOnce(qdrantResponse([hostile]))
      .mockResolvedValueOnce(qdrantResponse(hostile));

    const list = await request(createApp())
      .get('/api/rag/snapshots')
      .set('X-AgentX-Recovery-Token', 'test-recovery-token')
      .expect(200);
    const created = await request(createApp())
      .post('/api/rag/snapshots')
      .set('X-AgentX-Recovery-Token', 'test-recovery-token')
      .expect(200);

    for (const body of [list.body, created.body]) {
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/qdrantUrl|http:\/\/|\/qdrant\/|"path"|"root"|"url"/i);
    }
    expect(list.body.data[0]).toMatchObject({ name: 'one.snapshot', size: 42 });
  });

  test('serves snapshot bytes only through the authenticated internal proxy', async () => {
    const upstream = qdrantResponse(null);
    fetchWithTimeout.mockResolvedValueOnce(upstream);
    const response = await request(createApp())
      .get('/api/rag/snapshots/one.snapshot/download')
      .set('X-AgentX-Recovery-Token', 'test-recovery-token')
      .expect(200);
    expect(response.headers['content-type']).toMatch(/application\/octet-stream/);
    expect(response.body).toEqual(Buffer.from('snapshot'));
    expect(upstream.buffer).not.toHaveBeenCalled();
  });

  test('rejects snapshot deletion without an exact resource-bound phrase', async () => {
    const missing = await request(createApp())
      .delete('/api/rag/snapshots/one.snapshot')
      .set('X-AgentX-Recovery-Token', 'test-recovery-token')
      .expect(400);
    expect(missing.body).toMatchObject({
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      confirmation: { header: 'X-AgentX-Confirm', expected: 'DELETE one.snapshot' }
    });
    expect(fetchWithTimeout).not.toHaveBeenCalled();

    const wrong = await request(createApp())
      .delete('/api/rag/snapshots/one.snapshot')
      .set('X-AgentX-Recovery-Token', 'test-recovery-token')
      .set('X-AgentX-Confirm', 'DELETE other.snapshot')
      .expect(400);
    expect(wrong.body.confirmation.expected).toBe('DELETE one.snapshot');
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  test('deletes a snapshot only with the exact resource-bound phrase', async () => {
    fetchWithTimeout.mockResolvedValueOnce(qdrantResponse(null));
    const response = await request(createApp())
      .delete('/api/rag/snapshots/one.snapshot')
      .set('X-AgentX-Recovery-Token', 'test-recovery-token')
      .set('X-AgentX-Confirm', 'DELETE one.snapshot')
      .expect(200);

    expect(response.body.data).toEqual({ name: 'one.snapshot', deleted: true });
    expect(fetchWithTimeout).toHaveBeenCalledWith(
      expect.stringMatching(/\/snapshots\/one\.snapshot$/),
      { method: 'DELETE' },
      expect.any(Number)
    );
  });

  test('returns the stable offline rehearsal gate before contacting Qdrant', async () => {
    const response = await request(createApp())
      .post('/api/rag/snapshots/one.snapshot/restore')
      .set('X-AgentX-Recovery-Token', 'test-recovery-token')
      .expect(409);
    expect(response.body.code).toBe('OFFLINE_RESTORE_REQUIRED');
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  test('still requires exact typed confirmation after the rehearsal gate is enabled', async () => {
    process.env.AGENTX_RESTORE_REHEARSAL_ENABLED = 'true';
    await request(createApp())
      .post('/api/rag/snapshots/one.snapshot/restore')
      .set('X-AgentX-Recovery-Token', 'test-recovery-token')
      .set('X-AgentX-Confirm', 'RESTORE wrong.snapshot')
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('CONFIRMATION_REQUIRED'));
    expect(fetchWithTimeout).not.toHaveBeenCalled();

    fetchWithTimeout.mockResolvedValueOnce(qdrantResponse({ status: 'ok' }));
    await request(createApp())
      .post('/api/rag/snapshots/one.snapshot/restore')
      .set('X-AgentX-Recovery-Token', 'test-recovery-token')
      .set('X-AgentX-Confirm', 'RESTORE one.snapshot')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toEqual({ name: 'one.snapshot', restored: true, mode: 'controlled-rehearsal' });
      });
  });
});
