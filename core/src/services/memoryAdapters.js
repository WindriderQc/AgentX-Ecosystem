'use strict';

// Product-owned, read-only memory adapters. AgentX Core can inspect its own
// collections and the AgentX RAG service; private runtime memories are outside
// this repository's trust boundary.

const { getRagServiceClient } = require('./ragServiceClient');

const CHUNK_CHAR_CAP = 500;
const RECENCY_WEIGHT = 1.5;
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
const FIELD_WEIGHTS = {
  conversation: { title: 3, 'messages.content': 1 },
  alert: {
    title: 5, message: 4, ruleName: 3, severity: 2, status: 2, tags: 2,
    'context.component': 2, 'context.metric': 3, 'context.trend': 2,
  },
  activitylog: { action: 3, target: 2, errorMessage: 4, status: 2 },
  inferencelog: { model: 1.5, callerDetail: 3, taskType: 3, fallbackReason: 3, status: 2, error: 3 },
};
const ALERT_TERMS = new Set([
  'alert', 'alerts', 'incident', 'incidents', 'outage', 'critical', 'warning',
  'error', 'errors', 'failed', 'failure', 'timeout', 'latency', 'spike',
  'degraded', 'degradation', 'threshold', 'triggered', 'health', 'status',
]);
const BENCHMARK_TERMS = new Set([
  'benchmark', 'benchmarks', 'leaderboard', 'score', 'scores', 'judge', 'judged',
  'batch', 'batches', 'prompt', 'throughput', 'tokens', 'tok', 'composite', 'quality', 'level',
]);
const CHAT_TERMS = new Set([
  'buddy', 'chat', 'persona', 'personality', 'conversation', 'conversations',
  'message', 'messages', 'reaction', 'react',
]);

function boundedK(value) {
  return Math.max(1, Math.min(parseInt(value, 10) || 5, 20));
}

function snippet(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return normalized.length <= CHUNK_CHAR_CAP
    ? normalized
    : `${normalized.slice(0, CHUNK_CHAR_CAP)}…`;
}

function extractTerms(query) {
  if (typeof query !== 'string') return [];
  return query.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/).filter((term) => term.length >= 3).slice(0, 6);
}

function buildOrRegex(terms) {
  if (!terms.length) return null;
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(${escaped.join('|')})`, 'i');
}

function classifyQuery(terms) {
  const has = (set) => terms.some((term) => set.has(term));
  return { alertLike: has(ALERT_TERMS), benchmarkLike: has(BENCHMARK_TERMS), chatLike: has(CHAT_TERMS) };
}

function collectionMultiplier(collection, intent) {
  if (intent.alertLike && !intent.benchmarkLike) {
    return { alert: 2.6, activitylog: 1.5, inferencelog: 1.25, conversation: 1.05 }[collection] || 1;
  }
  if (intent.benchmarkLike && !intent.alertLike) {
    return { inferencelog: 1.1, alert: 0.75 }[collection] || 1;
  }
  if (intent.chatLike) {
    return { conversation: 1.8, inferencelog: 1.4 }[collection] || 1;
  }
  return 1;
}

function valuesAtPath(value, dottedPath) {
  const parts = dottedPath.split('.');
  function walk(current, index) {
    if (current == null) return [];
    if (index >= parts.length) return [current];
    if (Array.isArray(current)) return current.flatMap((item) => walk(item, index));
    return walk(current[parts[index]], index + 1);
  }
  return walk(value, 0);
}

function textValues(document, field) {
  return valuesAtPath(document, field).flatMap((value) => {
    if (typeof value === 'string' && value.trim()) return [value];
    if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
    if (value instanceof Date) return [value.toISOString()];
    return [];
  });
}

function countMatches(text, terms) {
  const lower = String(text || '').toLowerCase();
  return terms.reduce((total, term) => {
    let count = 0;
    let index = lower.indexOf(term);
    while (index !== -1) {
      count += 1;
      index = lower.indexOf(term, index + term.length);
    }
    return total + count;
  }, 0);
}

function recencyBonus(date) {
  const timestamp = date instanceof Date ? date.getTime() : new Date(date || 0).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  return RECENCY_WEIGHT * Math.exp(-Math.max(0, Date.now() - timestamp) / RECENCY_HALF_LIFE_MS);
}

function scoreDocument(document, fields, terms, collection, intent, dateField) {
  const weights = FIELD_WEIGHTS[collection] || {};
  let weightedMatches = 0;
  const matchedFields = [];
  for (const field of fields) {
    const matches = textValues(document, field)
      .reduce((total, value) => total + countMatches(value, terms), 0);
    if (!matches) continue;
    matchedFields.push(field);
    weightedMatches += matches * (weights[field] || 1);
  }
  if (!weightedMatches) return null;
  const when = document[dateField] || document.updatedAt || document.createdAt || document.timestamp;
  return {
    score: weightedMatches * collectionMultiplier(collection, intent) + recencyBonus(when),
    matchedFields,
    when,
  };
}

function documentText(document, fields, collection) {
  const values = [];
  for (const field of fields) {
    for (const value of textValues(document, field)) {
      values.push(value);
    }
  }
  return values.join(' — ');
}

async function searchCollection({ Model, fields, dateField, terms, regex, intent, k, collection }) {
  if (!Model) return [];
  const projection = { createdAt: 1, updatedAt: 1, [dateField]: 1 };
  for (const field of fields) projection[field] = 1;
  let documents;
  try {
    documents = await Model.find({ $or: fields.map((field) => ({ [field]: regex })) }, projection)
      .sort({ [dateField]: -1 }).limit(Math.max(20, k * 4)).lean();
  } catch (error) {
    console.warn(`[memoryAdapters/agentx] ${collection} query failed:`, error.message);
    return [];
  }
  return documents.map((document) => {
    const scored = scoreDocument(document, fields, terms, collection, intent, dateField);
    if (!scored) return null;
    return {
      source: 'agentx',
      text: snippet(documentText(document, fields, collection)),
      score: scored.score,
      ref: `${collection}:${document._id}`,
      collection,
      matchedFields: scored.matchedFields,
      when: scored.when || null,
    };
  }).filter(Boolean).sort((left, right) => right.score - left.score).slice(0, k);
}

function searchTargets() {
  const targets = [];
  function add(modelPath, fields, dateField, collection) {
    try {
      const Model = require(modelPath);
      if (Model) targets.push({ Model, fields, dateField, collection });
    } catch (error) {
      console.warn(`[memoryAdapters/agentx] could not load ${modelPath}:`, error.message);
    }
  }
  add('../../models/Conversation', ['title', 'messages.content'], 'updatedAt', 'conversation');
  add('../../models/Alert', ['title', 'message', 'ruleName', 'severity', 'status', 'tags', 'context.component', 'context.metric', 'context.trend'], 'lastOccurrence', 'alert');
  add('../../models/ActivityLog', ['action', 'target', 'errorMessage', 'status'], 'timestamp', 'activitylog');
  add('../../models/InferenceLog', ['model', 'callerDetail', 'taskType', 'fallbackReason', 'status', 'error'], 'createdAt', 'inferencelog');
  return targets;
}

async function searchAgentx(query, k = 5) {
  const terms = extractTerms(query);
  const regex = buildOrRegex(terms);
  if (!regex) return [];
  const limit = boundedK(k);
  const intent = classifyQuery(terms);
  const results = await Promise.all(searchTargets().map((target) => searchCollection({
    ...target, terms, regex, intent, k: limit,
  })));
  return results.flat().sort((left, right) => right.score - left.score).slice(0, 2 * limit);
}

async function agentxStatus() {
  const status = { source: 'agentx', available: true, lane: 'core-mongo', shared: false, counts: {} };
  let unavailableCollections = 0;
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const targets = [
    ['../../models/Conversation', 'conversations', 'updatedAt'],
    ['../../models/Alert', 'alerts', 'lastOccurrence'],
    ['../../models/ActivityLog', 'activitylogs', 'timestamp'],
    ['../../models/InferenceLog', 'inferencelogs', 'createdAt'],
  ];
  for (const [modelPath, name, dateField] of targets) {
    try {
      const Model = require(modelPath);
      status.counts[name] = {
        total: await Model.countDocuments({}),
        last7d: await Model.countDocuments({ [dateField]: { $gte: since7d } }),
      };
    } catch (error) {
      unavailableCollections += 1;
      status.counts[name] = { error: error.message };
    }
  }
  if (unavailableCollections > 0) {
    status.available = false;
    status.error = `${unavailableCollections} Core memory collection${unavailableCollections === 1 ? '' : 's'} unavailable`;
  }
  return status;
}

async function ragStatus() {
  try {
    const raw = await getRagServiceClient().getStatus();
    return {
      source: 'agentx-rag',
      available: raw?.healthy !== false,
      lane: 'shared-rag',
      shared: true,
      ...raw,
    };
  } catch (error) {
    return { source: 'agentx-rag', available: false, lane: 'shared-rag', shared: true, error: error.message };
  }
}

async function getEcosystemMemoryAlignmentStatus() {
  const [core, rag] = await Promise.all([agentxStatus(), ragStatus()]);
  return {
    generatedAt: new Date().toISOString(),
    policy: {
      localMemoryLane: 'agentx',
      sharedMemoryLane: 'agentx-rag',
      externalRuntimeMemories: 'outside-product-boundary',
    },
    local: { core },
    shared: { rag },
    warnings: rag.available ? [] : [{
      code: 'agentx_rag_unavailable',
      severity: 'warning',
      message: 'AgentX shared RAG is unavailable.',
    }],
  };
}

async function statusForSource(source) {
  if (source === 'agentx') return agentxStatus();
  if (source === 'rag') return ragStatus();
  return { source, available: false, error: 'unknown source' };
}

async function searchSingle(source, query, k) {
  if (typeof query !== 'string' || !query.trim()) return [];
  if (source === 'agentx') return searchAgentx(query, boundedK(k));
  if (source === 'rag') {
    return getRagServiceClient().searchSimilarChunks(query, { topK: boundedK(k) });
  }
  return [];
}

async function searchMemory(options = {}) {
  const sources = Array.isArray(options.sources) ? options.sources : [];
  if (!sources.length || typeof options.query !== 'string' || !options.query.trim()) return [];
  const limit = boundedK(options.k);
  const results = await Promise.all(sources.map((source) => searchSingle(source, options.query, limit)
    .catch((error) => {
      console.warn(`[memoryAdapters] ${source} failed:`, error.message);
      return [];
    })));
  return results.flat().slice(0, 2 * limit);
}

module.exports = {
  searchMemory,
  searchSingle,
  searchAgentx,
  statusForSource,
  getEcosystemMemoryAlignmentStatus,
};
