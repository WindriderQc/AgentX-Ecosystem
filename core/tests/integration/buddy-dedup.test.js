const request = require('supertest');
const { app } = require('../../src/app');

describe('Buddy /react dedup guard', () => {
  const clientId = 'buddy-dedup-test-' + Date.now();

  beforeAll(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: 'Test reaction.' } }),
    });
  });

  afterAll(() => { delete global.fetch; });

  beforeEach(() => {
    global.fetch.mockClear();
  });

  it('does not forward caller-supplied host overrides to inference', async () => {
    await request(app)
      .post('/api/buddy/react')
      .set('x-test-client', clientId + '-host-override')
      .send({
        context: 'test',
        personality: 'test',
        seed: 'host-override-' + Date.now(),
        host: 'http://192.0.2.99:11434',
      });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.taskType).toBe('buddy_reaction');
    expect(body.callerDetail).toBe('buddy/react');
    expect(body.host).toBeUndefined();
  });

  it('rejects /react if same seed called < 8s ago', async () => {
    const res1 = await request(app)
      .post('/api/buddy/react')
      .set('x-test-client', clientId + '-dedup')
      .send({ context: 'test', personality: 'test', seed: 'dedup-test-' + Date.now() });
    expect(res1.body.error).not.toBe('too_soon');

    const res2 = await request(app)
      .post('/api/buddy/react')
      .set('x-test-client', clientId + '-dedup')
      .send({ context: 'test', personality: 'test', seed: 'dedup-test-' + Date.now() });
    // Note: using Date.now() gives different seeds, so not too_soon
    // To test dedup, we need the same seed:
  });

  it('blocks same seed within 8 seconds', async () => {
    const sharedSeed = 'same-seed-' + Date.now();
    await request(app)
      .post('/api/buddy/react')
      .set('x-test-client', clientId + '-same')
      .send({ context: 'test', personality: 'test', seed: sharedSeed });

    const res2 = await request(app)
      .post('/api/buddy/react')
      .set('x-test-client', clientId + '-same')
      .send({ context: 'test', personality: 'test', seed: sharedSeed });
    expect(res2.body.error).toBe('too_soon');
    expect(res2.body.retryAfterMs).toBeGreaterThan(0);
  });

  it('allows /react with different seeds', async () => {
    const res1 = await request(app)
      .post('/api/buddy/react')
      .set('x-test-client', clientId + '-diff')
      .send({ context: 'test', personality: 'test', seed: 'seed-a-' + Date.now() });
    expect(res1.body.error).not.toBe('too_soon');

    const res2 = await request(app)
      .post('/api/buddy/react')
      .set('x-test-client', clientId + '-diff')
      .send({ context: 'test', personality: 'test', seed: 'seed-b-' + Date.now() });
    expect(res2.body.error).not.toBe('too_soon');
  });
});
