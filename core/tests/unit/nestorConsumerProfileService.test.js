'use strict';

const mockFindOne = jest.fn();

jest.mock('../../models/Buddy', () => ({
  findOne: (...args) => mockFindOne(...args),
}));

jest.mock('../../src/services/buddyNotesFile', () => ({
  resolveNotesPath: jest.fn(() => 'C:/legacy/BUDDY.md'),
  assertSafeNotesReadPath: jest.fn(async () => ({
    size: 1,
    isFile: () => true,
  })),
  _parseFile: (...args) => jest.requireActual('../../src/services/buddyNotesFile')._parseFile(...args),
}));

const fs = require('fs');
const {
  exportLegacyProfile,
  exportLegacyProfileV1,
  getMigrationNotesPage,
  _snapshotCache,
} = require('../../src/services/nestorConsumerProfileService');
const { LIMITS } = require('../../src/services/nestorConsumerContract');

function queryResult(value) {
  return { lean: jest.fn().mockResolvedValue(value) };
}

function sourceBuddy(overrides = {}) {
  return {
    _id: 'legacy-id',
    seed: 'global',
    version: 2,
    v1Origin: { importedAt: '2025-01-01T00:00:00Z', source: 'v1' },
    name: 'Nestor',
    species: 'owl',
    pickedSpriteId: 'owl-gold',
    soul: 'legacy soul',
    personality: { source: 'openclaw', agentId: 'main' },
    memory: { sources: ['agentx'], k: 5 },
    model: { host: 'http://ollama', model: 'legacy-model' },
    brain: { defaults: { host: '', model: '' } },
    mood: 'happy',
    stats: { WISDOM: 75 },
    moodHistory: Array.from({ length: 1005 }, (_, index) => ({ type: `e${index}` })),
    milestones: Array.from({ length: 205 }, (_, index) => ({ id: `m${index}` })),
    totalReactions: 12,
    totalPets: 4,
    modelsUsed: Array.from({ length: 205 }, (_, index) => `model-${index}`),
    facts: Array.from({ length: 205 }, (_, index) => ({
      text: `mongo fact ${index}`,
      addedAt: '2026-01-01T00:00:00Z',
    })),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-07-17T00:00:00Z',
    ...overrides,
  };
}

function notesFile(extra = '') {
  return Buffer.from(`---\nbuddy_notes_version: 1\nfacts:\n  - text: active file fact\n    addedAt: 2026-02-01T00:00:00Z\n  - text: forgotten file fact\n    addedAt: 2026-01-01T00:00:00Z\n    forgottenAt: 2026-03-01T00:00:00Z\n---\n\n## Notes (manual)\n\nRemember the owl. 🦉${extra}`, 'utf8');
}

describe('Nestor legacy profile export', () => {
  let readFileSpy;
  let statSpy;
  let writeFileSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    _snapshotCache.clear();
    statSpy = jest.spyOn(fs.promises, 'stat').mockResolvedValue({
      size: notesFile().length,
      isFile: () => true,
    });
    readFileSpy = jest.spyOn(fs.promises, 'readFile').mockResolvedValue(notesFile());
    writeFileSpy = jest.spyOn(fs.promises, 'writeFile');
  });

  afterEach(() => {
    readFileSpy.mockRestore();
    statSpy.mockRestore();
    writeFileSpy.mockRestore();
  });

  it('exports a complete schema-2 source snapshot without truncating structured arrays or facts', async () => {
    const buddy = sourceBuddy();
    mockFindOne.mockReturnValue(queryResult(buddy));

    const result = await exportLegacyProfile({ includeRawNotes: true });

    expect(result).toEqual(expect.objectContaining({
      schemaVersion: 2,
      contractVersion: '1.1.0',
      authority: 'legacy-migration-only',
      readOnly: true,
      snapshotId: expect.stringMatching(/^[a-f0-9]{64}$/),
      completeness: { complete: true, omissions: [] },
    }));
    expect(result.source).toEqual(expect.objectContaining({
      collection: 'buddies',
      documentId: 'legacy-id',
      profileSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(result.sourceDocument).toEqual(buddy);
    expect(result.identity.pickedSpriteId).toBe('owl-gold');
    expect(result.v1Origin).toEqual(buddy.v1Origin);
    expect(result.legacyModel).toEqual(buddy.model);
    expect(result.progression.moodHistory).toHaveLength(1005);
    expect(result.progression.milestones).toHaveLength(205);
    expect(result.progression.modelsUsed).toHaveLength(205);
    expect(result.facts.legacyMongo).toHaveLength(205);
    expect(result.facts.notesFile).toHaveLength(2);
    expect(result.facts.totalCount).toBe(207);
    expect(result.notes).toEqual(expect.objectContaining({
      exists: true,
      byteLength: notesFile().length,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      manual: expect.objectContaining({ present: true, byteLength: expect.any(Number) }),
      rawArchive: {
        endpoint: '/api/consumers/nestor/v1/migration/notes',
        encoding: 'base64',
        byteLength: notesFile().length,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        chunkBytes: 1048576,
      },
      rawIncluded: true,
      rawTruncated: false,
    }));
    expect(mockFindOne).toHaveBeenCalledWith({ seed: 'global' });
    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  it('preserves the released schema-1 migration projection for unnegotiated clients', async () => {
    mockFindOne.mockReturnValue(queryResult(sourceBuddy()));

    const result = await exportLegacyProfileV1({ includeRawNotes: true });

    expect(result).toEqual(expect.objectContaining({
      schemaVersion: 1,
      authority: 'legacy-migration-only',
      readOnly: true,
      identity: expect.objectContaining({ name: 'Nestor' }),
      facts: expect.objectContaining({
        active: expect.any(Array),
        forgotten: expect.any(Array),
        legacyMongoCount: expect.any(Number),
      }),
      notes: expect.objectContaining({ rawIncluded: true }),
    }));
    expect(result).not.toHaveProperty('snapshotId');
    expect(_snapshotCache.size).toBe(0);
  });

  it('keeps the includeRawNotes compatibility preview bounded', async () => {
    mockFindOne.mockReturnValue(queryResult(sourceBuddy()));
    readFileSpy.mockResolvedValue(Buffer.from('n'.repeat(70000), 'utf8'));

    const result = await exportLegacyProfile({ includeRawNotes: true });

    expect(result.notes.raw).toHaveLength(65536);
    expect(result.notes.rawTruncated).toBe(true);
    expect(result.notes.rawArchive.byteLength).toBe(70000);
  });

  it('pages exact note bytes as base64 without splitting or corrupting multibyte content', async () => {
    mockFindOne.mockReturnValue(queryResult(sourceBuddy()));
    const expected = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      notesFile(' second owl 🦉'),
    ]);
    statSpy.mockResolvedValue({ size: expected.length, isFile: () => true });
    readFileSpy.mockResolvedValue(expected);
    const profile = await exportLegacyProfile();

    const chunks = [];
    let offset = 0;
    do {
      const page = await getMigrationNotesPage({ snapshotId: profile.snapshotId, offset, limit: 3 });
      chunks.push(Buffer.from(page.data, 'base64'));
      offset = page.nextOffset;
      if (page.complete) break;
    } while (offset <= expected.length);

    expect(Buffer.concat(chunks)).toEqual(expected);
    expect(offset).toBe(expected.length);
    expect(typeof offset).toBe('number');
  });

  it('serves the original immutable bytes while a snapshot lease is valid', async () => {
    mockFindOne
      .mockReturnValueOnce(queryResult(sourceBuddy()))
      .mockReturnValueOnce(queryResult(sourceBuddy({ mood: 'curious' })));
    const original = notesFile(' original');
    readFileSpy
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(notesFile(' changed'));
    const profile = await exportLegacyProfile();

    const page = await getMigrationNotesPage({ snapshotId: profile.snapshotId });

    expect(Buffer.from(page.data, 'base64')).toEqual(original);
    expect(mockFindOne).toHaveBeenCalledTimes(1);
    expect(readFileSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects an old snapshot after its lease is gone and the profile changed', async () => {
    mockFindOne
      .mockReturnValueOnce(queryResult(sourceBuddy()))
      .mockReturnValueOnce(queryResult(sourceBuddy({ mood: 'curious' })));
    const profile = await exportLegacyProfile();
    _snapshotCache.clear();

    await expect(getMigrationNotesPage({ snapshotId: profile.snapshotId })).rejects.toEqual(expect.objectContaining({
      statusCode: 409,
      code: 'NESTOR_MIGRATION_SOURCE_CHANGED',
    }));
  });

  it('rejects an old snapshot after its lease is gone and the notes bytes changed', async () => {
    mockFindOne.mockReturnValue(queryResult(sourceBuddy()));
    readFileSpy
      .mockResolvedValueOnce(notesFile(' first'))
      .mockResolvedValueOnce(notesFile(' changed'));
    const profile = await exportLegacyProfile();
    _snapshotCache.clear();

    await expect(getMigrationNotesPage({ snapshotId: profile.snapshotId })).rejects.toEqual(expect.objectContaining({
      statusCode: 409,
      code: 'NESTOR_MIGRATION_SOURCE_CHANGED',
    }));
  });

  it('rejects an invalid snapshot ID before MongoDB or filesystem access', async () => {
    await expect(getMigrationNotesPage({ snapshotId: '../not-a-snapshot' })).rejects.toEqual(expect.objectContaining({
      statusCode: 400,
      code: 'NESTOR_MIGRATION_INVALID_SNAPSHOT_ID',
    }));

    expect(mockFindOne).not.toHaveBeenCalled();
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('marks oversized notes incomplete, does not cache them, and rejects paging', async () => {
    mockFindOne.mockReturnValue(queryResult(sourceBuddy()));
    statSpy.mockResolvedValue({
      size: LIMITS.migrationNotesMaxBytes + 1,
      isFile: () => true,
    });

    const profile = await exportLegacyProfile();

    expect(profile.completeness).toEqual({
      complete: false,
      omissions: [`notes archive exceeds ${LIMITS.migrationNotesMaxBytes} bytes`],
    });
    expect(profile.notes).toEqual(expect.objectContaining({
      exists: true,
      byteLength: LIMITS.migrationNotesMaxBytes + 1,
      sha256: null,
      rawIncluded: false,
    }));
    expect(_snapshotCache.has(profile.snapshotId)).toBe(false);
    expect(readFileSpy).not.toHaveBeenCalled();

    await expect(getMigrationNotesPage({ snapshotId: profile.snapshotId })).rejects.toEqual(expect.objectContaining({
      statusCode: 413,
      code: 'NESTOR_MIGRATION_NOTES_TOO_LARGE',
      details: {
        byteLength: LIMITS.migrationNotesMaxBytes + 1,
        maximumByteLength: LIMITS.migrationNotesMaxBytes,
      },
    }));
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('does not evict a live lease when snapshot capacity is exhausted', async () => {
    mockFindOne
      .mockReturnValueOnce(queryResult(sourceBuddy({ mood: 'happy' })))
      .mockReturnValueOnce(queryResult(sourceBuddy({ mood: 'curious' })))
      .mockReturnValueOnce(queryResult(sourceBuddy({ mood: 'sleepy' })));
    const first = await exportLegacyProfile();
    await exportLegacyProfile();

    await expect(exportLegacyProfile()).rejects.toEqual(expect.objectContaining({
      statusCode: 503,
      code: 'NESTOR_MIGRATION_SNAPSHOT_CAPACITY',
    }));
    expect(_snapshotCache.size).toBe(2);
    await expect(getMigrationNotesPage({ snapshotId: first.snapshotId }))
      .resolves.toEqual(expect.objectContaining({ snapshotId: first.snapshotId }));
  });

  it('caches a validated current snapshot when paging resumes after lease loss', async () => {
    mockFindOne.mockReturnValue(queryResult(sourceBuddy()));
    const profile = await exportLegacyProfile();
    _snapshotCache.clear();

    await getMigrationNotesPage({ snapshotId: profile.snapshotId, offset: 0, limit: 10 });
    await getMigrationNotesPage({ snapshotId: profile.snapshotId, offset: 10, limit: 10 });

    expect(readFileSpy).toHaveBeenCalledTimes(2);
    expect(mockFindOne).toHaveBeenCalledTimes(2);
  });

  it('exports Mongo data as incomplete when notes are unreadable and rejects paging', async () => {
    mockFindOne.mockReturnValue(queryResult(sourceBuddy()));
    statSpy.mockRejectedValue(Object.assign(new Error('access denied'), { code: 'EACCES' }));

    const profile = await exportLegacyProfile();

    expect(profile.sourceDocument).toEqual(expect.objectContaining({ _id: 'legacy-id' }));
    expect(profile.completeness.complete).toBe(false);
    expect(profile.notes).toEqual(expect.objectContaining({
      exists: true,
      sha256: null,
      warning: 'access denied',
    }));
    await expect(getMigrationNotesPage({ snapshotId: profile.snapshotId })).rejects.toEqual(
      expect.objectContaining({ statusCode: 422, code: 'NESTOR_MIGRATION_NOTES_UNAVAILABLE' }),
    );
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('marks malformed notes frontmatter as an explicit completeness omission', async () => {
    mockFindOne.mockReturnValue(queryResult(sourceBuddy()));
    const malformed = Buffer.from('---\nfacts: [unterminated\n---\n\nManual survives.', 'utf8');
    statSpy.mockResolvedValue({ size: malformed.length, isFile: () => true });
    readFileSpy.mockResolvedValue(malformed);

    const profile = await exportLegacyProfile();

    expect(profile.completeness).toEqual({
      complete: false,
      omissions: ['notes frontmatter could not be parsed'],
    });
    expect(profile.notes.warning).toContain('malformed frontmatter');
    expect(profile.facts.notesFile).toEqual([]);
  });

  it('does not create a singleton when no legacy profile exists', async () => {
    mockFindOne.mockReturnValue(queryResult(null));
    statSpy.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const result = await exportLegacyProfile();
    expect(result.exists).toBe(false);
    expect(result.schemaVersion).toBe(2);
    expect(result.sourceDocument).toBeNull();
    expect(result.notes.exists).toBe(false);
    expect(result.notes.rawArchive.byteLength).toBe(0);
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('exports orphaned standalone notes when the Mongo singleton is missing', async () => {
    mockFindOne.mockReturnValue(queryResult(null));
    const result = await exportLegacyProfile();

    expect(result).toMatchObject({
      exists: true,
      sourceDocument: null,
      notes: { exists: true },
      facts: {
        active: [expect.objectContaining({ text: 'active file fact', origin: 'notes-file' })],
      },
    });
  });
});
