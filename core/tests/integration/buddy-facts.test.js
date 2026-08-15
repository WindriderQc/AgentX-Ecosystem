// Phase 6h — file-based facts CRUD integration tests.
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let TMP_ROOT;
function setTempHomes() {
  TMP_ROOT = path.join(os.tmpdir(), 'buddy-facts-it-' + crypto.randomBytes(6).toString('hex'));
  process.env.BUDDY_HOME = path.join(TMP_ROOT, '.buddy');
}
setTempHomes();

const request = require('supertest');
const Buddy = require('../../models/Buddy');
const { app } = require('../../src/app');

describe('/api/buddy/facts (Phase 6h, file-based)', () => {
  const clientId = 'buddy-facts-test-' + Date.now();

  beforeEach(async () => {
    // Start each test from a clean singleton + clean tmp dir.
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

  it('POST /facts appends and GET /facts returns active list with file path', async () => {
    const post = await request(app)
      .post('/api/buddy/facts')
      .set('x-test-client', clientId + '-add')
      .send({ text: 'Example User prefers Host Gamma' });

    expect(post.status).toBe(200);
    expect(post.body.status).toBe('success');
    expect(post.body.data.count).toBe(1);
    expect(post.body.data.facts[0].text).toBe('Example User prefers Host Gamma');
    expect(typeof post.body.data.file).toBe('string');
    expect(post.body.data.file).toMatch(/notes\.md$/);

    const get = await request(app)
      .get('/api/buddy/facts')
      .set('x-test-client', clientId + '-get');
    expect(get.status).toBe(200);
    expect(get.body.data.facts.length).toBe(1);
    expect(get.body.data.file).toBe(post.body.data.file);
  });

  it('POST /facts rejects empty text', async () => {
    const r = await request(app)
      .post('/api/buddy/facts')
      .set('x-test-client', clientId + '-empty')
      .send({ text: '   ' });
    expect(r.status).toBe(400);
  });

  it('POST /facts roundtrips tags', async () => {
    const r = await request(app)
      .post('/api/buddy/facts')
      .set('x-test-client', clientId + '-tags')
      .send({ text: 'fact w tags', tags: ['Preferences', ' hardware ', 'preferences'] });
    expect(r.status).toBe(200);
    expect(r.body.data.facts[0].tags).toEqual(['preferences', 'hardware']);
  });

  it('DELETE /facts/:index marks forgotten (does not erase)', async () => {
    await request(app).post('/api/buddy/facts')
      .set('x-test-client', clientId + '-d1').send({ text: 'fact a' });
    await new Promise(r => setTimeout(r, 5));
    await request(app).post('/api/buddy/facts')
      .set('x-test-client', clientId + '-d2').send({ text: 'fact b' });

    const del = await request(app)
      .delete('/api/buddy/facts/0')
      .set('x-test-client', clientId + '-del');
    expect(del.status).toBe(200);
    expect(del.body.data.count).toBe(1);

    // Default GET excludes forgotten; ?include=forgotten reveals it.
    const get = await request(app).get('/api/buddy/facts')
      .set('x-test-client', clientId + '-get-after-del');
    expect(get.body.data.facts.length).toBe(1);

    const getAll = await request(app).get('/api/buddy/facts?include=forgotten')
      .set('x-test-client', clientId + '-get-all');
    expect(getAll.body.data.active.length).toBe(1);
    expect(getAll.body.data.forgotten.length).toBe(1);
  });

  it('migrates Mongo facts to the notes file on first read, then clears Mongo', async () => {
    const seedFacts = [
      { text: 'mig fact 1', addedAt: new Date(), weight: 1 },
      { text: 'mig fact 2', addedAt: new Date(), weight: 1 },
      { text: 'mig fact 3', addedAt: new Date(), weight: 1 },
    ];
    await Buddy.updateOne(
      { seed: 'global' },
      { $set: { facts: seedFacts, personality: { source: 'standalone', agentId: '' } } }
    );

    const get = await request(app).get('/api/buddy/facts')
      .set('x-test-client', clientId + '-mig');
    expect(get.status).toBe(200);
    expect(get.body.data.facts.length).toBe(3);

    // Mongo facts cleared.
    const buddy = await Buddy.findOne({ seed: 'global' }).lean();
    expect((buddy.facts || []).length).toBe(0);

    // File exists and contains the facts.
    const filePath = get.body.data.file;
    expect(fs.existsSync(filePath)).toBe(true);
    const content = await fsp.readFile(filePath, 'utf8');
    expect(content).toMatch(/mig fact 1/);
    expect(content).toMatch(/mig fact 3/);
  });

  it('product personality changes cannot redirect the notes authority', async () => {
    await request(app).post('/api/buddy/facts')
      .set('x-test-client', clientId + '-srcA').send({ text: 'standalone fact' });
    const standaloneFile = path.join(TMP_ROOT, '.buddy', 'notes.md');
    expect(fs.existsSync(standaloneFile)).toBe(true);
    const standaloneBefore = await fsp.readFile(standaloneFile, 'utf8');

    const sw = await request(app).post('/api/buddy/singleton')
      .set('x-test-client', clientId + '-switch')
      .send({ personality: { source: 'agentx' } });
    expect(sw.status).toBe(200);

    const get = await request(app).get('/api/buddy/facts')
      .set('x-test-client', clientId + '-srcB');
    expect(get.body.data.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'standalone fact' }),
    ]));
    expect(get.body.data.file).toBe(standaloneFile);

    const standaloneAfter = await fsp.readFile(standaloneFile, 'utf8');
    expect(standaloneAfter).toBe(standaloneBefore);
  });

  it('GET /facts/file returns text/markdown', async () => {
    await request(app).post('/api/buddy/facts')
      .set('x-test-client', clientId + '-rawf').send({ text: 'shown in raw' });
    const r = await request(app).get('/api/buddy/facts/file')
      .set('x-test-client', clientId + '-raw');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/markdown/);
    expect(r.text).toMatch(/shown in raw/);
  });
});
