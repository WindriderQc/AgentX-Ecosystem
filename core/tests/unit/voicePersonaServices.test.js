const mockGetActive = jest.fn(async () => null);
const mockFindOnePrompt = jest.fn(async () => ({ name: 'default_chat' }));
const mockCreatePrompt = jest.fn(async (doc) => doc);
const mockUpsertDocumentWithChunks = jest.fn(async (_text, meta) => ({
  documentId: meta.documentId,
  chunkCount: 1
}));
const mockSearchSimilarChunks = jest.fn(async () => [
  { text: 'Example User likes concise spoken replies.', score: 0.91 }
]);

jest.mock('../../models/PromptConfig', () => {
  function MockPromptConfig(doc) {
    Object.assign(this, doc);
  }
  MockPromptConfig.getActive = mockGetActive;
  MockPromptConfig.findOne = mockFindOnePrompt;
  MockPromptConfig.create = mockCreatePrompt;
  return MockPromptConfig;
});

jest.mock('../../src/services/ragServiceClient', () => ({
  getRagServiceClient: () => ({
    upsertDocumentWithChunks: mockUpsertDocumentWithChunks,
    searchSimilarChunks: mockSearchSimilarChunks
  })
}));

const {
  getPack,
  listPacks,
  resolveMode,
  resolvePrompt,
  _resetPackCacheForTests
} = require('../../src/services/voicePersonaPacks');
const {
  assessTurn
} = require('../../src/services/voicePersonaSafety');
const {
  buildMemorySection,
  buildVoicePersonaMessages,
  sanitizeHistory
} = require('../../src/services/voicePersonaPrompt');
const {
  normalizeMemoryInput,
  saveScopedMemory,
  searchScopedMemory
} = require('../../src/services/voicePersonaMemoryService');
const {
  textRecord
} = require('../../src/services/voicePersonaAuditService');

describe('voice persona services', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetPackCacheForTests();
  });

  it('loads declarative voice persona packs from disk', () => {
    const packs = listPacks();

    expect(packs.map((pack) => pack.id)).toEqual(['kidx_nestor', 'kidx_reader', 'personal_operator']);
    expect(packs[0]).toEqual(expect.objectContaining({
      name: 'AgentX Family Voice',
      defaultMode: 'kid'
    }));
    expect(packs[0].modes.map((mode) => mode.id)).toEqual(['kid', 'family', 'parent']);

    // kidx_reader (0306): fast kid reading-aid pack. Guard its identity, single
    // reader mode, short reply cap, and kid-safe escalation floor so none can be
    // silently dropped by a future edit.
    const reader = packs.find((pack) => pack.id === 'kidx_reader');
    expect(reader).toEqual(expect.objectContaining({ name: 'KidX Lecteur', defaultMode: 'reader' }));
    expect(reader.modes.map((mode) => mode.id)).toEqual(['reader']);
    expect(reader.safety.deterministicEscalationFlags).toEqual(
      expect.arrayContaining(['self_harm', 'immediate_danger', 'abuse_or_threat'])
    );
    const readerPack = getPack('kidx_reader');
    expect(readerPack.inference.taskType).toBe('voice_persona_reader');
    expect(readerPack.inference.maxReplyTokens).toBeLessThanOrEqual(100);
    expect(readerPack.systemPrompt).toContain('ne devine jamais une definition');
    expect(readerPack.systemPrompt).toContain('ne transforme jamais ton hypothese en certitude');
    expect(readerPack.systemPrompt).toContain('ne termine pas par une question');
  });

  it('resolves prompt configs with manifest fallback', async () => {
    const pack = getPack('personal_operator');
    const mode = resolveMode(pack, 'operator');
    const prompt = await resolvePrompt(pack);

    expect(mode.id).toBe('operator');
    expect(prompt.source).toBe('manifest');
    expect(prompt.prompt).toContain('local AgentX voice persona');
    expect(mockGetActive).toHaveBeenCalledWith('voice_persona_personal_operator');
  });

  it('flags deterministic child-safety escalation turns', () => {
    const pack = getPack('kidx_nestor');
    const safety = assessTurn('Il y a du feu et je saigne.', pack);

    expect(safety.flagIds).toEqual(expect.arrayContaining(['immediate_danger']));
    expect(safety.requiresParentAttention).toBe(true);
    expect(safety.deterministicEscalation).toBe(true);
  });

  it('builds spoken prompt messages from persona, memory, safety, and trimmed history', async () => {
    const pack = getPack('kidx_nestor');
    const mode = resolveMode(pack, 'family');
    const safety = assessTurn('Je suis triste aujourd hui.', pack);
    const messages = await buildVoicePersonaMessages({
      pack,
      mode,
      prompt: pack.systemPrompt,
      promptSource: 'manifest',
      promptConfig: null,
      scopeId: 'family',
      memoryResults: [{ text: 'Prefers short funny quizzes.' }],
      safety,
      history: [
        { role: 'system', content: 'drop me' },
        { role: 'user', content: 'Salut' },
        { role: 'assistant', content: 'Bonjour' }
      ],
      userText: 'On joue?'
    });

    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('Persona pack: kidx_nestor. Mode: family.');
    expect(messages[0].content).toContain('Relevant memory:');
    expect(messages[0].content).toContain('emotional_distress');
    expect(messages.slice(1).map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('normalizes scoped memory and persists it through the RAG client', async () => {
    const normalized = normalizeMemoryInput({
      text: 'Example User prefers the personal operator voice in the workshop.',
      packId: 'personal_operator',
      scopeId: 'Workshop',
      type: 'summary',
      topic: 'Voice Defaults',
      tags: ['Prefs']
    });

    expect(normalized.scopeId).toBe('workshop');
    expect(normalized.tags).toEqual(expect.arrayContaining([
      'voice-persona-memory',
      'persona:personal_operator',
      'scope:workshop',
      'type:summary',
      'topic:voice-defaults',
      'prefs'
    ]));

    const saved = await saveScopedMemory({
      ...normalized,
      text: 'Example User prefers the personal operator voice in the workshop.'
    });

    expect(saved.documentId).toMatch(/^voice-persona-memory:/);
    expect(mockUpsertDocumentWithChunks).toHaveBeenCalledWith(
      expect.stringContaining('Voice Persona Memory: voice-defaults'),
      expect.objectContaining({
        source: 'voice-persona-memory',
        tags: expect.arrayContaining(['persona:personal_operator', 'scope:workshop'])
      })
    );
  });

  it('searches scoped memory with persona and scope filters', async () => {
    const result = await searchScopedMemory({
      packId: 'personal_operator',
      scopeId: 'default',
      query: 'reply style',
      topK: 3
    });

    expect(result.warning).toBe('');
    expect(result.results).toHaveLength(1);
    expect(mockSearchSimilarChunks).toHaveBeenCalledWith('reply style', {
      topK: 3,
      filters: {
        tags: ['voice-persona-memory', 'persona:personal_operator', 'scope:default']
      }
    });
  });

  it('keeps audit text private by default', () => {
    const record = textRecord('  Very private transcript text  ');

    expect(record.length).toBe(28);
    expect(record.sha256).toHaveLength(64);
    expect(record.preview).toBe('Very private transcript text');
    expect(record.text).toBeUndefined();

    expect(textRecord('raw please', { rawTranscriptRetention: 'enabled' }).text).toBe('raw please');
  });

  it('clips prompt history and memory snippets', () => {
    const history = sanitizeHistory([
      { role: 'user', content: 'a'.repeat(2000) },
      { role: 'assistant', content: 'ok' }
    ]);
    const memory = buildMemorySection([{ text: 'm'.repeat(600) }]);

    expect(history[0].content).toHaveLength(1600);
    expect(history[0].content.endsWith('...')).toBe(true);
    expect(memory).toContain('...');
  });
});
