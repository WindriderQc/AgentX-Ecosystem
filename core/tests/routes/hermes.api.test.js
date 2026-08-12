const express = require('express');
const request = require('supertest');

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const ORIGINAL_DASHBOARD_URL = process.env.HERMES_DASHBOARD_URL;
const ORIGINAL_PUBLIC_URL = process.env.HERMES_PUBLIC_URL;
const originalFetch = global.fetch;

const hermesRoutes = require('../../routes/hermes');

function buildApp() {
  const app = express();
  app.use('/api/hermes', hermesRoutes);
  return app;
}

describe('Hermes status API', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.HERMES_DASHBOARD_URL = 'http://hermes.test/';
    delete process.env.HERMES_PUBLIC_URL;
    global.fetch = jest.fn();
    app = buildApp();
  });

  afterAll(() => {
    if (ORIGINAL_DASHBOARD_URL === undefined) delete process.env.HERMES_DASHBOARD_URL;
    else process.env.HERMES_DASHBOARD_URL = ORIGINAL_DASHBOARD_URL;
    if (ORIGINAL_PUBLIC_URL === undefined) delete process.env.HERMES_PUBLIC_URL;
    else process.env.HERMES_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
    global.fetch = originalFetch;
  });

  it('reports dashboard, gateway, and protected-config reachability without exposing the session token', async () => {
    global.fetch.mockImplementation(async (url, options = {}) => {
      if (url === 'http://hermes.test/api/status') {
        return {
          ok: true,
          json: async () => ({
            version: '1.4.0',
            release_date: '2026-07-16',
            hermes_home: '/home/agentx/.hermes',
            active_sessions: 2,
            gateway_running: true,
            gateway_pid: 4242,
            gateway_state: 'connected',
            gateway_exit_reason: null,
            gateway_updated_at: '2026-07-17T01:00:00Z',
            gateway_platforms: { telegram: { state: 'connected' } }
          })
        };
      }
      if (url === 'http://hermes.test/') {
        return {
          ok: true,
          text: async () => '<script>window.__HERMES_SESSION_TOKEN__ = "session-secret";</script>'
        };
      }
      if (url === 'http://hermes.test/api/config/raw') {
        expect(options.headers['X-Hermes-Session-Token']).toBe('session-secret');
        return { ok: true, json: async () => ({ model: { default: 'redacted-by-omission' } }) };
      }
      throw new Error(`Unexpected Hermes URL: ${url}`);
    });

    const response = await request(app)
      .get('/api/hermes/status')
      .expect(200);

    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      dashboard: expect.objectContaining({ url: 'http://hermes.test' }),
      hermes: {
        version: '1.4.0',
        releaseDate: '2026-07-16',
        home: '/home/agentx/.hermes',
        activeSessions: 2
      },
      gateway: expect.objectContaining({
        running: true,
        pid: 4242,
        state: 'connected'
      }),
      authority: {
        policy: 'cloud_first_via_agentx_proxy',
        expectedSource: '/api/nerve-center/agent-runtime-config/export',
        liveConfig: { available: true, status: 'checked' },
        liveApply: 'human-gated'
      }
    }));
    expect(JSON.stringify(response.body)).not.toContain('session-secret');
  });

  it('keeps status available while reporting protected live configuration', async () => {
    global.fetch.mockImplementation(async (url) => {
      if (url === 'http://hermes.test/api/status') {
        return { ok: true, json: async () => ({ gateway_running: false }) };
      }
      if (url === 'http://hermes.test/') {
        return { ok: true, text: async () => '<html>login required</html>' };
      }
      throw new Error(`Unexpected Hermes URL: ${url}`);
    });

    const response = await request(app)
      .get('/api/hermes/status')
      .expect(200);

    expect(response.body.ok).toBe(true);
    expect(response.body.gateway.running).toBe(false);
    expect(response.body.authority.liveConfig).toEqual({
      available: false,
      status: 'protected',
      error: 'HTTP 401'
    });
  });

  it('returns an explicit 503 when the Hermes dashboard is not configured', async () => {
    delete process.env.HERMES_DASHBOARD_URL;
    delete process.env.HERMES_PUBLIC_URL;

    const response = await request(app)
      .get('/api/hermes/status')
      .expect(503);

    expect(response.body).toEqual({
      ok: false,
      dashboard: { url: null },
      error: 'Hermes dashboard URL is not configured'
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
