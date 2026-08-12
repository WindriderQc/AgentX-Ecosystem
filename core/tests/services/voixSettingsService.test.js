const fs = require('fs');

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const settingsService = require('../../src/services/voixSettingsService');

describe('voixSettingsService', () => {
  const originalEnv = { ...process.env };
  let originalRuntimeFile = null;

  beforeAll(() => {
    if (fs.existsSync(settingsService.RUNTIME_FILE)) {
      originalRuntimeFile = fs.readFileSync(settingsService.RUNTIME_FILE, 'utf8');
    }
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    if (fs.existsSync(settingsService.RUNTIME_FILE)) {
      fs.unlinkSync(settingsService.RUNTIME_FILE);
    }
  });

  afterAll(() => {
    process.env = originalEnv;
    if (originalRuntimeFile == null) {
      if (fs.existsSync(settingsService.RUNTIME_FILE)) fs.unlinkSync(settingsService.RUNTIME_FILE);
    } else {
      fs.writeFileSync(settingsService.RUNTIME_FILE, originalRuntimeFile);
    }
  });

  it('resolves feature defaults from env with source labels', () => {
    process.env.VOICE_MODE = 'hybrid';
    process.env.VOICE_STT_PROVIDER = 'voix';
    process.env.VOICE_STT_LANGUAGE = 'fr';
    process.env.VOICE_TTS_ENABLED = 'true';
    process.env.VOICE_TTS_PROVIDER = 'voix';
    process.env.VOICE_TTS_VOICE = 'af_sarah';
    process.env.VOICE_CONVO_MODE_ENABLED = 'true';

    const settings = settingsService.getSettings();

    expect(settings.voiceMode).toBe('hybrid');
    expect(settings.voiceModeSource).toBe('env');
    expect(settings.voiceModes.map((mode) => mode.id)).toEqual(['browser', 'hybrid', 'native']);
    expect(settings.features.stt).toMatchObject({
      enabled: true,
      provider: 'voix',
      language: 'fr'
    });
    expect(settings.features.tts).toMatchObject({
      enabled: true,
      provider: 'voix',
      voice: 'af_sarah'
    });
    expect(settings.features.convoMode.enabled).toBe(true);
    expect(settings.sources['features.stt.provider']).toBe('env');
    expect(settings.sources['features.tts.enabled']).toBe('env');
  });

  it('applies voice mode presets to chat-facing feature defaults', () => {
    settingsService.setSettings({
      features: {
        stt: { enabled: false },
        tts: { enabled: false },
        convoMode: { keepSession: false }
      }
    });

    let settings = settingsService.setSettings({ voiceMode: 'browser' });

    expect(settings.voiceMode).toBe('browser');
    expect(settings.features.stt.enabled).toBe(true);
    expect(settings.features.stt.provider).toBe('browser');
    expect(settings.features.tts.provider).toBe('browser');
    expect(settings.features.tts.enabled).toBe(true);
    expect(settings.features.convoMode).toMatchObject({
      enabled: false,
      autoSpeak: false,
      keepSession: true
    });

    settings = settingsService.setSettings({ voiceMode: 'hybrid' });
    expect(settings.voiceMode).toBe('hybrid');
    expect(settings.features.stt.enabled).toBe(true);
    expect(settings.features.stt.provider).toBe('voix');
    expect(settings.features.tts.provider).toBe('voix');
    expect(settings.features.tts.enabled).toBe(true);
    expect(settings.features.convoMode).toMatchObject({
      enabled: false,
      autoSpeak: false,
      keepSession: true
    });

    settings = settingsService.setSettings({ voiceMode: 'native' });
    expect(settings.voiceMode).toBe('native');
    expect(settings.features.stt.enabled).toBe(true);
    expect(settings.features.stt.provider).toBe('voix');
    expect(settings.features.tts.provider).toBe('voix');
    expect(settings.features.convoMode).toMatchObject({
      enabled: true,
      autoSpeak: true,
      keepSession: true
    });
  });

  it('rejects unsupported voice modes', () => {
    expect(() => settingsService.setSettings({ voiceMode: 'wat' })).toThrow(/voiceMode/);
  });

  it('persists runtime feature overrides and clears them back to env/defaults', () => {
    process.env.VOICE_TTS_ENABLED = 'false';

    let settings = settingsService.setSettings({
      features: {
        stt: { provider: 'voix', language: 'en', model: 'base' },
        tts: { enabled: true, provider: 'voix', voice: 'af_sarah', responseFormat: 'wav' },
        convoMode: { enabled: true, autoSpeak: false, keepSession: false }
      }
    });

    expect(settings.features.stt.provider).toBe('voix');
    expect(settings.features.stt.model).toBe('base');
    expect(settings.features.tts.enabled).toBe(true);
    expect(settings.features.tts.responseFormat).toBe('wav');
    expect(settings.features.convoMode).toMatchObject({
      enabled: true,
      autoSpeak: false,
      keepSession: false
    });
    expect(settings.sources['features.tts.enabled']).toBe('runtime');

    settings = settingsService.setSettings({
      features: {
        stt: { provider: null, language: null, model: null },
        tts: { enabled: null, provider: null, voice: null, responseFormat: null },
        convoMode: { enabled: null, autoSpeak: null, keepSession: null }
      }
    });

    expect(settings.features.stt.provider).toBe(settingsService.DEFAULTS.features.stt.provider);
    expect(settings.features.tts.enabled).toBe(false);
    expect(settings.features.convoMode.enabled).toBe(settingsService.DEFAULTS.features.convoMode.enabled);
    expect(settings.sources['features.tts.enabled']).toBe('env');
  });

  it('rejects runtime baseUrl overrides outside the configured allowlist', () => {
    expect(() => settingsService.setSettings({
      baseUrl: 'http://169.254.169.254/latest/meta-data'
    })).toThrow(/allowlist/i);
  });

  it('allows runtime baseUrl overrides explicitly configured by env', () => {
    process.env.VOIX_ALLOWED_BASE_URLS = 'http://192.0.2.12:8091, http://voicebox:8091/';

    const settings = settingsService.setSettings({
      baseUrl: 'http://voicebox:8091/'
    });

    expect(settings.baseUrl).toBe('http://voicebox:8091');
    expect(settings.allowedBaseUrls).toContain('http://voicebox:8091');
  });
});
