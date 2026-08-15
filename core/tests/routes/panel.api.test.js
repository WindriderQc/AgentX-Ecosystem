const request = require('supertest');

jest.mock('../../src/services/portalStatusService', () => ({
  getPortalStatus: jest.fn()
}));

jest.mock('../../src/services/voixClientService', () => ({
  health: jest.fn()
}));

const portalStatusService = require('../../src/services/portalStatusService');
const voixClient = require('../../src/services/voixClientService');
const panelService = require('../../src/services/panelService');
const { app } = require('../../src/app');

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function mockPortal() {
  portalStatusService.getPortalStatus.mockResolvedValue({
    generated_at: '2026-06-24T12:00:00.000Z',
    summary: { total: 5, healthy: 5, degraded: 0, down: 0 },
    services: [
      { id: 'core', label: 'AgentX Core', status: 'ok', latency_ms: 0 },
      { id: 'rag', label: 'RAG', status: 'ok', latency_ms: 12 }
    ]
  });
}

describe('Panel API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    panelService._resetForTests();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.HOME_ASSISTANT_BASE_URL;
    delete process.env.HOME_ASSISTANT_TOKEN;
    delete process.env.HOME_ASSISTANT_ENTITY_ALLOWLIST;
    global.fetch = jest.fn();
    mockPortal();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    global.fetch = ORIGINAL_FETCH;
  });

  test('renders the house panel page', async () => {
    const response = await request(app)
      .get('/panel')
      .expect(200);

    expect(response.text).toContain('housePanelRoot');
    expect(response.text).toContain('aria-label="Nestor"');
    expect(response.text).toContain('<h1>Nestor</h1>');
    expect(response.text).not.toContain('AgentX Family Voice');
    expect(response.text).toContain('id="panelMicToggle"');
    expect(response.text).toContain('id="panelDiagnostics"');
    expect(response.text).toContain('id="panelAlerts"');
    expect(response.text).toContain('id="panelPersonalTasks"');
    expect(response.text).toContain('Ma liste');
    expect(response.text).toContain('href="/lecture"');
    expect(response.text).toContain('href="/lecture/parents"');
    expect(response.text).toContain('/js/nestor-voice-stream.js');
    expect(response.text).toContain('/js/panel.js');
    expect(response.text).toContain('/css/panel.css');
  });

  test('redirects the retired Nestor route to the product playground', async () => {
    const response = await request(app)
      .get('/nestor')
      .expect(302);

    expect(response.headers.location).toBe('/playground');
  });

  test('returns panel status even when VoiX is unavailable and Home Assistant is disabled', async () => {
    voixClient.health.mockRejectedValue(new Error('voix down'));

    const response = await request(app)
      .get('/api/panel/status')
      .expect(200);

    expect(response.body.status).toBe('success');
    expect(response.body.data.portal.summary.healthy).toBe(5);
    expect(response.body.data.voix.status).toBe('down');
    expect(response.body.data.voix.error).toBe('voix down');
    expect(response.body.data.nestor).toBeUndefined();
    expect(response.body.data.familyVoicePersona).toEqual(expect.objectContaining({
      status: 'available',
      kind: 'agentx_voice_persona',
      displayName: 'AgentX Family Voice',
      pack: expect.objectContaining({ id: 'kidx_nestor', name: 'AgentX Family Voice' }),
      connection: expect.objectContaining({ state: 'not_applicable' })
    }));
    expect(response.body.data.familyVoicePersona.connection.note).toContain(
      'does not report desktop Nestor connectivity'
    );
    expect(response.body.data.reader.status).toBe('ok');
    expect(response.body.data.reader.pack.id).toBe('kidx_reader');
    expect(response.body.data.reader.mode.id).toBe('reader');
    expect(response.body.data.deviceTarget.kioskUrl).toBe('');
    expect(response.body.data.reader.lexicon).toEqual(expect.objectContaining({
      status: expect.stringMatching(/^(ready|unavailable)$/),
      entryCount: expect.any(Number)
    }));
    expect(response.body.data.home.status).toBe('disabled');
  });

  test('records heartbeat and exposes it in status', async () => {
    voixClient.health.mockResolvedValue({ status: 'ok' });

    await request(app)
      .post('/api/panel/heartbeat')
      .send({
        deviceId: 'surface-test',
        label: 'Kitchen Panel',
        userAgent: 'Jest'
      })
      .expect(200);

    const response = await request(app)
      .get('/api/panel/status')
      .expect(200);

    expect(response.body.data.heartbeats).toHaveLength(1);
    expect(response.body.data.heartbeats[0]).toEqual(expect.objectContaining({
      deviceId: 'surface-test',
      label: 'Kitchen Panel',
      userAgent: 'Jest'
    }));
  });

  test('returns disabled Home Assistant state when env is incomplete', async () => {
    const response = await request(app)
      .get('/api/panel/home')
      .expect(200);

    expect(response.body.status).toBe('success');
    expect(response.body.data.home.enabled).toBe(false);
    expect(response.body.data.home.status).toBe('disabled');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('reads only allowlisted Home Assistant entities without leaking the token', async () => {
    process.env.HOME_ASSISTANT_BASE_URL = 'http://ha.local:8123';
    process.env.HOME_ASSISTANT_TOKEN = 'secret-token';
    process.env.HOME_ASSISTANT_ENTITY_ALLOWLIST = 'sensor.temperature,light.entry';

    global.fetch.mockImplementation(async (url) => {
      const id = decodeURIComponent(String(url).split('/api/states/')[1]);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          entity_id: id,
          state: id === 'sensor.temperature' ? '21.5' : 'off',
          attributes: {
            friendly_name: id === 'sensor.temperature' ? 'Temperature' : 'Entry Light',
            unit_of_measurement: id === 'sensor.temperature' ? 'C' : ''
          },
          last_changed: '2026-06-24T12:00:00Z',
          last_updated: '2026-06-24T12:00:00Z'
        })
      };
    });

    const response = await request(app)
      .get('/api/panel/home')
      .expect(200);

    expect(response.body.data.home.enabled).toBe(true);
    expect(response.body.data.home.status).toBe('ok');
    expect(response.body.data.home.entities.map((entity) => entity.entity_id)).toEqual([
      'sensor.temperature',
      'light.entry'
    ]);
    expect(JSON.stringify(response.body)).not.toContain('secret-token');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer secret-token');
  });
});
