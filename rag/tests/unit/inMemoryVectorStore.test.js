const InMemoryVectorStore = require('../../src/services/vectorStore/InMemoryVectorStore');

describe('InMemoryVectorStore', () => {
  let store;

  beforeEach(() => {
    store = new InMemoryVectorStore();
  });

  test('upsert and list documents', async () => {
    await store.upsertDocument('doc1', { source: 'test', tags: ['a'] }, [
      { text: 'hello world', embedding: [1, 0, 0], chunkIndex: 0 }
    ]);

    const { documents: docs, total } = await store.listDocuments();
    expect(docs).toHaveLength(1);
    expect(total).toBe(1);
    expect(docs[0].documentId).toBe('doc1');
    expect(docs[0].source).toBe('test');
    expect(docs[0].chunkCount).toBe(1);
  });

  test('upsert replaces existing document', async () => {
    await store.upsertDocument('doc1', { source: 'test' }, [
      { text: 'v1', embedding: [1, 0, 0], chunkIndex: 0 }
    ]);
    const r = await store.upsertDocument('doc1', { source: 'test' }, [
      { text: 'v2 chunk1', embedding: [1, 0, 0], chunkIndex: 0 },
      { text: 'v2 chunk2', embedding: [0, 1, 0], chunkIndex: 1 }
    ]);

    expect(r.status).toBe('updated');
    expect(r.chunkCount).toBe(2);

    const { documents: docs, total } = await store.listDocuments();
    expect(docs).toHaveLength(1);
    expect(total).toBe(1);
    expect(docs[0].chunkCount).toBe(2);
  });

  test('search returns scored results', async () => {
    await store.upsertDocument('doc1', { source: 'test' }, [
      { text: 'relevant', embedding: [1, 0, 0], chunkIndex: 0 },
      { text: 'less relevant', embedding: [0, 1, 0], chunkIndex: 1 }
    ]);

    const results = await store.searchSimilar([1, 0, 0], { topK: 2 });
    expect(results).toHaveLength(2);
    expect(results[0].score).toBeCloseTo(1.0);
    expect(results[0].text).toBe('relevant');
    expect(results[1].score).toBeCloseTo(0.0);
  });

  test('search respects minScore filter', async () => {
    await store.upsertDocument('doc1', { source: 'test' }, [
      { text: 'match', embedding: [1, 0, 0], chunkIndex: 0 },
      { text: 'no match', embedding: [0, 1, 0], chunkIndex: 1 }
    ]);

    const results = await store.searchSimilar([1, 0, 0], { topK: 10, minScore: 0.5 });
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('match');
  });

  test('search respects source filter', async () => {
    await store.upsertDocument('doc1', { source: 'alpha' }, [
      { text: 'from alpha', embedding: [1, 0, 0], chunkIndex: 0 }
    ]);
    await store.upsertDocument('doc2', { source: 'beta' }, [
      { text: 'from beta', embedding: [1, 0, 0], chunkIndex: 0 }
    ]);

    const results = await store.searchSimilar([1, 0, 0], { filters: { source: 'alpha' } });
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('from alpha');
  });

  test('delete removes document and vectors', async () => {
    await store.upsertDocument('doc1', { source: 'test' }, [
      { text: 'chunk', embedding: [1, 0, 0], chunkIndex: 0 }
    ]);

    const deleted = await store.deleteDocument('doc1');
    expect(deleted).toBe(true);

    const { documents: docs } = await store.listDocuments();
    expect(docs).toHaveLength(0);

    const results = await store.searchSimilar([1, 0, 0]);
    expect(results).toHaveLength(0);
  });

  test('delete non-existent document returns false', async () => {
    const deleted = await store.deleteDocument('nope');
    expect(deleted).toBe(false);
  });

  test('getDocument returns doc or null', async () => {
    await store.upsertDocument('doc1', { source: 'test' }, [
      { text: 'hi', embedding: [1, 0, 0], chunkIndex: 0 }
    ]);

    const doc = await store.getDocument('doc1');
    expect(doc).not.toBeNull();
    expect(doc.documentId).toBe('doc1');

    const missing = await store.getDocument('nope');
    expect(missing).toBeNull();
  });

  test('getDocumentChunks returns ordered chunks', async () => {
    await store.upsertDocument('doc1', { source: 'test' }, [
      { text: 'second', embedding: [0, 1, 0], chunkIndex: 1 },
      { text: 'first', embedding: [1, 0, 0], chunkIndex: 0 }
    ]);

    const chunks = await store.getDocumentChunks('doc1');
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe('first');
    expect(chunks[1].text).toBe('second');
  });

  test('getStats returns counts and dimension', async () => {
    await store.upsertDocument('doc1', { source: 'test' }, [
      { text: 'a', embedding: [1, 0, 0], chunkIndex: 0 },
      { text: 'b', embedding: [0, 1, 0], chunkIndex: 1 }
    ]);

    const stats = await store.getStats();
    expect(stats.documentCount).toBe(1);
    expect(stats.chunkCount).toBe(2);
    expect(stats.vectorDimension).toBe(3);
  });

  test('healthCheck returns healthy', async () => {
    const h = await store.healthCheck();
    expect(h.healthy).toBe(true);
    expect(h.type).toBe('memory');
  });

  test('listDocuments supports limit and offset pagination', async () => {
    for (let i = 1; i <= 5; i++) {
      await store.upsertDocument(`doc${i}`, { source: 'test', tags: [] }, [
        { text: `chunk ${i}`, embedding: [1, 0, 0], chunkIndex: 0 }
      ]);
    }

    // First page: limit 2, offset 0
    const page1 = await store.listDocuments({}, { limit: 2, offset: 0 });
    expect(page1.documents).toHaveLength(2);
    expect(page1.total).toBe(5);

    // Second page: limit 2, offset 2
    const page2 = await store.listDocuments({}, { limit: 2, offset: 2 });
    expect(page2.documents).toHaveLength(2);
    expect(page2.total).toBe(5);

    // Last page: limit 2, offset 4
    const page3 = await store.listDocuments({}, { limit: 2, offset: 4 });
    expect(page3.documents).toHaveLength(1);
    expect(page3.total).toBe(5);

    // Beyond range: offset past total
    const empty = await store.listDocuments({}, { limit: 2, offset: 10 });
    expect(empty.documents).toHaveLength(0);
    expect(empty.total).toBe(5);
  });

  test('listDocuments without pagination returns all documents', async () => {
    for (let i = 1; i <= 3; i++) {
      await store.upsertDocument(`doc${i}`, { source: 'test', tags: [] }, [
        { text: `chunk ${i}`, embedding: [1, 0, 0], chunkIndex: 0 }
      ]);
    }

    const result = await store.listDocuments();
    expect(result.documents).toHaveLength(3);
    expect(result.total).toBe(3);
  });

  describe('originalText get/set (0163)', () => {
    test('set-then-get roundtrip preserves non-ASCII + newlines', async () => {
      const text = 'hello\nworld — é';
      await store.setDocumentOriginalText('doc1', text);
      const got = await store.getDocumentOriginalText('doc1');
      expect(got).toBe(text);
    });

    test('get on never-set document returns null (not undefined)', async () => {
      const got = await store.getDocumentOriginalText('never-set');
      expect(got).toBeNull();
      // Explicitly ensure it is not undefined
      expect(got === undefined).toBe(false);
    });

    test('set overwrites an existing value', async () => {
      await store.setDocumentOriginalText('doc1', 'first');
      await store.setDocumentOriginalText('doc1', 'second');
      const got = await store.getDocumentOriginalText('doc1');
      expect(got).toBe('second');
    });

    test('set before upsert creates a minimal doc entry, get returns the text', async () => {
      await store.setDocumentOriginalText('orphan', 'stand-alone body');
      const got = await store.getDocumentOriginalText('orphan');
      expect(got).toBe('stand-alone body');
    });

    test('set preserves unrelated doc fields after upsert', async () => {
      await store.upsertDocument('doc1', { source: 'test', tags: ['a'] }, [
        { text: 'chunk', embedding: [1, 0, 0], chunkIndex: 0 }
      ]);
      await store.setDocumentOriginalText('doc1', 'full text');

      const doc = await store.getDocument('doc1');
      expect(doc.source).toBe('test');
      expect(doc.tags).toEqual(['a']);

      const got = await store.getDocumentOriginalText('doc1');
      expect(got).toBe('full text');
    });
  });

  test('list documents with tag filter', async () => {
    await store.upsertDocument('doc1', { source: 'test', tags: ['api', 'docs'] }, [
      { text: 'a', embedding: [1, 0, 0], chunkIndex: 0 }
    ]);
    await store.upsertDocument('doc2', { source: 'test', tags: ['code'] }, [
      { text: 'b', embedding: [0, 1, 0], chunkIndex: 0 }
    ]);

    const { documents: filtered, total } = await store.listDocuments({ tags: ['api'] });
    expect(filtered).toHaveLength(1);
    expect(total).toBe(1);
    expect(filtered[0].documentId).toBe('doc1');
  });
});
