const fs = require('fs/promises');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');

const mammoth = require('mammoth');
const mongoose = require('mongoose');

const logger = require('../../config/logger');
const { getRagStore } = require('./ragStore');
const {
  classifyVaultPath,
  loadVaultPolicy
} = require('../../../shared/obsidianVaultPolicy');

const execFileAsync = promisify(execFile);
let pdfParseModule = null;
const OBSIDIAN_VAULT_POLICY = loadVaultPolicy();

const DEFAULT_ROOTS = OBSIDIAN_VAULT_POLICY.ingestion.approvedRoots.slice();
const DEFAULT_MAX_FILE_SIZE_BYTES = OBSIDIAN_VAULT_POLICY.ingestion.maxFileSizeBytes;
const DEFAULT_BATCH_DELAY_MS = 100;

const SUPPORTED_EXTENSIONS = new Set(OBSIDIAN_VAULT_POLICY.ingestion.allowedExtensions);
const SKIP_EXTENSIONS = new Set([
  '7z',
  'avi',
  'bin',
  'blend',
  'bmp',
  'csv',
  'dll',
  'doc',
  'dmg',
  'exe',
  'gif',
  'gz',
  'heic',
  'iso',
  'jpeg',
  'jpg',
  'm4a',
  'mkv',
  'mov',
  'mp3',
  'mp4',
  'nfo',
  'obj',
  'ogg',
  'otf',
  'pages',
  'png',
  'rar',
  'rtf',
  'sqlite',
  'stl',
  'tar',
  'tif',
  'tiff',
  'ttf',
  'wav',
  'webm',
  'webp',
  'xls',
  'xlsx',
  'xml',
  'yaml',
  'yml',
  'zip'
]);
const SKIP_DIRECTORY_NAMES = new Set(OBSIDIAN_VAULT_POLICY.ingestion.excludedDirectoryNames);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRoots(input) {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(',')
      : [];

  return Array.from(
    new Set(
      raw
        .map((entry) => String(entry || '').trim())
        .filter(Boolean)
        .map((entry) => path.resolve(entry))
    )
  );
}

function getConfiguredRoots(value = process.env.INGEST_ROOTS) {
  if (!value || !String(value).trim()) {
    return DEFAULT_ROOTS.slice();
  }
  const requested = normalizeRoots(value);
  const invalid = requested.filter((root) => !DEFAULT_ROOTS.some((allowed) => isPathUnderRoot(root, allowed)));
  if (invalid.length) {
    throw new Error(`INGEST_ROOTS contains paths outside the approved Obsidian corpus: ${invalid.join(', ')}`);
  }
  return requested;
}

function normalizeExt(ext, filePath = '') {
  const raw = String(ext || path.extname(filePath).slice(1) || '').trim().toLowerCase();
  return raw.startsWith('.') ? raw.slice(1) : raw;
}

function isPathUnderRoot(filePath, root) {
  const resolvedPath = path.resolve(filePath);
  const resolvedRoot = path.resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`);
}

function getMatchingRoot(filePath, roots) {
  const normalizedRoots = normalizeRoots(roots);
  const matches = normalizedRoots.filter((root) => isPathUnderRoot(filePath, root));
  if (!matches.length) {
    return null;
  }
  return matches.sort((a, b) => b.length - a.length)[0];
}

function hasSkippedDirectory(filePath) {
  const segments = path.resolve(filePath).split(path.sep).filter(Boolean);
  return segments.some((segment) => SKIP_DIRECTORY_NAMES.has(segment.toLowerCase()));
}

function normalizeMtimeMs(mtime) {
  if (mtime === null || mtime === undefined) {
    return null;
  }
  if (mtime instanceof Date) {
    return mtime.getTime();
  }
  const numericMtime = Number(mtime);
  if (!Number.isFinite(numericMtime)) {
    return null;
  }
  return numericMtime > 1e12 ? numericMtime : numericMtime * 1000;
}

function needsReindex(record) {
  if (!record || !record.indexed_at) {
    return true;
  }
  const indexedAt = new Date(record.indexed_at);
  if (Number.isNaN(indexedAt.getTime())) {
    return true;
  }
  // If mtime is missing/unparseable, treat as unchanged — avoids re-ingesting
  // files whose mtime was lost while content hasn't actually changed.
  const mtimeMs = normalizeMtimeMs(record.mtime);
  return mtimeMs === null ? false : mtimeMs > indexedAt.getTime();
}

function slugifySegment(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'auto-ingested';
}

function deriveSourceTag(filePath, roots = []) {
  const matchedRoot = getMatchingRoot(filePath, roots);
  if (matchedRoot) {
    const relativePath = path.relative(matchedRoot, filePath);
    const segments = relativePath.split(path.sep).filter(Boolean);
    if (segments.length > 1) {
      return slugifySegment(segments[0]);
    }
    const rootName = path.basename(matchedRoot);
    return slugifySegment(rootName);
  }
  return slugifySegment(path.basename(path.dirname(filePath)));
}

function buildTags(filePath, roots = []) {
  const source = deriveSourceTag(filePath, roots);
  return Array.from(new Set(['auto-ingested', source]));
}

function describeSkip(record, options = {}) {
  const filePath = record?.path || '';
  const ext = normalizeExt(record?.ext, filePath);
  const roots = options.roots || [];
  const maxFileSizeBytes = Math.min(
    Number(options.maxFileSizeBytes || DEFAULT_MAX_FILE_SIZE_BYTES),
    Number((options.policy || OBSIDIAN_VAULT_POLICY).ingestion.maxFileSizeBytes)
  );

  if (!filePath) {
    return { skip: true, reason: 'missing path' };
  }
  if (roots.length && !getMatchingRoot(filePath, roots)) {
    return { skip: true, reason: 'outside configured roots' };
  }
  const vaultClassification = classifyVaultPath(filePath, {
    policy: options.policy || OBSIDIAN_VAULT_POLICY,
    record: { ext, size: record?.size },
    maxFileSizeBytes
  });
  if (!vaultClassification.allowed) {
    return { skip: true, reason: vaultClassification.reason };
  }
  if (hasSkippedDirectory(filePath)) {
    return { skip: true, reason: 'skip directory' };
  }
  if (SKIP_EXTENSIONS.has(ext)) {
    return { skip: true, reason: `skip extension: .${ext}` };
  }
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return { skip: true, reason: `unsupported extension: .${ext || 'unknown'}` };
  }
  if (Number(record?.size || 0) > maxFileSizeBytes) {
    return { skip: true, reason: `file too large: ${record.size} bytes` };
  }
  return { skip: false };
}

async function extractPdfText(filePath, options = {}) {
  const commandRunner = options.commandRunner || execFileAsync;
  const parser = options.pdfParser || getPdfParser();
  const fileSystem = options.fileSystem || fs;

  try {
    const { stdout } = await commandRunner('pdftotext', ['-layout', '-nopgbrk', filePath, '-'], {
      maxBuffer: DEFAULT_MAX_FILE_SIZE_BYTES * 4
    });
    if (stdout && stdout.trim()) {
      return stdout;
    }
  } catch (error) {
    logger.warn('pdftotext unavailable, falling back to pdf-parse', {
      filePath,
      error: error.message
    });
  }

  const buffer = await fileSystem.readFile(filePath);
  const parsed = await parser(buffer);
  return parsed.text || '';
}

async function extractJsonText(filePath, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const raw = await fileSystem.readFile(filePath, 'utf8');
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch (_error) {
    return raw;
  }
}

async function extractTextFromFile(filePath, ext, options = {}) {
  const fileSystem = options.fileSystem || fs;
  switch (normalizeExt(ext, filePath)) {
    case 'md':
    case 'txt':
      return fileSystem.readFile(filePath, 'utf8');
    case 'json':
      return extractJsonText(filePath, { fileSystem });
    case 'pdf':
      return extractPdfText(filePath, options);
    case 'docx': {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value || '';
    }
    default:
      throw new Error(`Unsupported extension: .${normalizeExt(ext, filePath)}`);
  }
}

function createDirectIngestClient(options = {}) {
  const ragStore = options.ragStore || getRagStore();
  return async (payload) => ragStore.upsertDocumentWithChunks(payload.text, {
    source: payload.source,
    tags: payload.tags,
    documentId: payload.documentId,
    chunkSize: payload.chunkSize,
    chunkOverlap: payload.chunkOverlap,
    hash: payload.hash
  });
}

function getPdfParser() {
  if (!pdfParseModule) {
    pdfParseModule = require('pdf-parse');
  }
  return pdfParseModule;
}

function createIngestApiClient(options = {}) {
  const fetchImpl = options.fetchImpl || require('node-fetch');
  const baseUrl = String(options.baseUrl || process.env.RAG_API_URL || `http://127.0.0.1:${process.env.PORT || 3082}`)
    .replace(/\/+$/, '');
  const ingestPath = options.ingestPath || '/api/rag/ingest';

  return async (payload) => {
    const response = await fetchImpl(`${baseUrl}${ingestPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    let body = {};
    try {
      body = await response.json();
    } catch (_error) {
      body = {};
    }

    if (!response.ok || body.ok === false) {
      const message = body?.detail || body?.error || `Ingest API failed with status ${response.status}`;
      throw new Error(message);
    }

    return body.data;
  };
}

class IngestWorker {
  constructor(options = {}) {
    this.db = options.db || mongoose.connection.db;
    this.logger = options.logger || logger;
    this.policy = options.policy || OBSIDIAN_VAULT_POLICY;
    const selectedRoots = Array.isArray(options.roots) && options.roots.length
      ? options.roots
      : getConfiguredRoots();
    this.roots = normalizeRoots(selectedRoots);
    const approvedRoots = normalizeRoots(this.policy.ingestion.approvedRoots);
    const invalidRoots = this.roots.filter((root) => !approvedRoots.some((approved) => isPathUnderRoot(root, approved)));
    if (invalidRoots.length) {
      throw new Error(`Ingest roots are outside the approved Obsidian corpus: ${invalidRoots.join(', ')}`);
    }
    this.maxFileSizeBytes = Math.min(
      Number(options.maxFileSizeBytes || process.env.INGEST_MAX_FILE_SIZE_BYTES || DEFAULT_MAX_FILE_SIZE_BYTES),
      Number(this.policy.ingestion.maxFileSizeBytes)
    );
    this.batchDelayMs = Number(
      options.batchDelayMs || process.env.INGEST_BATCH_DELAY_MS || DEFAULT_BATCH_DELAY_MS
    );
    this.ingestDocument = options.ingestDocument || createDirectIngestClient(options);
    this.commandRunner = options.commandRunner || execFileAsync;
    this.pdfParser = options.pdfParser || null;
    this.fileSystem = options.fileSystem || fs;
    this.realRoots = new Map();
  }

  get collection() {
    if (!this.db) {
      throw new Error('MongoDB is not connected');
    }
    return this.db.collection('nas_files');
  }

  async getCandidateRecords(options = {}) {
    const limit = Number(options.limit || 0);
    const query = {
      ext: { $in: Array.from(SUPPORTED_EXTENSIONS) },
      size: { $lte: this.maxFileSizeBytes }
    };

    if (this.roots.length) {
      query.$or = this.roots.map((root) => ({
        path: { $regex: `^${escapeRegExp(root)}(?:[\\/]|$)` }
      }));
    }

    const cursor = this.collection
      .find(query)
      .sort({ scan_seen_at: -1, path: 1 });

    const cap = limit > 0 ? limit : 5000;
    const eligible = [];

    for await (const record of cursor) {
      if (eligible.length >= cap) break;
      if (describeSkip(record, { roots: this.roots, maxFileSizeBytes: this.maxFileSizeBytes }).skip) {
        continue;
      }
      if (needsReindex(record)) {
        eligible.push(record);
      }
    }

    await cursor.close();
    return eligible;
  }

  async validateRoots() {
    this.realRoots.clear();
    for (const root of this.roots) {
      let realRoot;
      let rootStat;
      try {
        [realRoot, rootStat] = await Promise.all([
          this.fileSystem.realpath(root),
          this.fileSystem.stat(root)
        ]);
      } catch (error) {
        const unavailable = new Error(`Approved ingest root is unavailable: ${root}: ${error.message}`);
        unavailable.code = 'INGEST_ROOT_UNAVAILABLE';
        throw unavailable;
      }
      if (!rootStat.isDirectory()) {
        const invalid = new Error(`Approved ingest root is not a directory: ${root}`);
        invalid.code = 'INGEST_ROOT_INVALID';
        throw invalid;
      }
      if (path.resolve(realRoot) !== path.resolve(root)) {
        const mismatch = new Error(`Approved ingest root resolves outside its configured path: ${root}`);
        mismatch.code = 'INGEST_ROOT_REALPATH_MISMATCH';
        throw mismatch;
      }
      this.realRoots.set(root, path.resolve(realRoot));
    }
  }

  async resolveReadableFile(filePath) {
    const matchedRoot = getMatchingRoot(filePath, this.roots);
    if (!matchedRoot) {
      const outside = new Error('File is outside configured roots');
      outside.code = 'INGEST_OUTSIDE_ROOT';
      throw outside;
    }

    const realRoot = this.realRoots.get(matchedRoot) || path.resolve(await this.fileSystem.realpath(matchedRoot));
    const realFile = path.resolve(await this.fileSystem.realpath(filePath));
    if (!isPathUnderRoot(realFile, realRoot)) {
      const traversal = new Error('Symlink traversal outside approved ingest root rejected');
      traversal.code = 'INGEST_SYMLINK_TRAVERSAL';
      throw traversal;
    }

    const fileStat = await this.fileSystem.stat(realFile);
    if (!fileStat.isFile()) {
      const invalid = new Error('Ingest candidate is not a regular file');
      invalid.code = 'INGEST_NOT_REGULAR_FILE';
      throw invalid;
    }
    if (Number(fileStat.size || 0) > this.maxFileSizeBytes) {
      const oversized = new Error(`Ingest candidate exceeds the approved size limit: ${fileStat.size} bytes`);
      oversized.code = 'INGEST_FILE_OVERSIZED';
      throw oversized;
    }
    return realFile;
  }

  async processRecord(record) {
    const skip = describeSkip(record, {
      roots: this.roots,
      maxFileSizeBytes: this.maxFileSizeBytes
    });
    if (skip.skip) {
      return { status: 'skipped', reason: skip.reason, path: record.path };
    }

    const source = deriveSourceTag(record.path, this.roots);
    const tags = buildTags(record.path, this.roots);
    const updateFilter = record._id ? { _id: record._id } : { path: record.path };

    try {
      const readablePath = await this.resolveReadableFile(record.path);
      const text = await extractTextFromFile(readablePath, record.ext, {
        commandRunner: this.commandRunner,
        pdfParser: this.pdfParser,
        fileSystem: this.fileSystem
      });

      if (!text || !text.trim()) {
        await this.collection.updateOne(updateFilter, {
          $set: {
            indexed_at: new Date(),
            indexed_status: 'skipped-empty',
            indexed_source: source,
            indexed_tags: tags,
            indexed_document_id: record.path,
            indexed_error: null
          }
        });
        return { status: 'skipped', reason: 'empty extracted text', path: record.path, source };
      }

      const ingestResult = await this.ingestDocument({
        text,
        source,
        tags,
        documentId: record.path,
        hash: record.sha256
      });

      const resultStatus = ingestResult?.unchanged
        ? 'unchanged'
        : record.indexed_at
          ? 'updated'
          : 'ingested';

      await this.collection.updateOne(updateFilter, {
        $set: {
          indexed_at: new Date(),
          indexed_status: resultStatus,
          indexed_source: source,
          indexed_tags: tags,
          indexed_document_id: record.path,
          indexed_error: null
        }
      });

      return {
        status: resultStatus,
        source,
        path: record.path,
        documentId: record.path,
        chunkCount: ingestResult?.chunkCount || 0
      };
    } catch (error) {
      await this.collection.updateOne(updateFilter, {
        $set: {
          indexed_error: error.message,
          indexed_error_at: new Date(),
          indexed_source: source,
          indexed_tags: tags,
          indexed_document_id: record.path
        }
      });

      this.logger.warn('RAG ingest worker failed for file', {
        path: record.path,
        error: error.message
      });

      return { status: 'failed', reason: error.message, path: record.path, source };
    }
  }

  async run(options = {}) {
    const startedAt = new Date();
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : null;

    await this.validateRoots();
    const candidates = await this.getCandidateRecords(options);
    const results = [];
    const summary = {
      startedAt,
      finishedAt: null,
      roots: this.roots,
      totalCandidates: candidates.length,
      processed: 0,
      ingested: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      results
    };

    // Report initial total so callers can show progress bars
    if (onProgress) {
      onProgress({ processed: 0, total: candidates.length, errors: 0 });
    }

    for (const [index, record] of candidates.entries()) {
      if (isCancelled && isCancelled()) {
        this.logger.info('RAG ingest worker cancelled', { processed: summary.processed });
        break;
      }

      const result = await this.processRecord(record);
      results.push(result);
      summary.processed += 1;

      if (result.status === 'ingested') summary.ingested += 1;
      else if (result.status === 'updated') summary.updated += 1;
      else if (result.status === 'unchanged') summary.unchanged += 1;
      else if (result.status === 'failed') summary.failed += 1;
      else summary.skipped += 1;

      if (onProgress) {
        onProgress({
          processed: summary.processed,
          total: candidates.length,
          errors: summary.failed
        });
      }

      if (index < candidates.length - 1 && this.batchDelayMs > 0) {
        await sleep(this.batchDelayMs);
      }
    }

    summary.finishedAt = new Date();
    this.logger.info('RAG ingest worker finished', {
      totalCandidates: summary.totalCandidates,
      processed: summary.processed,
      ingested: summary.ingested,
      updated: summary.updated,
      unchanged: summary.unchanged,
      skipped: summary.skipped,
      failed: summary.failed
    });

    return summary;
  }
}

async function runIngestScan(options = {}) {
  const worker = options.worker || new IngestWorker(options);
  return worker.run(options);
}

module.exports = {
  DEFAULT_BATCH_DELAY_MS,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_ROOTS,
  IngestWorker,
  SKIP_DIRECTORY_NAMES,
  SKIP_EXTENSIONS,
  SUPPORTED_EXTENSIONS,
  buildTags,
  createDirectIngestClient,
  createIngestApiClient,
  deriveSourceTag,
  describeSkip,
  extractPdfText,
  extractTextFromFile,
  getConfiguredRoots,
  getMatchingRoot,
  getPdfParser,
  hasSkippedDirectory,
  isPathUnderRoot,
  needsReindex,
  normalizeExt,
  normalizeMtimeMs,
  normalizeRoots,
  runIngestScan,
  sleep
};
