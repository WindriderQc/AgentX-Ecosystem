const request = require('supertest');

jest.mock('../../src/services/voixClientService', () => ({
  health: jest.fn(),
  config: jest.fn(),
  updateConfig: jest.fn(),
  devices: jest.fn(),
  metrics: jest.fn(),
  voiceProfile: jest.fn(),
  sessionStatus: jest.fn(),
  startSession: jest.fn(),
  stopSession: jest.fn(),
  cancelSession: jest.fn(),
  whisperModels: jest.fn(),
  diagnosticsTtsSmoke: jest.fn(),
  diagnosticsSmoke: jest.fn(),
  createSession: jest.fn(),
  listSessions: jest.fn(),
  getSession: jest.fn(),
  getSessionEvents: jest.fn(),
  textTurn: jest.fn(),
  synthesize: jest.fn()
}));

const voixClient = require('../../src/services/voixClientService');
const { app } = require('../../src/app');

describe('VoiX proxy routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('proxies VoiX health through /api/voix/health', async () => {
    voixClient.health.mockResolvedValue({
      status: 'ok',
      engine: 'voix'
    });

    const response = await request(app)
      .get('/api/voix/health')
      .expect(200);

    expect(response.body.status).toBe('success');
    expect(response.body.data).toEqual({
      status: 'ok',
      engine: 'voix'
    });
    expect(voixClient.health).toHaveBeenCalledWith({
      query: {}
    });
  });

  it('proxies typed turns through /api/voix/sessions/text-turn', async () => {
    voixClient.textTurn.mockResolvedValue({
      session_id: 'sess-42',
      reply: {
        text: 'Bonjour'
      }
    });

    const payload = {
      text: 'Salut',
      session_id: 'sess-42'
    };

    const response = await request(app)
      .post('/api/voix/sessions/text-turn')
      .send(payload)
      .expect(200);

    expect(response.body.status).toBe('success');
    expect(response.body.data.reply.text).toBe('Bonjour');
    expect(voixClient.textTurn).toHaveBeenCalledWith(payload);
  });

  it('routes quick smoke through /api/voix/diagnostics/tts-smoke', async () => {
    voixClient.diagnosticsTtsSmoke.mockResolvedValue({
      status: 'ok',
      engine: 'tts'
    });

    const payload = { voice: 'alloy' };

    const response = await request(app)
      .post('/api/voix/diagnostics/tts-smoke')
      .send(payload)
      .expect(200);

    expect(response.body.status).toBe('success');
    expect(response.body.data).toEqual({
      status: 'ok',
      engine: 'tts'
    });
    expect(voixClient.diagnosticsTtsSmoke).toHaveBeenCalledWith(payload);
  });

  it('exposes voice mode metadata through /api/voix/settings', async () => {
    const response = await request(app)
      .get('/api/voix/settings')
      .expect(200);

    expect(response.body.status).toBe('success');
    expect(response.body.data.voiceMode).toMatch(/^(browser|hybrid|native)$/);
    expect(response.body.data.voiceModes.map((mode) => mode.id)).toEqual(['browser', 'hybrid', 'native']);
  });

  it('exposes the AgentX Voice contract without probing VoiX live runtime', async () => {
    const response = await request(app)
      .get('/api/voix/contract')
      .expect(200);

    expect(response.body.status).toBe('success');
    expect(response.body.data.version).toBe('agentx-voice-v1');
    expect(response.body.data.routes.currentCoreProxy).toContain('POST /api/voix/transcribe');
    expect(response.body.data.capabilities.pushToTalk.status).toBe('available');
    expect(response.body.data.capabilities.wakeWord.status).toBe('not_implemented');
    expect(response.body.data.capabilities.vad.status).toBe('not_implemented');
    expect(voixClient.health).not.toHaveBeenCalled();
  });

  it('proxies VoiX models through /api/voix/models', async () => {
    voixClient.whisperModels.mockResolvedValue({
      object: 'list',
      data: [{ id: 'small', type: 'whisper' }]
    });

    const response = await request(app)
      .get('/api/voix/models')
      .expect(200);

    expect(response.body.status).toBe('success');
    expect(response.body.data.data[0].id).toBe('small');
    expect(voixClient.whisperModels).toHaveBeenCalled();
  });

  it('proxies VoiX voice profile through /api/voix/voice-profile', async () => {
    voixClient.voiceProfile.mockResolvedValue({
      service: 'voix',
      tts: { synthesize: 'http://127.0.0.1:8091/api/tts' }
    });

    const response = await request(app)
      .get('/api/voix/voice-profile')
      .expect(200);

    expect(response.body.status).toBe('success');
    expect(response.body.data.service).toBe('voix');
    expect(voixClient.voiceProfile).toHaveBeenCalledWith({ query: {} });
  });

  it('proxies VoiX runtime config updates through /api/voix/config', async () => {
    voixClient.updateConfig.mockResolvedValue({
      changed: ['tts_provider'],
      config: { tts_provider: 'windows_sapi' }
    });

    const payload = { tts_provider: 'windows_sapi' };
    const response = await request(app)
      .post('/api/voix/config')
      .send(payload)
      .expect(200);

    expect(response.body.status).toBe('success');
    expect(response.body.data.config.tts_provider).toBe('windows_sapi');
    expect(voixClient.updateConfig).toHaveBeenCalledWith(payload);
  });

  it('proxies v2 session control routes', async () => {
    voixClient.startSession.mockResolvedValue({ running: true, session_id: 's1' });
    voixClient.sessionStatus.mockResolvedValue({ running: true, session_id: 's1' });
    voixClient.stopSession.mockResolvedValue({ running: false, session_id: 's1' });
    voixClient.cancelSession.mockResolvedValue({ running: true, cancelled: true });

    await request(app).post('/api/voix/sessions/start').send({}).expect(200);
    await request(app).get('/api/voix/sessions/status').expect(200);
    await request(app).post('/api/voix/sessions/stop').send({}).expect(200);
    await request(app).post('/api/voix/sessions/cancel').send({}).expect(200);

    expect(voixClient.startSession).toHaveBeenCalledWith({});
    expect(voixClient.sessionStatus).toHaveBeenCalledWith({ query: {} });
    expect(voixClient.stopSession).toHaveBeenCalledWith({});
    expect(voixClient.cancelSession).toHaveBeenCalledWith({});
  });

  it('streams VoiX synthesis bytes through /api/voix/synthesize', async () => {
    voixClient.synthesize.mockResolvedValue({
      headers: { get: jest.fn(() => 'audio/wav') },
      buffer: jest.fn(() => Promise.resolve(Buffer.from('RIFF')))
    });

    const response = await request(app)
      .post('/api/voix/synthesize')
      .send({ text: 'Bonjour', voice: 'ff_siwis', response_format: 'wav' })
      .expect(200);

    expect(response.headers['content-type']).toMatch(/audio\/wav/);
    expect(response.body.toString()).toBe('RIFF');
    expect(voixClient.synthesize).toHaveBeenCalledWith({
      input: 'Bonjour',
      voice: 'ff_siwis',
      model: '',
      response_format: 'wav'
    });
  });

});
