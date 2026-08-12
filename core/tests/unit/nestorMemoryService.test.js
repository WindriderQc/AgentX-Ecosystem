const {
  assertMemoryText,
  saveMemory,
  stableDocumentId,
} = require('../../src/services/nestorMemoryService');

function fakeSecretLikeText() {
  return ['OPENAI_API_KEY=', 'sk', '-', 'abcdefghijklmnopqrstuvwxyz'].join('');
}

describe('nestorMemoryService', () => {
  test('refuses secret-like memory text', () => {
    expect(() => assertMemoryText(fakeSecretLikeText())).toThrow(/secret-like/);
  });

  test('uses stable document IDs for identical memory content', () => {
    const a = stableDocumentId({ type: 'fact', agent: 'nestor', topic: 'hosts', text: 'Host Alpha is primary.' });
    const b = stableDocumentId({ type: 'fact', agent: 'nestor', topic: 'hosts', text: 'Host Alpha is primary.' });
    expect(a).toBe(b);
    expect(a).toMatch(/^nestor-memory:/);
  });

  test('re-ingesting the same memory targets the same RAG document', async () => {
    const ragClient = {
      upsertDocumentWithChunks: jest.fn(async (_text, meta) => ({ documentId: meta.documentId, chunkCount: 1 })),
    };
    const input = {
      type: 'fact',
      topic: 'hosts',
      text: 'Host Alpha is the primary/masterbrain Ollama host.',
    };

    const first = await saveMemory(input, { ragClient });
    const second = await saveMemory(input, { ragClient });

    expect(first.documentId).toBe(second.documentId);
    expect(ragClient.upsertDocumentWithChunks).toHaveBeenCalledTimes(2);
  });

  test('ingests memory through the RAG client with source nestor-memory', async () => {
    const ragClient = {
      upsertDocumentWithChunks: jest.fn(async () => ({ documentId: 'nestor-memory:test', chunkCount: 1 })),
    };
    const result = await saveMemory({
      id: 'test',
      type: 'summary',
      topic: 'ops',
      text: 'Network scanner is now durable on host-beta.',
    }, { ragClient });

    expect(result.saved).toBe(true);
    expect(result.source).toBe('nestor-memory');
    expect(result.documentId).toBe('nestor-memory:test');
    expect(ragClient.upsertDocumentWithChunks).toHaveBeenCalledWith(
      expect.stringContaining('Network scanner is now durable'),
      expect.objectContaining({
        source: 'nestor-memory',
        documentId: 'nestor-memory:test',
        timeoutMs: expect.any(Number),
        tags: expect.arrayContaining(['nestor-memory', 'type:summary', 'topic:ops']),
      })
    );
  });
});
