'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/buddyEvents', () => ({
  emit: jest.fn(() => ({ id: 'evt_test' })),
}));

const { emit: emitPlatformEvent } = require('../../src/services/buddyEvents');
const platformEventRoutes = require('../../routes/platform-events');

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
  app.use('/api/platform-events', platformEventRoutes);
  return app;
}

const VALID_EVENT = {
  type: 'judge_start',
  class: 'benchmark',
  summary: 'Judge started',
  intent: 'watching',
  surfaceScope: 'benchmark',
};

describe('POST /api/platform-events', () => {
  const savedToken = process.env.AGENTX_PLATFORM_EVENT_TOKEN;
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.AGENTX_PLATFORM_EVENT_TOKEN;
    app = buildApp();
  });

  afterAll(() => {
    if (savedToken === undefined) delete process.env.AGENTX_PLATFORM_EVENT_TOKEN;
    else process.env.AGENTX_PLATFORM_EVENT_TOKEN = savedToken;
  });

  it('accepts a bounded loopback event and returns its stable id', async () => {
    const response = await request(app)
      .post('/api/platform-events')
      .send({ ...VALID_EVENT, summary: 'x'.repeat(700) })
      .expect(200);

    expect(response.body).toEqual({ status: 'success', eventId: 'evt_test' });
    expect(emitPlatformEvent).toHaveBeenCalledWith(
      'judge_start',
      'benchmark',
      'x'.repeat(500),
      undefined,
      { intent: 'watching', surfaceScope: 'benchmark' }
    );
  });

  it('accepts the generic token header for a non-loopback producer', async () => {
    process.env.AGENTX_PLATFORM_EVENT_TOKEN = 'shared-token';
    app.locals.forcedIp = '172.18.0.5';
    await request(app)
      .post('/api/platform-events')
      .set('X-Platform-Event-Token', 'shared-token')
      .send(VALID_EVENT)
      .expect(200);
    expect(emitPlatformEvent).toHaveBeenCalledTimes(1);
  });

  it('rejects unauthenticated remote callers and invalid payloads', async () => {
    app.locals.forcedIp = '172.18.0.5';
    await request(app).post('/api/platform-events').send(VALID_EVENT).expect(403);
    app.locals.forcedIp = '127.0.0.1';
    await request(app).post('/api/platform-events').send({ type: 'judge_start' }).expect(400);
    expect(emitPlatformEvent).not.toHaveBeenCalled();
  });
});
