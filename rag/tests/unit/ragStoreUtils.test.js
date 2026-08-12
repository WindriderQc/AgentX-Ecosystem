const { splitIntoChunks, generateDocumentId, hashText, reciprocalRankFusion } = require('../../src/services/ragStoreUtils');

// ═══════════════════════════════════════════════════════════
// Existing tests (preserved)
// ═══════════════════════════════════════════════════════════

describe('splitIntoChunks', () => {
  it('does not emit a duplicate tail chunk when the last chunk reaches the end', () => {
    const chunks = splitIntoChunks('a'.repeat(1200), 500, 50);

    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.length)).toEqual([500, 500, 300]);
  });

  it('still returns at least one chunk for short text', () => {
    const chunks = splitIntoChunks('hello world', 500, 50);

    expect(chunks).toEqual(['hello world']);
  });
});

// ═══════════════════════════════════════════════════════════
// NEW — generateDocumentId
// ═══════════════════════════════════════════════════════════

describe('generateDocumentId', () => {
  it('is deterministic — same inputs produce same hash', () => {
    const id1 = generateDocumentId('api', '/docs/readme.md');
    const id2 = generateDocumentId('api', '/docs/readme.md');
    expect(id1).toBe(id2);
  });

  it('produces different hashes for different sources', () => {
    const id1 = generateDocumentId('api', '/docs/readme.md');
    const id2 = generateDocumentId('file', '/docs/readme.md');
    expect(id1).not.toBe(id2);
  });

  it('produces different hashes for different paths', () => {
    const id1 = generateDocumentId('api', '/docs/readme.md');
    const id2 = generateDocumentId('api', '/docs/changelog.md');
    expect(id1).not.toBe(id2);
  });

  it('returns a 32-character hex string (MD5)', () => {
    const id = generateDocumentId('test', '/path');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ═══════════════════════════════════════════════════════════
// NEW — hashText
// ═══════════════════════════════════════════════════════════

describe('hashText', () => {
  it('is deterministic — same text produces same hash', () => {
    const h1 = hashText('hello world');
    const h2 = hashText('hello world');
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different text', () => {
    const h1 = hashText('hello');
    const h2 = hashText('world');
    expect(h1).not.toBe(h2);
  });

  it('returns a 32-character hex string (MD5)', () => {
    const h = hashText('test content');
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });

  it('handles empty string', () => {
    const h = hashText('');
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ═══════════════════════════════════════════════════════════
// NEW — splitIntoChunks: sentence boundary
// ═══════════════════════════════════════════════════════════

describe('splitIntoChunks — sentence boundary', () => {
  it('prefers breaking at sentence boundaries (". ")', () => {
    // Build text where a sentence ends inside the chunk window
    const sentence1 = 'A'.repeat(300) + '. ';   // 302 chars
    const sentence2 = 'B'.repeat(300);           // 300 chars
    const text = sentence1 + sentence2;          // 602 chars total

    const chunks = splitIntoChunks(text, 500, 50);

    // The first chunk should break at the ". " at position 301 (end of sentence1),
    // because 301 > start(0) and 301 > 0 + 500 * 0.5 = 250
    expect(chunks[0]).toMatch(/A+\.$/);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('does not break at sentence boundaries too early in the chunk', () => {
    // Sentence boundary at position 50 — too early (< 50% of 500 = 250)
    const text = 'A'.repeat(49) + '. ' + 'B'.repeat(500);

    const chunks = splitIntoChunks(text, 500, 50);

    // First chunk should be exactly 500 chars (no sentence break used)
    expect(chunks[0].length).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════
// NEW — splitIntoChunks: MAX_CHUNKS limit
// ═══════════════════════════════════════════════════════════

describe('splitIntoChunks — MAX_CHUNKS limit', () => {
  it('stops at 10,000 chunks even if text has more', () => {
    // With chunkSize=100, overlap=0: minAdvance=max(50,10)=50, overlap=min(0,50)=0
    // nextStart = end - 0 = end, so each step advances by 100.
    // 1,000,100 chars / 100 = 10,001 chunks without the limit.
    const text = 'x'.repeat(1_000_100);
    const chunks = splitIntoChunks(text, 100, 0);

    expect(chunks.length).toBe(10_000);
  });
});

// ═══════════════════════════════════════════════════════════
// NEW — splitIntoChunks: edge cases
// ═══════════════════════════════════════════════════════════

describe('splitIntoChunks — edge cases', () => {
  it('returns empty array for empty string', () => {
    const chunks = splitIntoChunks('', 500, 50);
    expect(chunks).toEqual([]);
  });

  it('handles a single character', () => {
    const chunks = splitIntoChunks('x', 500, 50);
    expect(chunks).toEqual(['x']);
  });

  it('handles text shorter than chunkSize', () => {
    const chunks = splitIntoChunks('short text', 500, 50);
    expect(chunks).toEqual(['short text']);
  });

  it('handles text exactly equal to chunkSize', () => {
    const text = 'a'.repeat(500);
    const chunks = splitIntoChunks(text, 500, 50);
    expect(chunks).toEqual([text]);
  });

  it('throws for non-string text', () => {
    expect(() => splitIntoChunks(42, 500, 50)).toThrow('text must be a string');
    expect(() => splitIntoChunks(null, 500, 50)).toThrow('text must be a string');
  });

  it('throws for invalid chunkSize', () => {
    expect(() => splitIntoChunks('hello', 0, 0)).toThrow('chunkSize must be a positive number');
    expect(() => splitIntoChunks('hello', -1, 0)).toThrow('chunkSize must be a positive number');
  });

  it('throws for negative chunkOverlap', () => {
    expect(() => splitIntoChunks('hello', 500, -1)).toThrow('chunkOverlap must be a non-negative number');
  });

  it('throws when chunkOverlap >= chunkSize', () => {
    expect(() => splitIntoChunks('hello', 100, 100)).toThrow('chunkOverlap (100) must be less than chunkSize (100)');
    expect(() => splitIntoChunks('hello', 100, 200)).toThrow('chunkOverlap (200) must be less than chunkSize (100)');
  });

  it('handles zero overlap correctly', () => {
    const text = 'a'.repeat(1000);
    const chunks = splitIntoChunks(text, 500, 0);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBe(500);
    expect(chunks[1].length).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════
// Reciprocal Rank Fusion (RRF)
// ═══════════════════════════════════════════════════════════

describe('reciprocalRankFusion', () => {
  const mkResult = (docId, chunkIndex, text = 'text') => ({
    text,
    score: 0.9,
    metadata: { documentId: docId, chunkIndex }
  });

  it('merges two non-overlapping lists', () => {
    const list1 = [mkResult('a', 0), mkResult('b', 0)];
    const list2 = [mkResult('c', 0), mkResult('d', 0)];

    const fused = reciprocalRankFusion(list1, list2);
    expect(fused).toHaveLength(4);
    // All items should have rrfScore
    expect(fused.every(r => typeof r.rrfScore === 'number')).toBe(true);
  });

  it('boosts items appearing in both lists', () => {
    const shared = mkResult('shared', 0, 'shared item');
    const onlyInList1 = mkResult('only1', 0, 'only in list 1');
    const onlyInList2 = mkResult('only2', 0, 'only in list 2');

    // shared appears at rank 0 in both lists
    const list1 = [shared, onlyInList1];
    const list2 = [shared, onlyInList2];

    const fused = reciprocalRankFusion(list1, list2);

    // Shared item should be first (boosted by appearing in both)
    expect(fused[0].metadata.documentId).toBe('shared');
    expect(fused[0].rrfScore).toBeGreaterThan(fused[1].rrfScore);
  });

  it('higher-ranked items get higher scores', () => {
    const list1 = [mkResult('first', 0), mkResult('second', 0), mkResult('third', 0)];

    const fused = reciprocalRankFusion(list1, []);
    expect(fused[0].rrfScore).toBeGreaterThan(fused[1].rrfScore);
    expect(fused[1].rrfScore).toBeGreaterThan(fused[2].rrfScore);
  });

  it('handles empty lists gracefully', () => {
    expect(reciprocalRankFusion([], [])).toEqual([]);
    expect(reciprocalRankFusion([mkResult('a', 0)], [])).toHaveLength(1);
    expect(reciprocalRankFusion([], [mkResult('a', 0)])).toHaveLength(1);
  });

  it('uses k=60 constant by default', () => {
    const list1 = [mkResult('a', 0)];
    const fused = reciprocalRankFusion(list1, []);

    // Score for rank 0 with k=60: 1 / (60 + 0 + 1) = 1/61
    const expected = 1 / (60 + 0 + 1);
    expect(fused[0].rrfScore).toBeCloseTo(expected, 10);
  });

  it('supports custom k parameter', () => {
    const list1 = [mkResult('a', 0)];
    const fused = reciprocalRankFusion(list1, [], 10);

    // Score for rank 0 with k=10: 1 / (10 + 0 + 1) = 1/11
    const expected = 1 / (10 + 0 + 1);
    expect(fused[0].rrfScore).toBeCloseTo(expected, 10);
  });

  it('deduplicates by documentId:chunkIndex key', () => {
    // Same document/chunk in both lists at different ranks
    const list1 = [mkResult('doc1', 0), mkResult('doc1', 1)];
    const list2 = [mkResult('doc1', 1), mkResult('doc1', 0)];

    const fused = reciprocalRankFusion(list1, list2);

    // Should have exactly 2 unique items (doc1:0 and doc1:1)
    expect(fused).toHaveLength(2);
    const keys = fused.map(r => `${r.metadata.documentId}:${r.metadata.chunkIndex}`);
    expect(new Set(keys).size).toBe(2);
  });

  it('preserves original item fields alongside rrfScore', () => {
    const list1 = [mkResult('a', 0, 'hello world')];
    const fused = reciprocalRankFusion(list1, []);

    expect(fused[0].text).toBe('hello world');
    expect(fused[0].metadata.documentId).toBe('a');
    expect(fused[0].metadata.chunkIndex).toBe(0);
    expect(fused[0]).toHaveProperty('rrfScore');
  });
});
