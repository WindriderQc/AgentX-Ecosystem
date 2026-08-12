'use strict';

const crypto = require('crypto');
const fs = require('fs').promises;
const Buddy = require('../../models/Buddy');
const buddyNotesFile = require('./buddyNotesFile');
const {
  CONTRACT_BASE_PATH,
  CONTRACT_VERSION,
  LIMITS,
  NestorConsumerError,
} = require('./nestorConsumerContract');

const SINGLETON_SEED = 'global';
const PROFILE_SCHEMA = 'agentx.nestor.legacy-profile-export';
const PROFILE_SCHEMA_VERSION = 2;
const SNAPSHOT_DOMAIN = 'agentx.nestor.migration-snapshot.v2';
const EMPTY_SHA256 = sha256(Buffer.alloc(0));
const SNAPSHOT_ID_PATTERN = /^[a-f0-9]{64}$/;
const SNAPSHOT_LEASE_MS = 10 * 60 * 1000;
const SNAPSHOT_CACHE_ENTRIES = 2;
const snapshotCache = new Map();

function plain(value) {
  if (!value) return value;
  return typeof value.toObject === 'function' ? value.toObject() : value;
}

function jsonSafe(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function textMetadata(value) {
  const text = String(value == null ? '' : value);
  const bytes = Buffer.from(text, 'utf8');
  return {
    present: bytes.length > 0,
    characterLength: text.length,
    byteLength: bytes.length,
    sha256: sha256(bytes),
  };
}

function rawFact(fact, origin) {
  const raw = jsonSafe(plain(fact));
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { value: raw };
  return { ...value, origin };
}

function structuredFact(fact) {
  if (!fact || typeof fact.text !== 'string' || !fact.text.trim()) return null;
  return {
    text: fact.text,
    weight: Number.isFinite(Number(fact.weight)) ? Number(fact.weight) : 1,
    tags: Array.isArray(fact.tags) ? fact.tags.map(String) : [],
    addedAt: fact.addedAt || null,
    forgottenAt: fact.forgottenAt || null,
    origin: fact.origin,
  };
}

function exportFacts(fileFacts, mongoFacts) {
  const notesFile = (Array.isArray(fileFacts) ? fileFacts : []).map((fact) => rawFact(fact, 'notes-file'));
  const legacyMongo = (Array.isArray(mongoFacts) ? mongoFacts : []).map((fact) => rawFact(fact, 'legacy-mongo'));
  const all = [...notesFile, ...legacyMongo].map(structuredFact).filter(Boolean);
  return {
    active: all.filter((fact) => !fact.forgottenAt),
    forgotten: all.filter((fact) => Boolean(fact.forgottenAt)),
    notesFile,
    legacyMongo,
    notesFileCount: notesFile.length,
    legacyMongoCount: legacyMongo.length,
    totalCount: all.length,
  };
}

function notesSnapshotId(profileSha256, factsSha256, notes) {
  const material = [
    SNAPSHOT_DOMAIN,
    profileSha256,
    factsSha256,
    notes.file || '',
    notes.exists ? 'present' : 'absent',
    String(notes.byteLength),
    notes.sha256 || '',
  ].join('\0');
  return sha256(Buffer.from(material, 'utf8'));
}

async function findSourceDocument() {
  const query = Buddy.findOne({ seed: SINGLETON_SEED });
  const buddy = plain(query && typeof query.lean === 'function' ? await query.lean() : await query);
  return buddy ? jsonSafe(buddy) : null;
}

async function readNotesSnapshot(sourceDocument) {
  let file;
  try {
    file = buddyNotesFile.resolveNotesPath(sourceDocument);
  } catch (error) {
    return {
      file: null,
      exists: false,
      buffer: null,
      byteLength: 0,
      sha256: null,
      fileFacts: [],
      manual: '',
      unavailable: true,
      warning: error.message,
      omission: 'notes file path could not be resolved',
    };
  }

  let fileStat;
  try {
    fileStat = await fs.stat(file);
    await buddyNotesFile.assertSafeNotesReadPath(sourceDocument, file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        file,
        exists: false,
        buffer: Buffer.alloc(0),
        byteLength: 0,
        sha256: EMPTY_SHA256,
        fileFacts: [],
        manual: '',
      };
    }
    return {
      file,
      exists: true,
      buffer: null,
      byteLength: 0,
      sha256: null,
      fileFacts: [],
      manual: '',
      unavailable: true,
      warning: error.message,
      omission: `notes archive could not be safely inspected: ${error.code || error.message || 'unknown error'}`,
    };
  }
  if (!fileStat.isFile()) {
    return {
      file,
      exists: true,
      buffer: null,
      byteLength: Number(fileStat.size) || 0,
      sha256: null,
      fileFacts: [],
      manual: '',
      unavailable: true,
      warning: 'resolved notes path is not a regular file',
      omission: 'notes archive is not a regular file',
    };
  }
  if (fileStat.size > LIMITS.migrationNotesMaxBytes) {
    return {
      file,
      exists: true,
      buffer: null,
      byteLength: fileStat.size,
      sha256: null,
      fileFacts: [],
      manual: '',
      oversized: true,
      omission: `notes archive exceeds ${LIMITS.migrationNotesMaxBytes} bytes`,
    };
  }

  try {
    const buffer = await fs.readFile(file);
    if (buffer.length > LIMITS.migrationNotesMaxBytes) {
      return {
        file,
        exists: true,
        buffer: null,
        byteLength: buffer.length,
        sha256: null,
        fileFacts: [],
        manual: '',
        oversized: true,
        omission: `notes archive exceeds ${LIMITS.migrationNotesMaxBytes} bytes`,
      };
    }
    const raw = buffer.toString('utf8');
    const parsed = buddyNotesFile._parseFile(raw);
    const fileFacts = parsed.fm && Array.isArray(parsed.fm.facts) ? jsonSafe(parsed.fm.facts) : [];
    return {
      file,
      exists: true,
      buffer,
      byteLength: buffer.length,
      sha256: sha256(buffer),
      fileFacts,
      manual: parsed.manual || '',
      ...(parsed.warning ? {
        warning: parsed.warning,
        omission: 'notes frontmatter could not be parsed',
      } : {}),
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        file,
        exists: false,
        buffer: Buffer.alloc(0),
        byteLength: 0,
        sha256: EMPTY_SHA256,
        fileFacts: [],
        manual: '',
      };
    }
    return {
      file,
      exists: true,
      buffer: null,
      byteLength: Number(fileStat.size) || 0,
      sha256: null,
      fileFacts: [],
      manual: '',
      unavailable: true,
      warning: error.message,
      omission: `notes archive could not be read: ${error.code || 'unknown error'}`,
    };
  }
}

async function loadMigrationSnapshot() {
  const sourceDocument = await findSourceDocument();
  const profileSha256 = sha256(Buffer.from(canonicalJson(sourceDocument), 'utf8'));
  const notes = await readNotesSnapshot(sourceDocument);
  const facts = exportFacts(notes.fileFacts, sourceDocument?.facts);
  const factsSha256 = sha256(Buffer.from(canonicalJson(facts), 'utf8'));
  return {
    sourceDocument,
    profileSha256,
    facts,
    factsSha256,
    notes,
    snapshotId: notesSnapshotId(profileSha256, factsSha256, notes),
  };
}

function cacheSnapshot(snapshot) {
  if (snapshot.notes.omission || snapshot.notes.oversized || snapshot.notes.unavailable) return;
  const now = Date.now();
  for (const [key, entry] of snapshotCache) {
    if (entry.expiresAt <= now) snapshotCache.delete(key);
  }
  if (!snapshotCache.has(snapshot.snapshotId) && snapshotCache.size >= SNAPSHOT_CACHE_ENTRIES) {
    throw new NestorConsumerError(
      'All immutable migration snapshot leases are currently in use; retry after a lease expires.',
      503,
      'NESTOR_MIGRATION_SNAPSHOT_CAPACITY',
      { maximumLeases: SNAPSHOT_CACHE_ENTRIES, leaseMilliseconds: SNAPSHOT_LEASE_MS }
    );
  }
  snapshotCache.delete(snapshot.snapshotId);
  snapshotCache.set(snapshot.snapshotId, {
    snapshot,
    expiresAt: now + SNAPSHOT_LEASE_MS,
  });
}

function leasedSnapshot(snapshotId) {
  const entry = snapshotCache.get(snapshotId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    snapshotCache.delete(snapshotId);
    return null;
  }
  return entry.snapshot;
}

function notesDescriptor(notes, includeRawNotes) {
  const descriptor = {
    file: notes.file,
    exists: notes.exists,
    byteLength: notes.byteLength,
    sha256: notes.sha256,
    manual: textMetadata(notes.manual),
    rawArchive: {
      endpoint: `${CONTRACT_BASE_PATH}/migration/notes`,
      encoding: 'base64',
      byteLength: notes.byteLength,
      sha256: notes.sha256,
      chunkBytes: LIMITS.migrationNotesChunkBytes,
    },
    rawIncluded: false,
    rawTruncated: false,
  };
  if (notes.warning) descriptor.warning = notes.warning;
  if (includeRawNotes && notes.exists && notes.buffer) {
    const raw = notes.buffer.toString('utf8');
    descriptor.raw = raw.slice(0, LIMITS.rawNotesCharacters);
    descriptor.rawIncluded = true;
    descriptor.rawTruncated = raw.length > LIMITS.rawNotesCharacters;
  }
  return descriptor;
}

async function exportLegacyProfile({ includeRawNotes = false, leaseSnapshot = true } = {}) {
  const snapshot = await loadMigrationSnapshot();
  if (leaseSnapshot) cacheSnapshot(snapshot);
  const {
    sourceDocument: buddy,
    profileSha256,
    facts,
    factsSha256,
    notes,
    snapshotId,
  } = snapshot;
  const exportedAt = new Date().toISOString();
  const omissions = [
    ...(notes.omission ? [notes.omission] : []),
  ];
  const base = {
    schema: PROFILE_SCHEMA,
    schemaVersion: PROFILE_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    exportedAt,
    snapshotId,
    authority: 'legacy-migration-only',
    readOnly: true,
    exists: Boolean(buddy || notes.exists),
    source: {
      collection: 'buddies',
      seed: buddy?.seed || SINGLETON_SEED,
      documentId: buddy?._id ? String(buddy._id) : null,
      createdAt: buddy?.createdAt || null,
      updatedAt: buddy?.updatedAt || null,
      buddySchemaVersion: buddy?.version || null,
      profileSha256,
    },
    sourceDocument: buddy,
    projection: { factsSha256 },
    completeness: {
      complete: omissions.length === 0,
      omissions,
    },
    notes: notesDescriptor(notes, includeRawNotes),
    facts,
    bounds: {
      moodHistory: LIMITS.migrationHistoryItems,
      facts: 200,
      rawNotesCharacters: LIMITS.rawNotesCharacters,
      schema2ArraysUnbounded: true,
    },
  };

  if (!buddy) return base;

  return {
    ...base,
    identity: {
      name: buddy.name || '',
      species: buddy.species || '',
      rarity: buddy.rarity || '',
      eyes: buddy.eyes || '',
      hat: buddy.hat || '',
      pickedSpriteId: buddy.pickedSpriteId || '',
    },
    soul: buddy.soul || '',
    personality: buddy.personality || { source: 'standalone', agentId: '' },
    memory: buddy.memory || { sources: [], k: 5 },
    brain: buddy.brain || {},
    legacyModel: buddy.model || {},
    v1Origin: buddy.v1Origin || null,
    progression: {
      mood: buddy.mood || 'neutral',
      stats: buddy.stats || {},
      baseStats: buddy.baseStats || {},
      moodHistory: Array.isArray(buddy.moodHistory) ? buddy.moodHistory : [],
      milestones: Array.isArray(buddy.milestones) ? buddy.milestones : [],
      totalReactions: Number(buddy.totalReactions) || 0,
      totalPets: Number(buddy.totalPets) || 0,
      modelsUsed: Array.isArray(buddy.modelsUsed) ? buddy.modelsUsed : [],
    },
  };
}

function boundedText(value, limit) {
  return String(value == null ? '' : value).slice(0, limit);
}

function boundedArray(value, limit) {
  return Array.isArray(value) ? value.slice(-limit).map(plain) : [];
}

function normalizeLegacyFact(fact, origin) {
  const value = plain(fact) || {};
  return {
    text: boundedText(value.text, 500),
    weight: Number.isFinite(Number(value.weight)) ? Number(value.weight) : 1,
    tags: Array.isArray(value.tags)
      ? value.tags.slice(0, 20).map((tag) => boundedText(tag, 80))
      : [],
    addedAt: value.addedAt || null,
    forgottenAt: value.forgottenAt || null,
    origin,
  };
}

function mergeLegacyFacts(fileFacts, mongoFacts) {
  const seen = new Set();
  const merged = [];
  for (const [facts, origin] of [[fileFacts, 'notes-file'], [mongoFacts, 'legacy-mongo']]) {
    for (const fact of Array.isArray(facts) ? facts : []) {
      const normalized = normalizeLegacyFact(fact, origin);
      if (!normalized.text) continue;
      const key = `${normalized.text.toLowerCase()}::${normalized.addedAt || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(normalized);
    }
  }
  return merged.slice(-200);
}

async function exportLegacyProfileV1({ includeRawNotes = false } = {}) {
  const profile = await exportLegacyProfile({ includeRawNotes, leaseSnapshot: false });
  const buddy = profile.sourceDocument;
  if (!buddy) {
    return {
      schema: PROFILE_SCHEMA,
      schemaVersion: 1,
      contractVersion: CONTRACT_VERSION,
      exportedAt: profile.exportedAt,
      authority: 'legacy-migration-only',
      readOnly: true,
      exists: false,
      source: { collection: 'buddies', seed: SINGLETON_SEED },
    };
  }

  const facts = mergeLegacyFacts(profile.facts?.notesFile, profile.facts?.legacyMongo);
  const notes = {
    file: profile.notes?.file || null,
    rawIncluded: profile.notes?.rawIncluded === true,
    rawTruncated: profile.notes?.rawTruncated === true,
    ...(profile.notes?.rawIncluded ? { raw: profile.notes.raw } : {}),
    ...(profile.notes?.warning ? { warning: profile.notes.warning } : {}),
  };
  return {
    schema: PROFILE_SCHEMA,
    schemaVersion: 1,
    contractVersion: CONTRACT_VERSION,
    exportedAt: profile.exportedAt,
    authority: 'legacy-migration-only',
    readOnly: true,
    exists: true,
    source: {
      collection: 'buddies',
      seed: buddy.seed || SINGLETON_SEED,
      documentId: buddy._id ? String(buddy._id) : null,
      createdAt: buddy.createdAt || null,
      updatedAt: buddy.updatedAt || null,
      buddySchemaVersion: buddy.version || null,
    },
    identity: {
      name: boundedText(buddy.name, 120),
      species: boundedText(buddy.species, 80),
      rarity: boundedText(buddy.rarity, 40),
      eyes: boundedText(buddy.eyes, 40),
      hat: boundedText(buddy.hat, 80),
      pickedSpriteId: boundedText(buddy.pickedSpriteId, 120),
    },
    soul: boundedText(buddy.soul, LIMITS.personalityCharacters),
    personality: plain(buddy.personality) || { source: 'standalone', agentId: '' },
    memory: plain(buddy.memory) || { sources: [], k: 5 },
    brain: plain(buddy.brain) || {},
    legacyModel: plain(buddy.model) || {},
    progression: {
      mood: buddy.mood || 'neutral',
      stats: plain(buddy.stats) || {},
      baseStats: plain(buddy.baseStats) || {},
      moodHistory: boundedArray(buddy.moodHistory, LIMITS.migrationHistoryItems),
      milestones: boundedArray(buddy.milestones, 200),
      totalReactions: Number(buddy.totalReactions) || 0,
      totalPets: Number(buddy.totalPets) || 0,
      modelsUsed: boundedArray(buddy.modelsUsed, 200).map(String),
    },
    facts: {
      active: facts.filter((fact) => !fact.forgottenAt),
      forgotten: facts.filter((fact) => fact.forgottenAt),
      legacyMongoCount: Array.isArray(buddy.facts) ? buddy.facts.length : 0,
    },
    notes,
    bounds: {
      moodHistory: LIMITS.migrationHistoryItems,
      facts: 200,
      rawNotesCharacters: LIMITS.rawNotesCharacters,
    },
  };
}

function boundedPageInteger(value, fallback, name, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new NestorConsumerError(
      `${name} must be an integer between 0 and ${maximum}`,
      400,
      'NESTOR_MIGRATION_INVALID_PAGE'
    );
  }
  return parsed;
}

async function getMigrationNotesPage({ snapshotId, offset, limit } = {}) {
  const expectedSnapshotId = String(snapshotId || '').trim();
  if (!SNAPSHOT_ID_PATTERN.test(expectedSnapshotId)) {
    throw new NestorConsumerError(
      'snapshotId must be exactly 64 hexadecimal characters',
      400,
      'NESTOR_MIGRATION_INVALID_SNAPSHOT_ID'
    );
  }

  const boundedOffset = boundedPageInteger(offset, 0, 'offset');
  const boundedLimit = boundedPageInteger(
    limit,
    LIMITS.migrationNotesChunkBytes,
    'limit',
    LIMITS.migrationNotesChunkBytes
  );
  if (boundedLimit === 0) {
    throw new NestorConsumerError(
      'limit must be greater than 0',
      400,
      'NESTOR_MIGRATION_INVALID_PAGE'
    );
  }

  const leased = leasedSnapshot(expectedSnapshotId);
  const snapshot = leased || await loadMigrationSnapshot();
  if (snapshot.snapshotId !== expectedSnapshotId) {
    throw new NestorConsumerError(
      'The legacy migration source changed; request a new profile snapshot before continuing.',
      409,
      'NESTOR_MIGRATION_SOURCE_CHANGED',
      { expectedSnapshotId, currentSnapshotId: snapshot.snapshotId }
    );
  }

  if (!leased && !snapshot.notes.oversized && !snapshot.notes.unavailable) cacheSnapshot(snapshot);

  if (snapshot.notes.oversized) {
    throw new NestorConsumerError(
      `The notes archive exceeds the ${LIMITS.migrationNotesMaxBytes}-byte migration limit.`,
      413,
      'NESTOR_MIGRATION_NOTES_TOO_LARGE',
      { byteLength: snapshot.notes.byteLength, maximumByteLength: LIMITS.migrationNotesMaxBytes }
    );
  }
  if (snapshot.notes.unavailable) {
    throw new NestorConsumerError(
      'The notes archive is unavailable and cannot be paged from this snapshot.',
      422,
      'NESTOR_MIGRATION_NOTES_UNAVAILABLE',
      { byteLength: snapshot.notes.byteLength, warning: snapshot.notes.warning || null }
    );
  }

  const byteLength = snapshot.notes.byteLength;
  if (boundedOffset > byteLength) {
    throw new NestorConsumerError(
      `offset must not exceed notes byte length ${byteLength}`,
      416,
      'NESTOR_MIGRATION_OFFSET_OUT_OF_RANGE',
      { byteLength }
    );
  }

  const chunk = snapshot.notes.buffer.subarray(boundedOffset, boundedOffset + boundedLimit);
  const nextOffset = boundedOffset + chunk.length;
  return {
    snapshotId: snapshot.snapshotId,
    sha256: snapshot.notes.sha256,
    byteLength,
    offset: boundedOffset,
    chunkBytes: chunk.length,
    data: chunk.toString('base64'),
    nextOffset,
    complete: nextOffset >= byteLength,
  };
}

module.exports = {
  exportLegacyProfile,
  exportLegacyProfileV1,
  getMigrationNotesPage,
  loadMigrationSnapshot,
  exportFacts,
  _snapshotCache: snapshotCache,
};
