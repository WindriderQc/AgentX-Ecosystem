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
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
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

  it('accepts a non-loopback producer without any token', async () => {
    app.locals.forcedIp = '172.18.0.5';
    await request(app)
      .post('/api/platform-events')
      .send(VALID_EVENT)
      .expect(200);
    expect(emitPlatformEvent).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid payloads', async () => {
    await request(app).post('/api/platform-events').send({ type: 'judge_start' }).expect(400);
    expect(emitPlatformEvent).not.toHaveBeenCalled();
  });
});
