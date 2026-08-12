'use strict';

const fs = require('fs');
const path = require('path');
const { extractRequestedLexeme, normalizeLexeme } = require('./kidxReaderReplyGuard');

const SCHEMA_VERSION = 1;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_GLOSSES = 3;
const MAX_GLOSS_CHARS = 320;
const DEFAULT_ARTIFACT_PATH = path.resolve(
  process.cwd(),
  'data',
  'kidx-lexicon',
  'kidx-fr.json'
);

let cache = null;

function artifactPath() {
  return path.resolve(process.env.KIDX_LEXICON_PATH || DEFAULT_ARTIFACT_PATH);
}

function clip(value, maxChars = MAX_GLOSS_CHARS) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 3)) + '...';
}

function sourceAgeDays(dumpDate) {
  const timestamp = Date.parse(String(dumpDate || ''));
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 86400000));
}

function unavailable(file, reason, error = '') {
  return {
    status: 'unavailable',
    file: path.basename(file),
    reason,
    error,
    entryCount: 0,
    artifact: null
  };
}

function validateArtifact(parsed, file) {
  if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || !parsed.entries
    || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
    throw new Error(`Invalid KidX lexicon schema in ${file}`);
  }
  return parsed;
}

function loadArtifact() {
  const file = artifactPath();
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    cache = unavailable(file, error.code === 'ENOENT' ? 'missing' : 'unreadable', error.message);
    return cache;
  }

  if (stat.size > MAX_ARTIFACT_BYTES) {
    cache = unavailable(file, 'too_large', `Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
    return cache;
  }
  if (cache?.status === 'ready' && cache.path === file && cache.mtimeMs === stat.mtimeMs) {
    return cache;
  }

  try {
    const artifact = validateArtifact(JSON.parse(fs.readFileSync(file, 'utf8')), file);
    cache = {
      status: 'ready',
      path: file,
      file: path.basename(file),
      reason: '',
      error: '',
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      entryCount: Object.keys(artifact.entries).length,
      generatedAt: artifact.generatedAt || '',
      sources: artifact.sources || {},
      sourceAgeDays: sourceAgeDays(artifact.sources?.wiktionary?.dumpDate),
      artifact
    };
    return cache;
  } catch (error) {
    cache = unavailable(file, 'invalid', error.message);
    return cache;
  }
}

function publicStatus(loaded = loadArtifact()) {
  return {
    status: loaded.status,
    reason: loaded.reason || '',
    file: loaded.file,
    entryCount: loaded.entryCount || 0,
    sizeBytes: loaded.sizeBytes || 0,
    generatedAt: loaded.generatedAt || '',
    sourceAgeDays: loaded.sourceAgeDays,
    sources: loaded.sources || {}
  };
}

function cleanEntry(entry, normalized) {
  if (!entry || typeof entry !== 'object') return null;
  const glosses = (Array.isArray(entry.glosses) ? entry.glosses : [])
    .map((gloss) => clip(gloss))
    .filter(Boolean)
    .slice(0, MAX_GLOSSES);
  if (!glosses.length && !entry.kidDefinition) return null;
  return {
    normalized,
    word: clip(entry.word || normalized, 80),
    lemma: clip(entry.lemma || entry.word || normalized, 80),
    partOfSpeech: (Array.isArray(entry.partOfSpeech) ? entry.partOfSpeech : [entry.partOfSpeech])
      .map((value) => clip(value, 32))
      .filter(Boolean)
      .slice(0, 4),
    glosses,
    pronunciation: clip(entry.pronunciation, 80),
    kidDefinition: clip(entry.kidDefinition, 240),
    sourceUrl: clip(entry.sourceUrl, 300)
  };
}

function lookupExact(value) {
  const startedAt = process.hrtime.bigint();
  const normalized = normalizeLexeme(value).trim();
  const loaded = loadArtifact();
  const entry = normalized && loaded.status === 'ready'
    ? cleanEntry(loaded.artifact.entries[normalized], normalized)
    : null;
  const lookupMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return {
    ...publicStatus(loaded),
    target: String(value || '').trim(),
    normalized,
    hit: Boolean(entry),
    entry,
    lookupMs
  };
}

function lookupReaderRequest(userText) {
  const target = extractRequestedLexeme(userText);
  if (!target) return null;
  return lookupExact(target);
}

function buildPromptContext(lookup) {
  if (!lookup?.hit || !lookup.entry) return '';
  const entry = lookup.entry;
  const senses = entry.glosses.map((gloss, index) => `${index + 1}. ${gloss}`);
  return [
    `Source lexicale locale pour le mot exact « ${entry.word} » (lemme: ${entry.lemma}).`,
    entry.partOfSpeech.length ? `Catégorie: ${entry.partOfSpeech.join(', ')}.` : '',
    ...senses,
    'Utilise uniquement ces sens comme base factuelle. Choisis le sens le plus probable avec le contexte, reformule-le avec des mots simples pour un enfant, et répète le mot demandé. Ne mentionne pas la source technique.'
  ].filter(Boolean).join('\n');
}

function missReply(target) {
  return `Je ne veux pas inventer : je ne trouve pas « ${String(target || '').trim()} » dans mon dictionnaire. `
    + 'Peux-tu l’épeler ou me montrer le mot ?';
}

function _resetForTests() {
  cache = null;
}

module.exports = {
  SCHEMA_VERSION,
  MAX_ARTIFACT_BYTES,
  artifactPath,
  buildPromptContext,
  getStatus: publicStatus,
  lookupExact,
  lookupReaderRequest,
  missReply,
  _resetForTests
};
