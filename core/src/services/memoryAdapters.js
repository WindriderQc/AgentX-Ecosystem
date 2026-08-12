// Memory source adapters for buddy linkage (Phase 6f).
// Reads relevant chunks from Hermes' state.db (FTS5) and OpenClaw workspace .md files.

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { getRagServiceClient } = require('./ragServiceClient');
const { buildOpenClawAgentInventory } = require('./openclawAgentInventoryService');

const SQLITE_BIN = process.env.SQLITE_BIN || 'sqlite3';
const CHUNK_CHAR_CAP = 500;
const OPENCLAW_LIST_TTL_MS = 60_000;
const OPENCLAW_TOTAL_BYTES_CAP = 5 * 1024 * 1024;
const HERMES_DASHBOARD_TIMEOUT_MS = parseInt(process.env.HERMES_DASHBOARD_TIMEOUT_MS || '8000', 10);
const HERMES_MEMORY_SESSION_SCAN_LIMIT = parseInt(process.env.HERMES_MEMORY_SESSION_SCAN_LIMIT || '25', 10);
const HERMES_DASHBOARD_TOKEN_TTL_MS = 60_000;

let _openclawListCache = null;
let _hermesDashboardTokenCache = new Map();

function hermesHome() {
  return process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
}

function openclawHome() {
  return process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseEnvNumber(name) {
  const value = parseInt(process.env[name], 10);
  return Number.isFinite(value) ? value : null;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function uniqueNonEmpty(values) {
  return Array.from(new Set(values.filter(value => value !== null && value !== undefined && value !== '')));
}

async function pathInfo(p) {
  try {
    const stat = await fs.stat(p);
    return {
      path: p,
      exists: true,
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
      size: stat.size,
    };
  } catch (e) {
    return {
      path: p,
      exists: false,
      error: e.code || e.message,
    };
  }
}

function hermesDashboardUrl() {
  const raw = process.env.HERMES_DASHBOARD_URL || process.env.HERMES_PUBLIC_URL || '';
  return raw ? raw.replace(/\/+$/, '') : '';
}

function snippet(text) {
  if (typeof text !== 'string') return '';
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= CHUNK_CHAR_CAP) return t;
  return t.slice(0, CHUNK_CHAR_CAP) + '…';
}

// Sanitize a free-form query into FTS5-safe MATCH terms.
// Strip punctuation, keep alphanumerics + spaces, build prefix-or query.
function buildFtsMatch(query) {
  if (typeof query !== 'string') return null;
  const cleaned = query.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (!cleaned) return null;
  const terms = cleaned.split(/\s+/).filter(t => t.length >= 3).slice(0, 6);
  if (terms.length === 0) return null;
  return terms.map(t => `"${t}"*`).join(' OR ');
}

function fetchWithTimeout(url, opts = {}, timeoutMs = HERMES_DASHBOARD_TIMEOUT_MS) {
  const fetchFn = global.fetch;
  if (typeof fetchFn !== 'function') {
    return Promise.reject(new Error('fetch is not available in this runtime'));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchFn(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function extractHermesSessionToken(html) {
  if (typeof html !== 'string') return '';
  const match = html.match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/);
  return match ? match[1] : '';
}

async function getHermesDashboardToken(baseUrl) {
  const cached = _hermesDashboardTokenCache.get(baseUrl);
  if (cached && Date.now() - cached.at < HERMES_DASHBOARD_TOKEN_TTL_MS) {
    return cached.token;
  }
  const response = await fetchWithTimeout(`${baseUrl}/`, { headers: { Accept: 'text/html' } });
  if (!response.ok) throw new Error(`Hermes dashboard returned HTTP ${response.status}`);
  const token = extractHermesSessionToken(await response.text());
  if (!token) throw new Error('Hermes dashboard session token not found');
  _hermesDashboardTokenCache.set(baseUrl, { token, at: Date.now() });
  return token;
}

async function fetchHermesDashboardJson(baseUrl, apiPath) {
  const token = await getHermesDashboardToken(baseUrl);
  const response = await fetchWithTimeout(`${baseUrl}${apiPath}`, {
    headers: {
      Accept: 'application/json',
      'X-Hermes-Session-Token': token,
    },
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Hermes dashboard returned non-JSON for ${apiPath}`);
  }
  if (!response.ok) {
    throw new Error(json?.detail || json?.error || json?.message || `Hermes returned HTTP ${response.status}`);
  }
  return json;
}

async function listHermesDashboardSessions(baseUrl) {
  const data = await fetchHermesDashboardJson(baseUrl, '/api/sessions');
  return Array.isArray(data?.sessions) ? data.sessions : [];
}

async function fetchHermesDashboardMessages(baseUrl, sessionId) {
  const encoded = encodeURIComponent(sessionId);
  const data = await fetchHermesDashboardJson(baseUrl, `/api/sessions/${encoded}/messages`);
  return Array.isArray(data?.messages) ? data.messages : [];
}

function runSqliteJson(dbPath, sql) {
  return new Promise((resolve, reject) => {
    execFile(
      SQLITE_BIN,
      ['-readonly', '-json', dbPath, sql],
      { timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`sqlite3 error: ${err.message}`));
        if (!stdout || !stdout.trim()) return resolve([]);
        try {
          const rows = JSON.parse(stdout);
          resolve(Array.isArray(rows) ? rows : []);
        } catch (e) {
          reject(new Error(`sqlite3 json parse: ${e.message}`));
        }
      }
    );
  });
}

async function searchHermesDashboard(query, k) {
  const baseUrl = hermesDashboardUrl();
  if (!baseUrl) return [];
  const terms = extractTerms(query);
  if (terms.length === 0) return [];
  let sessions;
  try {
    sessions = await listHermesDashboardSessions(baseUrl);
  } catch (e) {
    console.warn('[memoryAdapters] hermes dashboard sessions failed:', e.message);
    return [];
  }

  const scanLimit = Math.max(1, Math.min(HERMES_MEMORY_SESSION_SCAN_LIMIT || 25, 100));
  const selected = sessions.slice(0, scanLimit).filter(s => s && s.id);
  const hits = [];
  await Promise.all(selected.map(async (session) => {
    let messages;
    try {
      messages = await fetchHermesDashboardMessages(baseUrl, session.id);
    } catch (e) {
      console.warn('[memoryAdapters] hermes dashboard messages failed:', e.message);
      return;
    }
    for (const message of messages) {
      const content = message && typeof message.content === 'string' ? message.content : '';
      const matchCount = countMatches(content, terms);
      if (matchCount === 0) continue;
      const when = message.created_at || message.createdAt || message.timestamp || session.updated_at || session.created_at;
      hits.push({
        source: 'hermes',
        text: snippet(content),
        score: matchCount + recencyBonus(when),
        ref: `hermes:${session.id}#${message.id || ''}`,
      });
    }
  }));
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, Math.max(1, Math.min(k, 20)));
}

async function searchHermesSqlite(query, k) {
  const dbPath = path.join(hermesHome(), 'state.db');
  try {
    await fs.access(dbPath);
  } catch (_) {
    return [];
  }
  const match = buildFtsMatch(query);
  if (!match) return [];
  const escaped = match.replace(/'/g, "''");
  const lim = Math.max(1, Math.min(k, 20));
  const sql = `SELECT m.id AS id, m.role AS role, m.content AS content, m.session_id AS sid, bm25(messages_fts) AS score `
    + `FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid `
    + `WHERE messages_fts MATCH '${escaped}' AND m.content IS NOT NULL AND length(m.content) > 0 `
    + `ORDER BY score ASC LIMIT ${lim};`;
  let rows;
  try {
    rows = await runSqliteJson(dbPath, sql);
  } catch (e) {
    console.warn('[memoryAdapters] hermes sqlite query failed:', e.message);
    return [];
  }
  return rows.map(r => ({
    source: 'hermes',
    text: snippet(r.content),
    score: typeof r.score === 'number' ? -r.score : 0,
    ref: `hermes:${r.sid || ''}#${r.id}`,
  }));
}

async function searchHermes(query, k) {
  const dashboardHits = await searchHermesDashboard(query, k);
  if (dashboardHits.length > 0) return dashboardHits;
  return searchHermesSqlite(query, k);
}

async function listOpenclawMdFiles() {
  const now = Date.now();
  if (_openclawListCache && (now - _openclawListCache.at) < OPENCLAW_LIST_TTL_MS) {
    return _openclawListCache.files;
  }
  const root = openclawHome();
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (_) {
    _openclawListCache = { at: now, files: [] };
    return [];
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name !== 'workspace' && !e.name.startsWith('workspace-')) continue;
    const ws = path.join(root, e.name);
    await walkMd(ws, out, OPENCLAW_TOTAL_BYTES_CAP);
    if (totalBytes(out) >= OPENCLAW_TOTAL_BYTES_CAP) break;
  }
  _openclawListCache = { at: now, files: out };
  return out;
}

function totalBytes(files) {
  let n = 0;
  for (const f of files) n += f.size || 0;
  return n;
}

async function walkMd(dir, out, capBytes) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (totalBytes(out) >= capBytes) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // skip noisy subdirs
      if (['node_modules', '.git', 'archive-disabled', 'logs', 'audio_cache', 'image_cache'].includes(e.name)) continue;
      await walkMd(p, out, capBytes);
    } else if (e.isFile() && /\.md$/i.test(e.name)) {
      let st;
      try { st = await fs.stat(p); } catch (_) { continue; }
      if (st.size > 256 * 1024) continue;
      out.push({ path: p, size: st.size });
    }
  }
}

async function searchOpenclaw(query, k) {
  if (typeof query !== 'string' || !query.trim()) return [];
  const terms = query.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/).filter(t => t.length >= 3).slice(0, 6);
  if (terms.length === 0) return [];

  let files;
  try {
    files = await listOpenclawMdFiles();
  } catch (e) {
    console.warn('[memoryAdapters] openclaw list failed:', e.message);
    return [];
  }

  const root = openclawHome();
  const hits = [];
  for (const f of files) {
    let raw;
    try { raw = await fs.readFile(f.path, 'utf8'); } catch (_) { continue; }
    const lower = raw.toLowerCase();
    let score = 0;
    let firstHit = -1;
    for (const t of terms) {
      let idx = lower.indexOf(t);
      if (idx === -1) continue;
      let count = 0;
      while (idx !== -1) { count += 1; idx = lower.indexOf(t, idx + t.length); }
      score += count;
      if (firstHit === -1 || lower.indexOf(t) < firstHit) firstHit = lower.indexOf(t);
    }
    if (score > 0) {
      const start = Math.max(0, firstHit - 80);
      const end = Math.min(raw.length, firstHit + 420);
      const text = snippet(raw.slice(start, end));
      const ref = path.relative(root, f.path);
      hits.push({ source: 'openclaw', text, score, ref: `openclaw:${ref}` });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, Math.max(1, Math.min(k, 20)));
}

// Phase 6g — AgentX memory adapter.
// Recency-weighted text match across core's own Mongoose collections.
// Read-only; errors in one collection must not break others.
const AGENTX_RECENCY_WEIGHT = 1.5;
const AGENTX_RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const AGENTX_BENCHMARK_RESPONSE_CAP = 240;

const AGENTX_FIELD_WEIGHTS = {
  conversation: {
    title: 3,
    'messages.content': 1,
  },
  alert: {
    title: 5,
    message: 4,
    ruleName: 3,
    severity: 2,
    status: 2,
    tags: 2,
    'context.component': 2,
    'context.metric': 3,
    'context.trend': 2,
  },
  activitylog: {
    action: 3,
    target: 2,
    errorMessage: 4,
    status: 2,
  },
  inferencelog: {
    model: 1.5,
    callerDetail: 3,
    taskType: 3,
    fallbackReason: 3,
    status: 2,
    error: 3,
  },
  benchmark: {
    model: 1.5,
    prompt: 1.2,
    task: 1.5,
    response: 0.15,
  },
};

const ALERT_INTENT_TERMS = new Set([
  'alert', 'alerts', 'incident', 'incidents', 'outage', 'critical', 'warning',
  'error', 'errors', 'failed', 'failure', 'timeout', 'latency', 'spike',
  'degraded', 'degradation', 'threshold', 'triggered', 'health', 'status',
]);
const BENCHMARK_INTENT_TERMS = new Set([
  'benchmark', 'benchmarks', 'leaderboard', 'score', 'scores', 'judge',
  'judged', 'batch', 'batches', 'prompt', 'throughput', 'tokens', 'tok',
  'composite', 'quality', 'level',
]);
const CHAT_INTENT_TERMS = new Set([
  'buddy', 'chat', 'persona', 'personality', 'conversation', 'conversations',
  'message', 'messages', 'reaction', 'react',
]);

function recencyBonus(date) {
  if (!date) return 0;
  const t = (date instanceof Date ? date : new Date(date)).getTime();
  if (!Number.isFinite(t)) return 0;
  const ageMs = Math.max(0, Date.now() - t);
  // Exponential decay; 1 week half-life. Recent docs get up to ~1.5 bonus.
  return AGENTX_RECENCY_WEIGHT * Math.exp(-ageMs / AGENTX_RECENCY_HALF_LIFE_MS);
}

function countMatches(haystack, terms) {
  if (typeof haystack !== 'string') return 0;
  const lower = haystack.toLowerCase();
  let total = 0;
  for (const t of terms) {
    let idx = lower.indexOf(t);
    while (idx !== -1) { total += 1; idx = lower.indexOf(t, idx + t.length); }
  }
  return total;
}

function extractTerms(query) {
  if (typeof query !== 'string') return [];
  return query.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/).filter(t => t.length >= 3).slice(0, 6);
}

function buildOrRegex(terms) {
  if (!terms.length) return null;
  const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('(' + escaped.join('|') + ')', 'i');
}

function classifyAgentxQuery(terms) {
  const has = (set) => terms.some(t => set.has(t));
  return {
    alertLike: has(ALERT_INTENT_TERMS),
    benchmarkLike: has(BENCHMARK_INTENT_TERMS),
    chatLike: has(CHAT_INTENT_TERMS),
  };
}

function collectionIntentMultiplier(refKey, intent) {
  if (intent.alertLike && !intent.benchmarkLike) {
    if (refKey === 'alert') return 2.6;
    if (refKey === 'activitylog') return 1.5;
    if (refKey === 'inferencelog') return 1.25;
    if (refKey === 'conversation') return 1.05;
    if (refKey === 'benchmark') return 0.18;
  }
  if (intent.benchmarkLike && !intent.alertLike) {
    if (refKey === 'benchmark') return 1.8;
    if (refKey === 'inferencelog') return 1.1;
    if (refKey === 'alert') return 0.75;
  }
  if (intent.chatLike) {
    if (refKey === 'conversation') return 1.8;
    if (refKey === 'inferencelog') return 1.4;
    if (refKey === 'benchmark') return 0.45;
  }
  if (refKey === 'benchmark') return 0.55;
  return 1;
}

function pluckValues(obj, dotted) {
  if (!dotted) return [];
  const parts = dotted.split('.');
  function walk(value, idx) {
    if (value == null) return [];
    if (idx >= parts.length) return [value];
    if (Array.isArray(value)) return value.flatMap(item => walk(item, idx));
    return walk(value[parts[idx]], idx + 1);
  }
  return walk(obj, 0);
}

function textValuesForField(doc, field) {
  const values = pluckValues(doc, field);
  const out = [];
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) out.push(value);
    else if (typeof value === 'number' || typeof value === 'boolean') out.push(String(value));
    else if (value instanceof Date) out.push(value.toISOString());
  }
  return out;
}

function fieldSnippetValue(text, field, refKey) {
  if (refKey === 'benchmark' && field === 'response' && text.length > AGENTX_BENCHMARK_RESPONSE_CAP) {
    return text.slice(0, AGENTX_BENCHMARK_RESPONSE_CAP) + '…';
  }
  return text;
}

// Convert a doc into snippet text by joining the most relevant string fields.
function docToText(doc, fields, refKey) {
  const parts = [];
  for (const f of fields) {
    for (const value of textValuesForField(doc, f)) {
      parts.push(fieldSnippetValue(value, f, refKey));
    }
  }
  return parts.join(' — ');
}

function scoreAgentxDoc(doc, fields, terms, refKey, intent, dateField) {
  const weights = AGENTX_FIELD_WEIGHTS[refKey] || {};
  let weightedMatches = 0;
  const matchedFields = [];
  for (const field of fields) {
    const values = textValuesForField(doc, field);
    if (values.length === 0) continue;
    let fieldMatches = 0;
    for (const value of values) {
      fieldMatches += countMatches(value, terms);
    }
    if (fieldMatches <= 0) continue;
    matchedFields.push(field);
    weightedMatches += fieldMatches * (weights[field] || 1);
  }
  if (weightedMatches <= 0) return null;
  const when = doc[dateField] || doc.updatedAt || doc.createdAt || doc.timestamp;
  const score = (weightedMatches * collectionIntentMultiplier(refKey, intent)) + recencyBonus(when);
  return { score, matchedFields, when };
}

async function searchAgentxCollection({ Model, fields, dateField = 'updatedAt', terms, regex, intent, k, source, refKey }) {
  if (!Model) return [];
  // Build $or across fields with the regex.
  const or = fields.map(f => ({ [f]: regex }));
  const projection = {};
  fields.forEach(f => { projection[f] = 1; });
  projection[dateField] = 1;
  projection.createdAt = 1;
  projection.updatedAt = 1;

  let docs;
  try {
    docs = await Model.find({ $or: or }, projection)
      .sort({ [dateField]: -1 })
      .limit(Math.max(20, k * 4))
      .lean();
  } catch (e) {
    console.warn(`[memoryAdapters/agentx] ${refKey} query failed:`, e.message);
    return [];
  }

  const out = [];
  for (const d of docs) {
    const scored = scoreAgentxDoc(d, fields, terms, refKey, intent, dateField);
    if (!scored) continue;
    const text = docToText(d, fields, refKey);
    out.push({
      source,
      text: snippet(text),
      score: scored.score,
      ref: `${refKey}:${d._id}`,
      collection: refKey,
      matchedFields: scored.matchedFields,
      when: scored.when || null,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, k);
}

async function searchAgentx(query, k) {
  const terms = extractTerms(query);
  if (terms.length === 0) return [];
  const regex = buildOrRegex(terms);
  if (!regex) return [];
  const intent = classifyAgentxQuery(terms);

  // Lazy-require models so tests that don't need them don't pay the cost
  // and so a missing model file (benchmark service collection) degrades gracefully.
  const targets = [];

  function tryLoad(modelPath, fields, dateField, refKey) {
    try {
      const Model = require(modelPath);
      if (Model) targets.push({ Model, fields, dateField, refKey });
    } catch (e) {
      console.warn(`[memoryAdapters/agentx] could not load ${modelPath}:`, e.message);
    }
  }

  tryLoad('../../models/Conversation', ['title', 'messages.content'], 'updatedAt', 'conversation');
  tryLoad('../../models/Alert', ['title', 'message', 'ruleName', 'severity', 'status', 'tags', 'context.component', 'context.metric', 'context.trend'], 'lastOccurrence', 'alert');
  tryLoad('../../models/ActivityLog', ['action', 'target', 'errorMessage', 'status'], 'timestamp', 'activitylog');
  tryLoad('../../models/InferenceLog', ['model', 'callerDetail', 'taskType', 'fallbackReason', 'status', 'error'], 'createdAt', 'inferencelog');

  // BenchmarkResult — read-only access; if the schema isn't registered, skip.
  try {
    const mongoose = require('mongoose');
    let BR;
    try { BR = require('../../models/BenchmarkResult'); } catch {
      BR = mongoose.models.BenchmarkResult;
    }
    if (BR) targets.push({
      Model: BR,
      fields: ['model', 'prompt', 'response', 'task'],
      dateField: 'createdAt',
      refKey: 'benchmark',
    });
  } catch (e) {
    console.warn('[memoryAdapters/agentx] benchmark result load skipped:', e.message);
  }

  const tasks = targets.map(t => searchAgentxCollection({
    Model: t.Model,
    fields: t.fields,
    dateField: t.dateField,
    terms,
    regex,
    intent,
    k,
    source: 'agentx',
    refKey: t.refKey,
  }).catch(e => {
    console.warn(`[memoryAdapters/agentx] ${t.refKey} unhandled:`, e.message);
    return [];
  }));
  const results = await Promise.all(tasks);
  const flat = results.flat();
  flat.sort((a, b) => b.score - a.score);
  return flat.slice(0, 2 * k);
}

function openclawInventoryStatusEnabled() {
  const mode = String(process.env.OPENCLAW_MEMORY_STATUS_SOURCE || '').trim().toLowerCase();
  return Boolean(
    process.env.OPENCLAW_INVENTORY_SSH_TARGET
    || ['inventory', 'live', 'remote'].includes(mode)
  );
}

function commonValue(values) {
  const unique = uniqueNonEmpty(values);
  return unique.length === 1 ? unique[0] : null;
}

function summarizeOpenclawInventory(inventory = {}) {
  const agents = safeArray(inventory.agents).map((agent) => {
    const memory = agent.memory || {};
    const issues = safeArray(memory.issues);
    return {
      id: agent.id || null,
      name: agent.name || agent.id || null,
      active: agent.active !== false,
      workspace: agent.workspace || null,
      provider: memory.provider || null,
      model: memory.model || null,
      vectorDims: memory.vectorDims ?? null,
      files: memory.files ?? null,
      chunks: memory.chunks ?? null,
      dirty: Boolean(memory.dirty),
      indexStatus: memory.indexStatus || null,
      issueCount: issues.length,
      issues: issues.slice(0, 5),
    };
  }).filter(agent => agent.id);

  const modelOptions = uniqueNonEmpty(agents.map(agent => agent.model));
  const providerOptions = uniqueNonEmpty(agents.map(agent => agent.provider));
  const vectorDimOptions = uniqueNonEmpty(agents.map(agent => agent.vectorDims));
  const statusCounts = {};
  for (const agent of agents) {
    const status = agent.indexStatus || 'unknown';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }

  return {
    source: 'openclaw',
    available: agents.length > 0,
    sourceDetail: 'inventory',
    lane: 'private-runtime',
    shared: false,
    home: inventory.source?.openclawHome || null,
    inventory: {
      generatedAt: inventory.generated_at || null,
      memoryStatusSource: inventory.source?.memoryStatusSource || null,
      degraded: Boolean(inventory.source?.degraded),
      issues: safeArray(inventory.source?.issues),
    },
    memory: {
      provider: commonValue(agents.map(agent => agent.provider)) || inventory.memory_strategy?.provider || null,
      model: commonValue(agents.map(agent => agent.model)) || inventory.memory_strategy?.model || null,
      vectorDims: commonValue(agents.map(agent => agent.vectorDims)),
      providerOptions,
      modelOptions,
      vectorDimOptions,
      strategy: inventory.memory_strategy || null,
    },
    agentCount: agents.length,
    indexedAgentCount: agents.filter(agent => (
      agent.indexStatus === 'valid'
      || agent.vectorDims !== null
      || Number(agent.files || 0) > 0
      || Number(agent.chunks || 0) > 0
    )).length,
    validIndexCount: agents.filter(agent => agent.indexStatus === 'valid').length,
    dirtyIndexCount: agents.filter(agent => agent.dirty).length,
    missingIndexCount: agents.filter(agent => ['missing', 'unavailable'].includes(agent.indexStatus)).length,
    indexStatusCounts: statusCounts,
    agents,
  };
}

async function statusOpenclawFromInventory() {
  if (!openclawInventoryStatusEnabled()) return null;
  const budgetMs = parseEnvNumber('OPENCLAW_MEMORY_STATUS_TIMEOUT_MS') || 5000;
  const commandTimeoutMs = Math.min(
    parseEnvNumber('OPENCLAW_MEMORY_STATUS_COMMAND_TIMEOUT_MS') || 2500,
    budgetMs
  );
  const inventory = await withTimeout(
    buildOpenClawAgentInventory({
      includeContent: false,
      includeRuntimeStatus: false,
      includePromptFiles: false,
      commandTimeoutMs,
    }),
    budgetMs,
    'OpenClaw inventory status'
  );
  return summarizeOpenclawInventory(inventory);
}

async function statusOpenclawLocal(liveInventoryError = null) {
  const home = openclawHome();
  try {
    const files = await listOpenclawMdFiles();
    const workspaces = new Set();
    for (const f of files) {
      const rel = path.relative(home, f.path);
      const top = rel.split(path.sep)[0];
      if (top && (top === 'workspace' || top.startsWith('workspace-'))) workspaces.add(top);
    }
    const homeStatus = await pathInfo(home);
    const status = {
      source: 'openclaw',
      available: workspaces.size > 0,
      sourceDetail: 'local-markdown',
      lane: 'private-runtime',
      shared: false,
      home,
      homeStatus,
      fileCount: files.length,
      workspaceCount: workspaces.size,
      workspaceRoots: Array.from(workspaces).sort(),
    };
    if (liveInventoryError) status.liveInventoryError = liveInventoryError;
    return status;
  } catch (e) {
    const status = {
      source: 'openclaw',
      available: false,
      sourceDetail: 'local-markdown',
      lane: 'private-runtime',
      shared: false,
      home,
      homeStatus: await pathInfo(home),
      error: e.message,
    };
    if (liveInventoryError) status.liveInventoryError = liveInventoryError;
    return status;
  }
}

function normalizeRagStatus(raw = {}) {
  const embedding = raw.dependencies?.embedding || {};
  const vectorStore = raw.vectorStore || raw.dependencies?.qdrant || {};
  return {
    source: 'agentx-rag',
    available: raw.healthy !== false && (raw.status === 'green' || raw.vectorStore?.healthy !== false || raw.healthy === true),
    lane: 'shared-rag',
    shared: true,
    status: raw.status || null,
    embeddingModel: raw.embeddingModel || embedding.model || process.env.EMBEDDING_MODEL || null,
    vectorDimension: raw.vectorDimension ?? embedding.dimension ?? parseEnvNumber('EMBEDDING_DIMENSION'),
    vectorStoreType: raw.vectorStore?.type || process.env.VECTOR_STORE_TYPE || null,
    documentCount: raw.documentCount ?? null,
    chunkCount: raw.chunkCount ?? null,
    dependencies: {
      embedding: {
        healthy: embedding.healthy ?? null,
        provider: embedding.provider || null,
        model: embedding.model || null,
        dimension: embedding.dimension ?? null,
      },
      vectorStore: {
        healthy: vectorStore.healthy ?? null,
        url: raw.vectorStore?.url || vectorStore.url || null,
      },
    },
  };
}

async function getAgentxSharedRagStatus() {
  try {
    const raw = await getRagServiceClient().getStatus();
    return normalizeRagStatus(raw);
  } catch (e) {
    return {
      source: 'agentx-rag',
      available: false,
      lane: 'shared-rag',
      shared: true,
      embeddingModel: process.env.EMBEDDING_MODEL || null,
      vectorDimension: parseEnvNumber('EMBEDDING_DIMENSION'),
      vectorStoreType: process.env.VECTOR_STORE_TYPE || null,
      error: e.message,
    };
  }
}

function buildAlignmentWarnings(sharedRag, hermesStatus, openclawStatus) {
  const warnings = [];
  if (!sharedRag.available) {
    warnings.push({
      code: 'agentx_rag_unavailable',
      severity: 'warning',
      message: 'AgentX shared RAG is unavailable; cross-service shared memory should not ingest new vectors until it is healthy.',
    });
  }
  if (!hermesStatus.available) {
    warnings.push({
      code: 'hermes_memory_unavailable',
      severity: 'info',
      message: 'Hermes runtime memory is unavailable to Buddy; this does not block AgentX shared RAG.',
    });
  }
  if (!openclawStatus.available) {
    warnings.push({
      code: 'openclaw_memory_unavailable',
      severity: 'info',
      message: 'OpenClaw runtime memory is unavailable to Buddy; configure OPENCLAW_INVENTORY_SSH_TARGET for live status or mount OPENCLAW_HOME for local Markdown search.',
    });
  }

  const sharedDim = sharedRag.vectorDimension;
  const openclawDims = openclawStatus.memory?.vectorDimOptions || [];
  if (sharedDim && openclawDims.length > 0 && !openclawDims.every(dim => dim === sharedDim)) {
    warnings.push({
      code: 'private_openclaw_dimension_differs',
      severity: 'info',
      message: 'OpenClaw private memory uses a different embedding dimension than AgentX shared RAG; keep vector stores separate unless re-embedding into a single collection.',
      sharedDimension: sharedDim,
      openclawDimensions: openclawDims,
    });
  }
  return warnings;
}

async function getEcosystemMemoryAlignmentStatus() {
  const [sharedRag, hermesStatus, openclawStatus] = await Promise.all([
    getAgentxSharedRagStatus(),
    statusForSource('hermes'),
    statusForSource('openclaw'),
  ]);
  const openclawDims = openclawStatus.memory?.vectorDimOptions || [];
  const sharedDim = sharedRag.vectorDimension;
  return {
    generatedAt: new Date().toISOString(),
    policy: {
      sharedMemoryLane: 'agentx-rag',
      privateRuntimeLanes: ['hermes', 'openclaw'],
      embeddingUniformity: 'required within each vector collection; cross-lane private memories may use different models',
      sharedVectorStoreRule: 'never mix embeddings with different dimensions in the same vector collection',
    },
    shared: {
      rag: sharedRag,
    },
    private: {
      hermes: hermesStatus,
      openclaw: openclawStatus,
    },
    compatibility: {
      sharedRagToOpenclawVectors: sharedDim && openclawDims.length > 0
        ? openclawDims.every(dim => dim === sharedDim)
        : null,
      sharedDimension: sharedDim ?? null,
      openclawVectorDimensions: openclawDims,
    },
    warnings: buildAlignmentWarnings(sharedRag, hermesStatus, openclawStatus),
  };
}

// Cheap status snapshots per source for the viewer card.
async function statusForSource(source) {
  if (source === 'hermes') {
    const dashboardUrl = hermesDashboardUrl();
    const home = hermesHome();
    const dbPath = path.join(home, 'state.db');
    const notesPath = path.join(home, 'buddy.md');
    const base = {
      source: 'hermes',
      lane: 'private-runtime',
      shared: false,
      home,
      dbPath,
      notesPath,
    };
    if (dashboardUrl) {
      try {
        const sessions = await listHermesDashboardSessions(dashboardUrl);
        return {
          ...base,
          available: true,
          sourceDetail: 'dashboard',
          dashboardUrl,
          sessionCount: sessions.length,
        };
      } catch (e) {
        console.warn('[memoryAdapters] hermes dashboard status failed:', e.message);
        base.dashboardUrl = dashboardUrl;
        base.dashboardError = e.message;
      }
    }

    try {
      await fs.access(dbPath);
      const stat = await fs.stat(dbPath);
      let count = null;
      try {
        const rows = await runSqliteJson(dbPath, 'SELECT COUNT(*) AS n FROM messages;');
        count = rows && rows[0] ? rows[0].n : null;
      } catch (_) { /* ignore */ }
      return { ...base, available: true, sourceDetail: 'sqlite', dbSize: stat.size, messageCount: count };
    } catch (e) {
      return {
        ...base,
        available: false,
        sourceDetail: dashboardUrl ? 'dashboard+sqlite' : 'sqlite',
        reason: e.code || e.message,
      };
    }
  }
  if (source === 'openclaw') {
    try {
      const inventoryStatus = await statusOpenclawFromInventory();
      if (inventoryStatus) return inventoryStatus;
    } catch (e) {
      return statusOpenclawLocal(e.message);
    }
    return statusOpenclawLocal();
  }
  if (source === 'agentx') {
    const out = {
      source: 'agentx',
      available: true,
      lane: 'core-mongo',
      shared: false,
      counts: {},
    };
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const targets = [
      { path: '../../models/Conversation', name: 'conversations', dateField: 'updatedAt' },
      { path: '../../models/Alert', name: 'alerts', dateField: 'lastOccurrence' },
      { path: '../../models/ActivityLog', name: 'activitylogs', dateField: 'timestamp' },
      { path: '../../models/InferenceLog', name: 'inferencelogs', dateField: 'createdAt' },
    ];
    for (const t of targets) {
      try {
        const Model = require(t.path);
        const total = await Model.countDocuments({});
        const recent = await Model.countDocuments({ [t.dateField]: { $gte: since7d } });
        out.counts[t.name] = { total, last7d: recent };
      } catch (e) {
        out.counts[t.name] = { error: e.message };
      }
    }
    return out;
  }
  return { source, available: false, error: 'unknown source' };
}

async function searchMemory(opts) {
  const { sources, query, k } = opts || {};
  const k_ = Math.max(1, Math.min(parseInt(k, 10) || 5, 20));
  if (!Array.isArray(sources) || sources.length === 0) return [];
  if (typeof query !== 'string' || !query.trim()) return [];

  const tasks = [];
  if (sources.includes('hermes')) tasks.push(searchHermes(query, k_).catch(e => { console.warn('[memoryAdapters] hermes failed:', e.message); return []; }));
  if (sources.includes('openclaw')) tasks.push(searchOpenclaw(query, k_).catch(e => { console.warn('[memoryAdapters] openclaw failed:', e.message); return []; }));
  if (sources.includes('agentx')) tasks.push(searchAgentx(query, k_).catch(e => { console.warn('[memoryAdapters] agentx failed:', e.message); return []; }));

  const results = await Promise.all(tasks);
  // Cap combined chunks at 2*k.
  const flat = results.flat();
  return flat.slice(0, 2 * k_);
}

// Single-source search used by /api/buddy/memory/search.
async function searchSingle(source, query, k) {
  const k_ = Math.max(1, Math.min(parseInt(k, 10) || 5, 20));
  if (typeof query !== 'string' || !query.trim()) return [];
  if (source === 'hermes') return searchHermes(query, k_);
  if (source === 'openclaw') return searchOpenclaw(query, k_);
  if (source === 'agentx') return searchAgentx(query, k_);
  return [];
}

function _resetCacheForTests() {
  _openclawListCache = null;
  _hermesDashboardTokenCache = new Map();
}

module.exports = {
  searchMemory,
  searchSingle,
  searchHermes,
  searchOpenclaw,
  searchAgentx,
  statusForSource,
  getEcosystemMemoryAlignmentStatus,
  buildFtsMatch,
  hermesHome,
  openclawHome,
  _resetCacheForTests,
};
