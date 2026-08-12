const fetch = require('node-fetch');

jest.mock('node-fetch');
jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

function mockPendingFetchUntilAbort() {
  fetch.mockImplementation((_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  }));
}

const {
  VoixClientError,
  DEFAULT_VOIX_LONG_TIMEOUT_MS,
  buildVoixUrl,
  getVoixTimeoutMs,
  getVoixLongTimeoutMs,
  diagnosticsSmoke,
  diagnosticsTtsSmoke,
  voiceProfile,
  sessionStatus,
  startSession,
  stopSession,
  cancelSession,
  health,
  updateConfig,
  devices,
  textTurn,
  synthesize,
  whisperModels
} = require('../../src/services/voixClientService');

describe('voixClientService', () => {
  const originalEnv = {
    VOIX_BASE_URL: process.env.VOIX_BASE_URL,
    VOIX_TIMEOUT_MS: process.env.VOIX_TIMEOUT_MS,
    VOIX_LONG_TIMEOUT_MS: process.env.VOIX_LONG_TIMEOUT_MS
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VOIX_BASE_URL = '127.0.0.1:8091/';
    process.env.VOIX_TIMEOUT_MS = '4321';
    process.env.VOIX_LONG_TIMEOUT_MS = '65432';
  });

  afterAll(() => {
    process.env.VOIX_BASE_URL = originalEnv.VOIX_BASE_URL;
    process.env.VOIX_TIMEOUT_MS = originalEnv.VOIX_TIMEOUT_MS;
    process.env.VOIX_LONG_TIMEOUT_MS = originalEnv.VOIX_LONG_TIMEOUT_MS;
  });

  it('normalizes the configured base URL and proxies health checks', async () => {
    fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ status: 'ok', engine: 'voix' }))
    });

    const response = await health();

    expect(response).toEqual({ status: 'ok', engine: 'voix' });
    expect(fetch).toHaveBeenCalledWith(
      buildVoixUrl('/health'),
      expect.objectContaining({
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      })
    );
  });

  it('sends typed text turns to the shared VoiX endpoint', async () => {
    fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({
        session_id: 'sess-123',
        reply: { text: 'Bonjour' }
      }))
    });

    const payload = { text: 'Salut', session_id: 'sess-123' };
    const response = await textTurn(payload);

    expect(response.session_id).toBe('sess-123');
    expect(fetch).toHaveBeenCalledWith(
      buildVoixUrl('/sessions/text-turn'),
      expect.objectContaining({
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      })
    );
  });

  it('sends synthesis requests to the VoiX v2 JSON TTS endpoint', async () => {
    const upstream = {
      ok: true,
      headers: { get: jest.fn(() => 'audio/wav') },
      buffer: jest.fn(() => Promise.resolve(Buffer.from('RIFF')))
    };
    fetch.mockResolvedValue(upstream);

    const response = await synthesize({ input: 'Bonjour', voice: 'ff_siwis', response_format: 'wav' });

    expect(response).toBe(upstream);
    expect(fetch).toHaveBeenCalledWith(
      buildVoixUrl('/api/tts'),
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Bonjour',
          voice: 'ff_siwis',
          response_format: 'wav',
          save: false
        })
      })
    );
  });

  it('exposes v2 discovery and session control helpers', async () => {
    fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ ok: true }))
    });

    await voiceProfile();
    expect(fetch).toHaveBeenLastCalledWith(
      buildVoixUrl('/voice-profile'),
      expect.objectContaining({ method: 'GET' })
    );

    await whisperModels();
    expect(fetch).toHaveBeenLastCalledWith(
      buildVoixUrl('/v1/models'),
      expect.objectContaining({ method: 'GET' })
    );

    await sessionStatus();
    expect(fetch).toHaveBeenLastCalledWith(
      buildVoixUrl('/sessions/status'),
      expect.objectContaining({ method: 'GET' })
    );

    await startSession({});
    expect(fetch).toHaveBeenLastCalledWith(
      buildVoixUrl('/sessions/start'),
      expect.objectContaining({ method: 'POST' })
    );

    await stopSession({});
    expect(fetch).toHaveBeenLastCalledWith(
      buildVoixUrl('/sessions/stop'),
      expect.objectContaining({ method: 'POST' })
    );

    await cancelSession({});
    expect(fetch).toHaveBeenLastCalledWith(
      buildVoixUrl('/sessions/cancel'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('updates VoiX runtime config via POST /config', async () => {
    fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({
        changed: ['tts_provider'],
        config: { tts_provider: 'windows_sapi' }
      }))
    });

    const payload = { tts_provider: 'windows_sapi' };
    const response = await updateConfig(payload);

    expect(response.config.tts_provider).toBe('windows_sapi');
    expect(fetch).toHaveBeenCalledWith(
      buildVoixUrl('/config'),
      expect.objectContaining({
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      })
    );
  });

  it('uses short and long timeout settings for the correct request classes', async () => {
    fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ status: 'ok' }))
    });

    await health();
    expect(fetch).toHaveBeenLastCalledWith(
      buildVoixUrl('/health'),
      expect.objectContaining({
        method: 'GET',
        timeout: getVoixTimeoutMs()
      })
    );

    await diagnosticsTtsSmoke({});
    expect(fetch).toHaveBeenLastCalledWith(
      buildVoixUrl('/diagnostics/tts-smoke'),
      expect.objectContaining({
        method: 'POST',
        signal: expect.any(AbortSignal),
        timeout: getVoixLongTimeoutMs()
      })
    );

    await diagnosticsSmoke({});
    expect(fetch).toHaveBeenLastCalledWith(
      buildVoixUrl('/diagnostics/smoke'),
      expect.objectContaining({
        method: 'POST',
        signal: expect.any(AbortSignal),
        timeout: getVoixLongTimeoutMs()
      })
    );
  });

  it('falls back to the default long timeout when no override is configured', async () => {
    process.env.VOIX_LONG_TIMEOUT_MS = '';
    jest.useFakeTimers();

    try {
      mockPendingFetchUntilAbort();
      const fullPromise = diagnosticsSmoke({});
      jest.advanceTimersByTime(DEFAULT_VOIX_LONG_TIMEOUT_MS);
      await expect(fullPromise).rejects.toMatchObject({
        status: 504,
        code: 'VOIX_TIMEOUT'
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('raises a readable unavailable-service error when VoiX cannot be reached', async () => {
    fetch.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8091'));

    await expect(devices()).rejects.toMatchObject({
      name: 'VoixClientError',
      status: 503,
      code: 'VOIX_UNAVAILABLE'
    });

    await devices().catch((error) => {
      expect(error).toBeInstanceOf(VoixClientError);
      expect(error.message).toContain('VoiX service unavailable');
      expect(error.message).toContain('/devices');
    });
  });
});
