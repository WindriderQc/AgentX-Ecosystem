const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const mockUpsertDocumentWithChunks = jest.fn(async (_text, meta) => ({
  documentId: meta.documentId,
  chunkCount: 1,
}));

jest.mock('../../src/services/ragServiceClient', () => ({
  getRagServiceClient: () => ({
    upsertDocumentWithChunks: mockUpsertDocumentWithChunks,
  }),
}));

let TMP_ROOT;
function setTempHomes() {
  TMP_ROOT = path.join(os.tmpdir(), 'nestor-memory-api-' + crypto.randomBytes(6).toString('hex'));
  process.env.BUDDY_HOME = path.join(TMP_ROOT, '.buddy');
}
setTempHomes();

const request = require('supertest');
const Buddy = require('../../models/Buddy');
const { app } = require('../../src/app');

function fakeSecretLikeText() {
  return ['OPENAI_API_KEY=', 'sk', '-', 'abcdefghijklmnopqrstuvwxyz'].join('');
}

describe('Nestor memory API and producers', () => {
  const clientId = 'nestor-memory-api-' + Date.now();

  beforeEach(async () => {
    mockUpsertDocumentWithChunks.mockClear();
    if (fs.existsSync(TMP_ROOT)) {
      await fsp.rm(TMP_ROOT, { recursive: true, force: true });
    }
    await Buddy.updateOne(
      { seed: 'global' },
      { $set: { facts: [], personality: { source: 'standalone', agentId: '' } } },
      { upsert: true }
    );
  });

  afterAll(async () => {
    await Buddy.updateOne({ seed: 'global' }, { $set: { facts: [] } });
    if (fs.existsSync(TMP_ROOT)) {
      await fsp.rm(TMP_ROOT, { recursive: true, force: true });
    }
  });

  it('POST /api/nestor/memory/summary ingests a summary under source nestor-memory', async () => {
    const res = await request(app)
      .post('/api/nestor/memory/summary')
      .set('x-test-client', clientId + '-summary')
      .send({
        summary: 'Host Beta host telemetry now reports RTX 5070 Ti live.',
        topic: 'host-telemetry',
        tags: ['ops'],
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.memory.source).toBe('nestor-memory');
    expect(res.body.data.memory.type).toBe('summary');
    expect(res.body.data.memory.documentId).toMatch(/^nestor-memory:/);
    expect(mockUpsertDocumentWithChunks).toHaveBeenCalledWith(
      expect.stringContaining('Host Beta host telemetry'),
      expect.objectContaining({
        source: 'nestor-memory',
        tags: expect.arrayContaining(['nestor-memory', 'type:summary', 'topic:host-telemetry']),
      })
    );
  });

  it('POST /api/buddy/facts persists the fact and auto-ingests Nestor memory', async () => {
    const res = await request(app)
      .post('/api/buddy/facts')
      .set('x-test-client', clientId + '-fact')
      .send({
        text: 'Example User prefers Host Gamma for heavy local inference.',
        tags: ['Preferences', 'hosts'],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.memory.ingested).toBe(true);
    expect(res.body.data.memory.documentId).toMatch(/^nestor-memory:/);
    expect(mockUpsertDocumentWithChunks).toHaveBeenCalledWith(
      expect.stringContaining('Example User prefers Host Gamma'),
      expect.objectContaining({
        source: 'nestor-memory',
        tags: expect.arrayContaining(['nestor-memory', 'type:fact', 'agent:buddy', 'topic:buddy-facts']),
      })
    );
  });

  it('rejects secret-like Buddy facts before notes or RAG persistence', async () => {
    const res = await request(app)
      .post('/api/buddy/facts')
      .set('x-test-client', clientId + '-secret')
      .send({ text: fakeSecretLikeText() });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/secret-like/i);
    expect(mockUpsertDocumentWithChunks).not.toHaveBeenCalled();

    const get = await request(app)
      .get('/api/buddy/facts')
      .set('x-test-client', clientId + '-secret-check');
    expect(get.status).toBe(200);
    expect(get.body.data.facts).toEqual([]);
  });
});
