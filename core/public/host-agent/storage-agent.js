'use strict';

/**
 * Native AgentX shared-storage scanner.
 *
 * The Data container can only see explicitly bound paths. This agent inventories
 * host-visible shared drives, maps them to stable canonical paths, and streams
 * metadata plus budgeted candidate hashes into AgentX. It never moves, renames,
 * archives, chmods, or deletes files.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const VERSION = 'storage-1.4.1';
const MAX_METADATA_PROBE_PATHS = 1_000;
const MAX_CONTENT_PROBE_BYTES = 8 * 1024;
const DATA_URL = (process.env.DATA_URL || 'http://192.0.2.99:3083').replace(/\/+$/, '');
const SCANNER_ID = process.env.SCANNER_ID || process.env.STORAGE_SCANNER_ID || os.hostname().toLowerCase();
const TOKEN = process.env.STORAGE_AGENT_TOKEN || process.env.NETWORK_AGENT_TOKEN || '';
const POLL_MS = Math.max(5000, Number(process.env.STORAGE_AGENT_POLL_MS || 15000));
const HEARTBEAT_MS = Math.min(
  60_000,
  Math.max(5_000, Number(process.env.STORAGE_AGENT_HEARTBEAT_MS || 30_000) || 30_000)
);
const BATCH_SIZE = Math.max(50, Number(process.env.STORAGE_AGENT_BATCH_SIZE || 500));
const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.STORAGE_AGENT_REQUEST_TIMEOUT_MS || 120000));
const COMPLETION_TIMEOUT_MS = Math.max(
  REQUEST_TIMEOUT_MS,
  Number(process.env.STORAGE_AGENT_COMPLETION_TIMEOUT_MS || 15 * 60 * 1000)
);
const COMPLETION_RECONCILE_MS = 5 * 60 * 1000;
const COMPLETION_RECONCILE_POLL_MS = 5000;
const CACHE_DIR = process.env.STORAGE_AGENT_CACHE_DIR || path.join(os.homedir(), '.cache', 'agentx-storage-agent');
let busy = false;

function defaultSources() {
  const mediaRoot = process.platform === 'win32' ? 'E:\\Media' : '/Media/Media';
  return {
    media: { hostPath: mediaRoot, canonicalRoot: '/mnt/media', excludeTopLevel: ['Datalake'] },
    datalake: {
      hostPath: process.platform === 'win32' ? 'E:\\Media\\Datalake' : '/Media/Media/Datalake',
      canonicalRoot: '/mnt/datalake',
      excludeTopLevel: []
    }
  };
}

function sourceConfig() {
  if (!process.env.STORAGE_SOURCES_JSON) return defaultSources();
  try { return JSON.parse(process.env.STORAGE_SOURCES_JSON); }
  catch (error) { throw new Error(`Invalid STORAGE_SOURCES_JSON: ${error.message}`); }
}

function isExcludedTopLevel(relativePath, excludeTopLevel = []) {
  const top = String(relativePath || '').split(/[\\/]/)[0].toLowerCase();
  return new Set(excludeTopLevel.map(value => String(value).toLowerCase())).has(top);
}

const SOURCES = sourceConfig();
const SOURCE_IDS = Object.keys(SOURCES);
const headers = () => ({
  'content-type': 'application/json',
  ...(TOKEN ? { 'x-agent-token': TOKEN } : {})
});
const ts = () => new Date().toISOString();

async function requestJson(route, options = {}) {
  const response = await fetch(`${DATA_URL}${route}`, {
    method: options.method || 'GET',
    headers: headers(),
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs || REQUEST_TIMEOUT_MS)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.message || `${route}: HTTP ${response.status}`);
  return json.data || json;
}

/**
 * Completion can legitimately spend several minutes rebuilding directory
 * rollups. Node's global fetch has an independent response-header ceiling that
 * can fire before AbortSignal.timeout(), so completion uses the built-in HTTP
 * client with one explicit absolute deadline instead.
 */
function requestJsonWithHttp(baseUrl, route, options = {}) {
  const target = new URL(route, `${String(baseUrl).replace(/\/+$/, '')}/`);
  const payload = options.body ? JSON.stringify(options.body) : '';
  const transport = target.protocol === 'https:' ? https : http;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || REQUEST_TIMEOUT_MS));

  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      callback(value);
    };
    const request = transport.request(target, {
      method: options.method || 'GET',
      headers: {
        ...headers(),
        ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {})
      }
    }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        raw += chunk;
        if (raw.length > 1024 * 1024) {
          request.destroy(new Error(`Completion response exceeded 1 MiB: ${route}`));
        }
      });
      response.on('end', () => {
        let json = {};
        try { json = raw ? JSON.parse(raw) : {}; }
        catch (_) { return finish(reject, new Error(`Invalid JSON response from ${route}`)); }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return finish(reject, new Error(json.message || `${route}: HTTP ${response.statusCode}`));
        }
        return finish(resolve, json.data || json);
      });
      response.on('aborted', () => finish(reject, new Error(`Response aborted by ${route}`)));
      response.on('error', error => finish(reject, error));
    });
    request.on('error', error => finish(reject, error));
    deadline = setTimeout(() => {
      request.destroy(new Error(`${route}: completion timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (payload) request.write(payload);
    request.end();
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizedTerminalStatus(status) {
  return status === 'completed' ? 'complete' : String(status || '').toLowerCase();
}

async function reconcileCompletion(scanId, expectedStatus, options = {}) {
  const getStatus = options.getStatus || ((route, requestOptions) => requestJson(route, requestOptions));
  const wait = options.sleep || sleep;
  const now = options.now || Date.now;
  const maxWaitMs = Math.max(0, Number(options.maxWaitMs ?? COMPLETION_RECONCILE_MS));
  const pollMs = Math.max(1, Number(options.pollMs ?? COMPLETION_RECONCILE_POLL_MS));
  const expected = normalizedTerminalStatus(expectedStatus);
  const terminal = new Set(['complete', 'partial', 'failed', 'stopped']);
  const deadline = now() + maxWaitMs;
  let attempts = 0;
  let lastStatus = null;
  let lastError = null;

  while (true) {
    attempts++;
    try {
      const requestBudgetMs = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - now()));
      const state = await getStatus(
        `/api/v1/storage/status/${encodeURIComponent(scanId)}`,
        { timeoutMs: requestBudgetMs }
      );
      lastStatus = normalizedTerminalStatus(state?.status);
      if (lastStatus === expected) {
        return { ok: true, status: lastStatus, attempts };
      }
      if (terminal.has(lastStatus)) {
        return { ok: false, status: lastStatus, attempts, reason: 'unexpected_terminal_status' };
      }
    } catch (error) {
      lastError = error;
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      return {
        ok: false,
        status: lastStatus,
        attempts,
        reason: 'reconciliation_timeout',
        error: lastError?.message || null
      };
    }
    await wait(Math.min(pollMs, remaining));
  }
}

function canonicalPath(root, relativePath) {
  const suffix = relativePath.split(path.sep).filter(Boolean).map(encodePathPart).join('/');
  return suffix ? `${root.replace(/\/+$/, '')}/${suffix}` : root.replace(/\/+$/, '');
}

// Preserve readable Unicode and spaces. Only slash-like characters need mapping
// because the canonical namespace is POSIX-shaped regardless of scanner OS.
function encodePathPart(part) {
  return String(part).replace(/[\\/]/g, '_');
}

function fingerprint(file) {
  return `${file.size}:${file.mtime}`;
}

function metadataProbePathSet(scan = {}) {
  const root = String(scan.root || '').replace(/\/+$/, '');
  if (!root || !Array.isArray(scan.metadata_probe_paths)) return new Set();
  return new Set(scan.metadata_probe_paths
    .slice(0, MAX_METADATA_PROBE_PATHS)
    .map(value => String(value || '').trim())
    .filter(value => value === root || value.startsWith(`${root}/`)));
}

function hasBytes(buffer, offset, bytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length < offset + bytes.length) return false;
  return bytes.every((value, index) => buffer[offset + index] === value);
}

function hasTransportStreamSync(buffer, offset, packetSize) {
  const repeatCount = 5;
  if (!Buffer.isBuffer(buffer) || buffer.length < offset + (packetSize * (repeatCount - 1)) + 1) {
    return false;
  }
  for (let packet = 0; packet < repeatCount; packet += 1) {
    if (buffer[offset + (packet * packetSize)] !== 0x47) return false;
  }
  return true;
}

function detectContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  if (hasBytes(buffer, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (hasBytes(buffer, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (hasBytes(buffer, 0, [0x50, 0x4b, 0x03, 0x04]) || hasBytes(buffer, 0, [0x50, 0x4b, 0x05, 0x06])) return 'application/zip';
  if (hasBytes(buffer, 0, [0x1f, 0x8b])) return 'application/gzip';
  if (hasBytes(buffer, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'application/x-7z-compressed';
  if (hasBytes(buffer, 0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'application/vnd.rar';
  if (hasBytes(buffer, 0, [0x7f, 0x45, 0x4c, 0x46])) return 'application/x-elf';
  if (buffer.length >= 0x40 && buffer.subarray(0, 2).toString('ascii') === 'MZ') {
    const peOffset = buffer.readUInt32LE(0x3c);
    if (peOffset <= buffer.length - 4 && hasBytes(buffer, peOffset, [0x50, 0x45, 0x00, 0x00])) {
      return 'application/vnd.microsoft.portable-executable';
    }
  }
  if (buffer.subarray(0, 16).toString('ascii') === 'SQLite format 3\0') return 'application/vnd.sqlite3';
  if (buffer.subarray(0, 4).toString('ascii') === 'fLaC') return 'audio/flac';
  if (buffer.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (buffer.subarray(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (
    buffer.length >= 4 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0 &&
    ((buffer[1] >> 3) & 0x03) !== 1 && ((buffer[1] >> 1) & 0x03) !== 0 &&
    ((buffer[2] >> 4) & 0x0f) > 0 &&
    ((buffer[2] >> 4) & 0x0f) < 0x0f && ((buffer[2] >> 2) & 0x03) !== 0x03
  ) return 'audio/mpeg';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF') {
    const form = buffer.subarray(8, 12).toString('ascii');
    if (form === 'WAVE') return 'audio/wav';
    if (form === 'WEBP') return 'image/webp';
  }
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  if (
    hasTransportStreamSync(buffer, 0, 188) ||
    hasTransportStreamSync(buffer, 4, 192)
  ) return 'video/mp2t';

  const text = buffer.toString('utf8').replace(/\0/g, '');
  const headers = text.match(/^(?:from|mime-version|subject|date|content-type|snapshot-content-location):/gim) || [];
  if (new Set(headers.map(value => value.toLowerCase())).size >= 2) return 'message/rfc822';
  if (/^#extm3u\s*$/im.test(text) || /(?:^|\n)[^\n]+\.(?:mp3|m4a|flac|wav)\s*(?:\r?\n|$)/i.test(text)) {
    return 'audio/x-mpegurl';
  }
  return null;
}

async function readFilePrefix(filePath, maxBytes = MAX_CONTENT_PROBE_BYTES) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const bytes = Math.max(1, Math.min(MAX_CONTENT_PROBE_BYTES, Number(maxBytes) || MAX_CONTENT_PROBE_BYTES));
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function probeContentType(filePath, options = {}) {
  const readPrefix = options.readPrefix || readFilePrefix;
  const maxBytes = Math.min(MAX_CONTENT_PROBE_BYTES, Number(options.maxBytes) || MAX_CONTENT_PROBE_BYTES);
  return detectContentType(await readPrefix(filePath, maxBytes));
}

function hasCurrentCache(file, cache) {
  const entry = cache[file.path];
  return !!entry?.sha256 && entry.fingerprint === fingerprint(file);
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function loadCache(source) {
  try { return JSON.parse(await fsp.readFile(path.join(CACHE_DIR, `${source}.json`), 'utf8')); }
  catch (_) { return {}; }
}

async function saveCache(source, cache) {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const target = path.join(CACHE_DIR, `${source}.json`);
  const temp = `${target}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(cache));
  await fsp.rename(temp, target);
}

async function postBatch(scanId, files) {
  if (files.length === 0) return;
  await requestJson(`/api/v1/storage/scan/${encodeURIComponent(scanId)}/batch`, {
    method: 'POST',
    body: { files, meta: { scannerId: SCANNER_ID, agentVersion: VERSION } }
  });
}

async function postHeartbeat(scanId) {
  return requestJson('/api/v1/storage/agent/heartbeat', {
    method: 'POST',
    body: {
      scannerId: SCANNER_ID,
      hostname: os.hostname(),
      platform: process.platform,
      agentVersion: VERSION,
      sources: SOURCE_IDS.join(','),
      scanId
    }
  });
}

function startScanHeartbeat(scanId, options = {}) {
  const send = options.send || postHeartbeat;
  const intervalMs = Math.max(1, Number(options.intervalMs || HEARTBEAT_MS));
  const schedule = options.schedule || setInterval;
  const cancel = options.cancel || clearInterval;
  let stopped = false;
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) return false;
    inFlight = true;
    try {
      await send(scanId);
      return true;
    } catch (error) {
      console.warn(`[${ts()}] scan ${scanId} heartbeat failed: ${error.message}`);
      return false;
    } finally {
      inFlight = false;
    }
  };

  const timer = schedule(() => { void tick(); }, intervalMs);
  if (typeof timer?.unref === 'function') timer.unref();
  void tick();

  return {
    tick,
    stop() {
      if (stopped) return;
      stopped = true;
      cancel(timer);
    }
  };
}

async function finishScan(scanId, status, stats, options = {}) {
  const completeRequest = options.completeRequest || ((route, requestOptions) => (
    requestJsonWithHttp(DATA_URL, route, requestOptions)
  ));
  const reconcile = options.reconcile || reconcileCompletion;
  const route = `/api/v1/storage/scan/${encodeURIComponent(scanId)}`;
  try {
    return await completeRequest(route, {
      method: 'PATCH',
      body: { status, stats, completedAt: new Date().toISOString() },
      timeoutMs: COMPLETION_TIMEOUT_MS
    });
  } catch (error) {
    console.warn(`[${ts()}] scan ${scanId} completion acknowledgement ambiguous: ${error.message}; reconciling status`);
    const result = await reconcile(scanId, status, options.reconcileOptions || {});
    if (result.ok) {
      console.log(`[${ts()}] scan ${scanId} completion reconciled status=${result.status} attempts=${result.attempts}`);
      return { reconciled: true, ...result };
    }
    const failure = new Error(
      `completion acknowledgement failed: ${error.message}; reconciliation=${result.reason || result.status || 'unknown'}`
    );
    failure.cause = error;
    failure.reconciliation = result;
    throw failure;
  }
}

async function inventory(scan, config) {
  const hostRoot = path.resolve(config.hostPath);
  const canonicalRoot = scan.root;
  const stack = [{ dir: hostRoot, relative: '' }];
  const files = [];
  const metadataProbePaths = metadataProbePathSet(scan);
  let batch = [];
  const stats = {
    files_seen: 0, files_processed: 0, errors: 0, metadata_errors: 0,
    hash_errors: 0, skipped: 0, hashed: 0, hash_bytes: 0,
    content_probed: 0, content_probe_matched: 0, content_probe_errors: 0
  };

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = await fsp.readdir(current.dir, { withFileTypes: true }); }
    catch (_) { stats.errors++; stats.metadata_errors++; continue; }

    for (const entry of entries) {
      const relative = current.relative ? path.join(current.relative, entry.name) : entry.name;
      if (isExcludedTopLevel(relative, config.excludeTopLevel)) { stats.skipped++; continue; }
      const hostPath = path.join(current.dir, entry.name);
      if (entry.isSymbolicLink()) { stats.skipped++; continue; }
      if (entry.isDirectory()) { stack.push({ dir: hostPath, relative }); continue; }
      if (!entry.isFile()) continue;

      let fileStats;
      try { fileStats = await fsp.stat(hostPath); }
      catch (_) { stats.errors++; stats.metadata_errors++; continue; }
      const record = {
        hostPath,
        path: canonicalPath(canonicalRoot, relative),
        source_root: canonicalRoot,
        relative_path: relative.split(path.sep).join('/'),
        size: fileStats.size,
        mtime: Math.floor(fileStats.mtimeMs / 1000)
      };
      if (metadataProbePaths.has(record.path)) {
        stats.content_probed++;
        try {
          const contentType = await probeContentType(hostPath);
          record.content_probe_source = 'native-magic-v1';
          if (contentType) {
            record.content_type = contentType;
            stats.content_probe_matched++;
          }
        } catch (_) {
          stats.content_probe_errors++;
        }
      }
      files.push(record);
      batch.push(record);
      stats.files_seen++;
      if (batch.length >= BATCH_SIZE) {
        await postBatch(scan.scan_id, batch);
        stats.files_processed += batch.length;
        batch = [];
      }
    }
  }

  await postBatch(scan.scan_id, batch);
  stats.files_processed += batch.length;
  return { files, stats };
}

function selectHashGroups(files, cache, scan) {
  const bySize = new Map();
  for (const file of files) {
    if (file.size <= 0) continue;
    if (!bySize.has(file.size)) bySize.set(file.size, []);
    bySize.get(file.size).push(file);
  }
  let groups = scan.hash_mode === 'all'
    ? files.filter(file => file.size > 0).map(file => [file])
    : [...bySize.values()].filter(group => group.length > 1);
  groups.sort((a, b) => (b[0].size * (b.length - 1)) - (a[0].size * (a.length - 1)));

  const maxFiles = Math.max(1, Number(scan.hash_max_files || 5000));
  const maxBytes = Math.max(1, Number(scan.hash_max_bytes || 50 * 1024 * 1024 * 1024));
  const selected = [];
  let selectedFiles = 0;
  let selectedBytes = 0;

  for (const group of groups) {
    const missing = group.filter(file => !hasCurrentCache(file, cache));
    const filesToHash = [];
    for (const file of missing) {
      if (selectedFiles >= maxFiles) break;
      // The byte budget is a hard per-run I/O ceiling. A large group can make
      // progress across runs, while a single file larger than the entire
      // budget stays explicitly oversized until an operator raises the limit.
      if (file.size > maxBytes || selectedBytes + file.size > maxBytes) continue;
      filesToHash.push(file);
      selectedFiles++;
      selectedBytes += file.size;
    }
    if (filesToHash.length > 0) selected.push({ group, files: filesToHash });
  }
  return { groups, selected, maxBytes };
}

function summarizeHashGroups(groups, cache, maxBytes) {
  const result = {
    completeGroups: 0,
    partialGroups: 0,
    deferredGroups: 0,
    deferredFiles: 0,
    deferredBytes: 0,
    oversizedGroups: 0,
    oversizedFiles: 0,
    oversizedBytes: 0
  };
  for (const group of groups) {
    const current = group.filter(file => hasCurrentCache(file, cache)).length;
    const missing = group.length - current;
    if (missing === 0) {
      result.completeGroups++;
      continue;
    }
    result.deferredGroups++;
    result.deferredFiles += missing;
    result.deferredBytes += missing * group[0].size;
    if (current > 0) result.partialGroups++;
    const oversized = group.filter(file => (
      !hasCurrentCache(file, cache) && file.size > maxBytes
    ));
    if (oversized.length > 0) {
      result.oversizedGroups++;
      result.oversizedFiles += oversized.length;
      result.oversizedBytes += oversized.reduce((sum, file) => sum + file.size, 0);
    }
  }
  return result;
}

async function hashCandidates(scan, files, stats, source) {
  if (scan.hash_mode === 'none') return stats;
  const cache = await loadCache(source);
  const { groups, selected, maxBytes } = selectHashGroups(files, cache, scan);
  stats.candidate_groups = groups.length;
  stats.candidate_groups_selected = selected.length;
  let batch = [];

  for (const selection of selected) {
    for (const file of selection.files) {
      let sha256 = hasCurrentCache(file, cache) ? cache[file.path].sha256 : null;
      if (!sha256) {
        try {
          sha256 = await sha256File(file.hostPath);
          const after = await fsp.stat(file.hostPath);
          if (after.size !== file.size || Math.floor(after.mtimeMs / 1000) !== file.mtime) {
            stats.errors++;
            stats.hash_errors++;
            continue;
          }
          cache[file.path] = { fingerprint: fingerprint(file), sha256 };
          stats.hashed++;
          stats.hash_bytes += file.size;
        } catch (_) {
          stats.errors++;
          stats.hash_errors++;
          continue;
        }
      }
      batch.push({
        path: file.path,
        source_root: file.source_root,
        relative_path: file.relative_path,
        size: file.size,
        mtime: file.mtime,
        sha256,
        hash_strategy: 'native-agent-size-candidate'
      });
      if (batch.length >= BATCH_SIZE) {
        await postBatch(scan.scan_id, batch);
        batch = [];
      }
    }
  }
  await postBatch(scan.scan_id, batch);

  const evidenceProgress = summarizeHashGroups(groups, cache, maxBytes);
  stats.candidate_groups_complete = evidenceProgress.completeGroups;
  stats.candidate_groups_partial = evidenceProgress.partialGroups;
  stats.candidate_groups_deferred = evidenceProgress.deferredGroups;
  stats.candidate_files_deferred = evidenceProgress.deferredFiles;
  stats.candidate_bytes_deferred = evidenceProgress.deferredBytes;
  stats.candidate_groups_oversized = evidenceProgress.oversizedGroups;
  stats.candidate_files_oversized = evidenceProgress.oversizedFiles;
  stats.candidate_bytes_oversized = evidenceProgress.oversizedBytes;

  const currentPaths = new Set(files.map(file => file.path));
  for (const cachedPath of Object.keys(cache)) {
    if (!currentPaths.has(cachedPath)) delete cache[cachedPath];
  }
  await saveCache(source, cache);
  return stats;
}

async function serviceScan(scan, dependencies = {}) {
  const inventoryFiles = dependencies.inventory || inventory;
  const hashSelected = dependencies.hashCandidates || hashCandidates;
  const finish = dependencies.finishScan || finishScan;
  const startHeartbeat = dependencies.startHeartbeat || startScanHeartbeat;
  const config = SOURCES[scan.source];
  if (!config) throw new Error(`Scanner has no source configuration for ${scan.source}`);
  if (config.canonicalRoot && config.canonicalRoot !== scan.root) {
    throw new Error(`Canonical root mismatch for ${scan.source}`);
  }

  console.log(`[${ts()}] scan ${scan.scan_id} source=${scan.source} root=${config.hostPath}`);
  const heartbeat = startHeartbeat(scan.scan_id);
  try {
    const { files, stats } = await inventoryFiles(scan, config);
    await hashSelected(scan, files, stats, scan.source);
    const finalStatus = stats.metadata_errors > 0 ? 'partial' : 'completed';
    await finish(scan.scan_id, finalStatus, stats);
    console.log(`[${ts()}] scan ${scan.scan_id} ${finalStatus} files=${stats.files_seen} hashed=${stats.hashed}`);
    return { ok: true, status: finalStatus, stats };
  } catch (error) {
    console.error(`[${ts()}] scan ${scan.scan_id} failed: ${error.message}`);
    try { await finish(scan.scan_id, 'failed', { errors: 1 }); } catch (_) { /* best effort */ }
    return { ok: false, status: 'failed', error: error.message };
  } finally {
    heartbeat.stop();
  }
}

async function poll() {
  if (busy) return;
  busy = true;
  const query = new URLSearchParams({
    scannerId: SCANNER_ID,
    hostname: os.hostname(),
    platform: process.platform,
    agentVersion: VERSION,
    sources: SOURCE_IDS.join(',')
  });
  try {
    const data = await requestJson(`/api/v1/storage/agent/requests?${query}`);
    if (data.scan) await serviceScan(data.scan);
  } catch (error) {
    console.error(`[${ts()}] poll failed: ${error.message}`);
    if (process.env.STORAGE_AGENT_ONCE === '1') process.exitCode = 1;
  } finally {
    busy = false;
  }
}

function start() {
  console.log(`AgentX storage-agent ${VERSION} starting`, {
    DATA_URL, SCANNER_ID, sources: SOURCE_IDS, pollMs: POLL_MS, tokened: !!TOKEN
  });
  if (process.env.STORAGE_AGENT_ONCE === '1') {
    poll().finally(() => setTimeout(() => process.exit(process.exitCode || 0), 250).unref());
  } else {
    poll();
    setInterval(poll, POLL_MS);
  }
}

if (require.main === module) start();

module.exports = {
  VERSION,
  MAX_METADATA_PROBE_PATHS,
  MAX_CONTENT_PROBE_BYTES,
  defaultSources,
  isExcludedTopLevel,
  fingerprint,
  metadataProbePathSet,
  detectContentType,
  probeContentType,
  hasCurrentCache,
  selectHashGroups,
  summarizeHashGroups,
  requestJsonWithHttp,
  normalizedTerminalStatus,
  reconcileCompletion,
  finishScan,
  startScanHeartbeat,
  serviceScan,
  start
};
