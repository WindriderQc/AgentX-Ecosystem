const request = require('supertest');
const path = require('path');

const mockSearchSimilarChunks = jest.fn();
const mockUpsertDocumentWithChunks = jest.fn();

jest.mock('../../src/services/ragServiceClient', () => ({
  getRagServiceClient: () => ({
    searchSimilarChunks: mockSearchSimilarChunks,
    upsertDocumentWithChunks: mockUpsertDocumentWithChunks
  })
}));

jest.mock('node-fetch', () => jest.fn());

const fetch = require('node-fetch');
const VoicePersonaSession = require('../../models/VoicePersonaSession');
const VoicePersonaAudit = require('../../models/VoicePersonaAudit');
const kidxLexiconService = require('../../src/services/kidxLexiconService');
const { app } = require('../../src/app');

const KIDX_LEXICON_FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'kidx-lexicon.json');

function inferenceResponse(body = { message: { content: 'Ready.' } }, headerOverrides = {}) {
  const headers = {
    'x-resolved-model': 'ax/qwen3.5:9b',
    'x-routed-host': 'http://127.0.0.1:11435',
    'x-routed-host-key': 'secondary',
    'x-routing-source': 'task_router',
    'x-inference-lane': 'interactive',
    'x-routing-task-type': 'voice_persona_chat',
    ...headerOverrides
  };
  return {
    ok: true,
    status: 200,
    text: jest.fn(async () => JSON.stringify(body)),
    headers: {
      get: jest.fn((name) => headers[String(name).toLowerCase()] || '')
    }
  };
}

describe('Voice Personas API', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockSearchSimilarChunks.mockResolvedValue([
      { text: 'Example User prefers short direct voice replies.', score: 0.9 }
    ]);
    mockUpsertDocumentWithChunks.mockResolvedValue({
      documentId: 'voice-persona-memory:test',
      chunkCount: 1
    });
    fetch.mockResolvedValue(inferenceResponse());
    delete process.env.KIDX_LEXICON_PATH;
    kidxLexiconService._resetForTests();
    await VoicePersonaSession.deleteMany({});
    await VoicePersonaAudit.deleteMany({});
  });

  test('lists file-backed voice persona packs', async () => {
    const response = await request(app)
      .get('/api/voice-personas/packs')
      .expect(200);

    expect(response.body.status).toBe('success');
    expect(response.body.data.defaultPackId).toBe('personal_operator');
    expect(response.body.data.packs.map((pack) => pack.id)).toEqual(
      expect.arrayContaining(['personal_operator', 'kidx_nestor'])
    );
  });

  test('renders the Core voice-personas page', async () => {
    const response = await request(app)
      .get('/voice-personas')
      .expect(200);

    expect(response.text).toContain('voicePersonaRoot');
    expect(response.text).toContain('/js/voice-personas.js');
  });

  test('renders the KidX reader parent learning log page', async () => {
    const response = await request(app)
      .get('/lecture/parents')
      .expect(200);

    expect(response.text).toContain('readerParentLog');
    expect(response.text).toContain('/js/lecture-parents.js');
    expect(response.text).toContain('/css/lecture-parents.css');
  });

  test('renders the KidX reader kiosk page', async () => {
    const response = await request(app)
      .get('/lecture')
      .expect(200);

    expect(response.text).toContain('lectureRoot');
    expect(response.text).toContain('data-state="ready"');
    expect(response.text).toContain('aria-live="polite"');
    expect(response.text).toContain('id="retryBtn"');
    expect(response.text).toContain('maxlength="180"');
    expect(response.text).toContain('/js/lecture.js');
    expect(response.text).toContain('/css/lecture.css');
  });

  test('ships the explicit KidX UI state, retry, audio-cancel, and reduced-motion contracts', async () => {
    const script = await request(app).get('/js/lecture.js').expect(200);
    for (const stateName of [
      'ready', 'listening', 'transcribing', 'thinking', 'speaking',
      'complete', 'retryable_error', 'mic_unavailable'
    ]) {
      expect(script.text).toContain(`${stateName}:`);
    }
    expect(script.text).toContain('state.ttsController.abort()');
    expect(script.text).toContain('URL.revokeObjectURL');
    expect(script.text).toContain("form.append('language', 'fr')");
    expect(script.text).toContain("setRetry(function () { ask(content, channel || 'text'); });");

    const css = await request(app).get('/css/lecture.css').expect(200);
    expect(css.text).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css.text).toContain('[data-state="mic_unavailable"]');
  });

  test('creates a session and runs a routed text turn without caller host or model overrides', async () => {
    const sessionResponse = await request(app)
      .post('/api/voice-personas/sessions')
      .send({
        packId: 'personal_operator',
        modeId: 'operator',
        scopeId: 'personal'
      })
      .expect(201);

    const sessionId = sessionResponse.body.data.session.sessionId;
    const turnResponse = await request(app)
      .post(`/api/voice-personas/sessions/${sessionId}/turns/text`)
      .send({
        text: 'What should I do next?',
        history: [{ role: 'assistant', content: 'Previous reply.' }]
      })
      .expect(200);

    expect(turnResponse.body.data.reply.text).toBe('Ready.');
    expect(turnResponse.body.data.model).toEqual(expect.objectContaining({
      model: 'ax/qwen3.5:9b',
      hostKey: 'secondary'
    }));
    expect(fetch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetch.mock.calls[0][1].body);
    expect(payload.taskType).toBe('voice_persona_chat');
    expect(payload.callerDetail).toBe('chat-voice-personas/personal_operator');
    expect(payload.thinkingMode).toBe('off');
    expect(payload.think).toBeUndefined();
    expect(payload.model).toBeUndefined();
    expect(payload.host).toBeUndefined();
    expect(payload.messages[0].content).toContain('Relevant memory:');

    const audit = await VoicePersonaAudit.findOne({ traceId: turnResponse.body.data.traceId }).lean();
    expect(audit).toBeTruthy();
    expect(audit.input.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(audit.input.preview).toContain('What should I do next?');
    expect(audit.input.text).toBeUndefined();
    expect(audit.routing.taskType).toBe('voice_persona_chat');
  });

  test('routes KidX reader turns through the dedicated reader task type', async () => {
    fetch.mockResolvedValueOnce(inferenceResponse(
      { message: { content: 'Gigantesque veut dire tres grand.' } },
      { 'x-routing-task-type': 'voice_persona_reader' }
    ));
    const sessionResponse = await request(app)
      .post('/api/voice-personas/sessions')
      .send({
        packId: 'kidx_reader',
        modeId: 'reader',
        scopeId: 'family'
      })
      .expect(201);

    const sessionId = sessionResponse.body.data.session.sessionId;
    const turnResponse = await request(app)
      .post(`/api/voice-personas/sessions/${sessionId}/turns/text`)
      .send({ text: 'Ca veut dire quoi gigantesque?' })
      .expect(200);

    expect(turnResponse.body.data.reply.text).toBe('Gigantesque veut dire tres grand.');
    const payload = JSON.parse(fetch.mock.calls[0][1].body);
    expect(payload.taskType).toBe('voice_persona_reader');
    expect(payload.callerDetail).toBe('chat-voice-personas/kidx_reader');
    expect(payload.messages[0].content).not.toContain('Relevant memory:');
    expect(mockSearchSimilarChunks).not.toHaveBeenCalled();
    expect(turnResponse.body.data.memory).toEqual(expect.objectContaining({
      chunks: 0,
      warning: '',
      results: []
    }));
    expect(turnResponse.body.data.timings.memoryMs).toBe(0);

    const audit = await VoicePersonaAudit.findOne({ traceId: turnResponse.body.data.traceId }).lean();
    expect(audit.memory.chunks).toBe(0);
    expect(audit.timings.memoryMs).toBe(0);
    expect(audit.routing.taskType).toBe('voice_persona_reader');
  });

  test('grounds a KidX definition in the local exact-match lexicon', async () => {
    process.env.KIDX_LEXICON_PATH = KIDX_LEXICON_FIXTURE;
    kidxLexiconService._resetForTests();
    fetch.mockResolvedValueOnce(inferenceResponse(
      { message: { content: 'Gigantesque veut dire vraiment très grand.' } },
      { 'x-routing-task-type': 'voice_persona_reader' }
    ));
    const sessionResponse = await request(app)
      .post('/api/voice-personas/sessions')
      .send({ packId: 'kidx_reader', modeId: 'reader', scopeId: 'family' })
      .expect(201);

    const turnResponse = await request(app)
      .post(`/api/voice-personas/sessions/${sessionResponse.body.data.session.sessionId}/turns/text`)
      .send({ text: 'gigantesque' })
      .expect(200);

    const payload = JSON.parse(fetch.mock.calls[0][1].body);
    expect(payload.messages[0].content).toContain('Source lexicale locale');
    expect(payload.messages[0].content).toContain('Qui dépasse considérablement la taille ordinaire');
    expect(turnResponse.body.data.upstream.lexicon).toEqual(expect.objectContaining({
      status: 'ready',
      hit: true,
      target: 'gigantesque'
    }));
    expect(turnResponse.body.data.timings.lexiconMs).toBeGreaterThanOrEqual(0);
  });

  test('does not invoke the model for an exact KidX lexicon miss', async () => {
    process.env.KIDX_LEXICON_PATH = KIDX_LEXICON_FIXTURE;
    kidxLexiconService._resetForTests();
    const sessionResponse = await request(app)
      .post('/api/voice-personas/sessions')
      .send({ packId: 'kidx_reader', modeId: 'reader', scopeId: 'family' })
      .expect(201);
    fetch.mockClear();

    const turnResponse = await request(app)
      .post(`/api/voice-personas/sessions/${sessionResponse.body.data.session.sessionId}/turns/text`)
      .send({ text: 'flibertinou' })
      .expect(200);

    expect(fetch).not.toHaveBeenCalled();
    expect(turnResponse.body.data.reply.text).toContain('« flibertinou »');
    expect(turnResponse.body.data.upstream).toEqual(expect.objectContaining({
      skipped: true,
      reason: 'lexicon_miss',
      lexicon: expect.objectContaining({ status: 'ready', hit: false })
    }));
  });

  test('prevents KidX from silently substituting and defining a different word', async () => {
    fetch.mockResolvedValueOnce(inferenceResponse(
      { message: { content: 'Un flibertibou est un personnage très étourdi.' } },
      { 'x-routing-task-type': 'voice_persona_reader' }
    ));
    const sessionResponse = await request(app)
      .post('/api/voice-personas/sessions')
      .send({ packId: 'kidx_reader', modeId: 'reader', scopeId: 'family' })
      .expect(201);

    const turnResponse = await request(app)
      .post(`/api/voice-personas/sessions/${sessionResponse.body.data.session.sessionId}/turns/text`)
      .send({ text: 'Ça veut dire quoi flibertinou?' })
      .expect(200);

    expect(turnResponse.body.data.reply.text).toContain('« flibertinou »');
    expect(turnResponse.body.data.reply.text).toContain('Peux-tu l’épeler');
    expect(turnResponse.body.data.reply.text).not.toContain('flibertibou');
    expect(turnResponse.body.data.upstream.replyGuard).toEqual({
      applied: true,
      reason: 'target-substituted',
      target: 'flibertinou'
    });
  });

  test('rejects invalid turn channels before inference or audit writes', async () => {
    const sessionResponse = await request(app)
      .post('/api/voice-personas/sessions')
      .send({
        packId: 'personal_operator',
        modeId: 'operator',
        scopeId: 'personal'
      })
      .expect(201);

    const sessionId = sessionResponse.body.data.session.sessionId;
    const response = await request(app)
      .post(`/api/voice-personas/sessions/${sessionId}/turns/text`)
      .send({
        text: 'This should not call inference.',
        channel: 'bad-channel'
      })
      .expect(400);

    expect(response.body.code).toBe('VOICE_PERSONA_INVALID_CHANNEL');
    expect(fetch).not.toHaveBeenCalled();
    expect(await VoicePersonaAudit.countDocuments({ sessionId })).toBe(0);
  });

  test('continues a text turn when RAG memory search is down', async () => {
    mockSearchSimilarChunks.mockRejectedValueOnce(new Error('rag down'));
    const sessionResponse = await request(app)
      .post('/api/voice-personas/sessions')
      .send({ packId: 'personal_operator', scopeId: 'personal' })
      .expect(201);

    const sessionId = sessionResponse.body.data.session.sessionId;
    const turnResponse = await request(app)
      .post(`/api/voice-personas/sessions/${sessionId}/turns/text`)
      .send({ text: 'Can you still answer?' })
      .expect(200);

    expect(turnResponse.body.data.reply.text).toBe('Ready.');
    expect(turnResponse.body.data.memory.warning).toBe('rag down');
    const audit = await VoicePersonaAudit.findOne({ traceId: turnResponse.body.data.traceId }).lean();
    expect(audit.memory.warning).toBe('rag down');
  });

  test('writes scoped voice persona memory through RAG with persona and scope tags', async () => {
    const response = await request(app)
      .post('/api/voice-personas/memory')
      .send({
        packId: 'personal_operator',
        modeId: 'operator',
        scopeId: 'personal',
        topic: 'preferences',
        text: 'Example User wants brief voice replies.',
        tags: ['voice']
      })
      .expect(201);

    expect(response.body.data.memory.source).toBe('voice-persona-memory');
    expect(mockUpsertDocumentWithChunks).toHaveBeenCalledWith(
      expect.stringContaining('Example User wants brief voice replies.'),
      expect.objectContaining({
        source: 'voice-persona-memory',
        tags: expect.arrayContaining([
          'voice-persona-memory',
          'persona:personal_operator',
          'scope:personal',
          'type:fact',
          'topic:preferences',
          'mode:operator',
          'voice'
        ])
      })
    );
  });

  test('rejects memory writes and searches for unknown persona packs', async () => {
    const writeResponse = await request(app)
      .post('/api/voice-personas/memory')
      .send({
        packId: 'ghost_pack',
        scopeId: 'personal',
        text: 'This should not be ingested.'
      })
      .expect(404);

    expect(writeResponse.body.code).toBe('VOICE_PERSONA_PACK_NOT_FOUND');
    expect(mockUpsertDocumentWithChunks).not.toHaveBeenCalled();

    const searchResponse = await request(app)
      .post('/api/voice-personas/memory/search')
      .send({
        packId: 'ghost_pack',
        scopeId: 'personal',
        query: 'anything'
      })
      .expect(404);

    expect(searchResponse.body.code).toBe('VOICE_PERSONA_PACK_NOT_FOUND');
    expect(mockSearchSimilarChunks).not.toHaveBeenCalled();
  });

  test('searches scoped voice persona memory through RAG filters', async () => {
    mockSearchSimilarChunks.mockResolvedValueOnce([
      { text: 'Example User likes concise spoken replies.', score: 0.91, documentId: 'memory:1' }
    ]);

    const response = await request(app)
      .post('/api/voice-personas/memory/search')
      .send({
        packId: 'personal_operator',
        scopeId: 'personal',
        query: 'reply style',
        topK: 2
      })
      .expect(200);

    expect(response.body.data.memory.results[0].text).toContain('concise spoken replies');
    expect(mockSearchSimilarChunks).toHaveBeenCalledWith('reply style', {
      topK: 2,
      filters: {
        tags: ['voice-persona-memory', 'persona:personal_operator', 'scope:personal']
      }
    });
  });

  test('rejects memory writes for modes outside the selected pack', async () => {
    const response = await request(app)
      .post('/api/voice-personas/memory')
      .send({
        packId: 'personal_operator',
        modeId: 'kid',
        scopeId: 'personal',
        text: 'Wrong mode should fail.'
      })
      .expect(400);

    expect(response.body.code).toBe('INVALID_MEMORY_SCOPE');
    expect(mockUpsertDocumentWithChunks).not.toHaveBeenCalled();
  });

  test('returns recent audit and alert analysis', async () => {
    await VoicePersonaAudit.create({
      traceId: 'trace-self-harm',
      sessionId: 'session-alert',
      packId: 'kidx_nestor',
      modeId: 'kid',
      scopeId: 'family',
      input: { length: 12, sha256: 'a'.repeat(64), preview: 'want to die' },
      reply: { length: 8, sha256: 'b'.repeat(64), preview: 'help now' },
      safety: {
        mode: 'family-child',
        flags: ['self_harm'],
        requiresAttention: true,
        deterministicEscalation: true
      }
    });

    const audit = await request(app)
      .get('/api/voice-personas/audit/recent?packId=kidx_nestor&scopeId=family')
      .expect(200);
    expect(audit.body.data.audit).toHaveLength(1);

    const alerts = await request(app)
      .get('/api/voice-personas/alerts?packId=kidx_nestor&scopeId=family')
      .expect(200);
    expect(alerts.body.data.alerts.status).toBe('attention');
    expect(alerts.body.data.alerts.alerts[0].flagId).toBe('self_harm');
  });

  test('returns KidX reader audit fields used by the parent learning log', async () => {
    await VoicePersonaAudit.create({
      traceId: 'trace-reader-word',
      sessionId: 'session-reader',
      packId: 'kidx_reader',
      modeId: 'reader',
      scopeId: 'family',
      channel: 'voice',
      input: { length: 32, sha256: 'c'.repeat(64), preview: 'ca veut dire quoi gigantesque?' },
      reply: { length: 34, sha256: 'd'.repeat(64), preview: 'Gigantesque veut dire tres grand.' },
      safety: {
        mode: 'family-child',
        flags: ['reading_help'],
        requiresAttention: false,
        deterministicEscalation: false
      },
      timings: { totalMs: 1220, memoryMs: 0, upstreamMs: 1180 },
      model: {
        model: 'ax/gemma4:e4b',
        host: 'http://192.0.2.105:11434',
        hostKey: 'primary'
      },
      routing: {
        taskType: 'voice_persona_reader',
        source: 'task_router',
        lane: 'interactive'
      }
    });

    const response = await request(app)
      .get('/api/voice-personas/audit/recent?packId=kidx_reader&scopeId=family')
      .expect(200);

    expect(response.body.data.audit).toHaveLength(1);
    expect(response.body.data.audit[0]).toEqual(expect.objectContaining({
      packId: 'kidx_reader',
      scopeId: 'family',
      channel: 'voice',
      input: expect.objectContaining({ preview: 'ca veut dire quoi gigantesque?' }),
      reply: expect.objectContaining({ preview: 'Gigantesque veut dire tres grand.' }),
      safety: expect.objectContaining({
        flags: ['reading_help'],
        requiresAttention: false
      }),
      timings: expect.objectContaining({ totalMs: 1220, memoryMs: 0, upstreamMs: 1180 }),
      model: expect.objectContaining({ model: 'ax/gemma4:e4b', hostKey: 'primary' }),
      routing: expect.objectContaining({ taskType: 'voice_persona_reader', lane: 'interactive' })
    }));
  });
});
