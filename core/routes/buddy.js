const express = require('express');
const router = express.Router();
const { getConfiguredHosts } = require('../src/helpers/ollamaHostConfig');
const Buddy = require('../models/Buddy');
const { bus: buddyBus, emit: emitBuddyEvent } = require('../src/services/buddyEvents');
const envelope = require('../src/helpers/responseEnvelope');
const buddyPersonalityModule = require('../src/services/buddyPersonality');
const buildServerPersonalityPrompt = buddyPersonalityModule.buildPersonalityPrompt;
const {
  searchMemory,
  searchSingle,
  statusForSource,
  getEcosystemMemoryAlignmentStatus,
} = require('../src/services/memoryAdapters');
const personalityAdapters = require('../src/services/personalityAdapters');
const buddyRouting = require('../src/services/buddyRouting');
const buddyNotesFile = require('../src/services/buddyNotesFile');
const { saveMemory, assertMemoryText, NestorMemoryError } = require('../src/services/nestorMemoryService');
const { platformEventIngress } = require('../src/services/platformEventIngress');

// ── Dedup guard for /react — prevent same seed from hammering LLM ──
const REACT_DEDUP_MS = 8000;
const REACT_DEDUP_EXPIRY = 5 * 60 * 1000;
const _reactTimestamps = new Map();

// ── React timeout (task 0141) ──
// Real cold-load + contested-host LLM calls regularly exceed 15s.
// Default 30s; floor 5s; overridable via env for tuning.
const BUDDY_REACT_TIMEOUT_MS = Math.max(
  5000,
  parseInt(process.env.BUDDY_REACT_TIMEOUT_MS, 10) || 30000
);

// Sweep expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of _reactTimestamps) {
    if (now - ts > REACT_DEDUP_EXPIRY) _reactTimestamps.delete(key);
  }
}, REACT_DEDUP_EXPIRY).unref();

const MILESTONES = [
  { id: 'first_words', name: 'First Words', check: (b) => b.totalReactions >= 1 },
  { id: 'chatterbox', name: 'Chatterbox', check: (b) => b.totalReactions >= 100 },
  { id: 'beloved', name: 'Beloved', check: (b) => b.totalPets >= 50 },
  { id: 'survivor', name: 'Cluster Survivor', check: (b) => b.moodHistory.some(e => e.type === 'alert_critical') },
  { id: 'night_owl', name: 'Night Owl', check: (b) => b.moodHistory.some(e => new Date(e.timestamp).getHours() < 5) },
  { id: 'polyglot', name: 'Polyglot', check: (b) => b.modelsUsed.length >= 3 },
  { id: 'wise_one', name: 'Wise One', check: (b) => b.stats.WISDOM >= 75 },
  { id: 'debug_master', name: 'Debug Master', check: (b) => b.stats.DEBUGGING >= 75 },
  { id: 'chaos_agent', name: 'Chaos Agent', check: (b) => b.stats.CHAOS >= 75 },
];

function computeMood(history) {
  if (!history || history.length === 0) return 'neutral';
  const recent = history.slice(-10);
  const counts = {};
  recent.forEach(e => { counts[e.type] = (counts[e.type] || 0) + 1; });
  if ((counts.error || 0) + (counts.alert_critical || 0) >= 3) return 'stressed';
  if ((counts.success || 0) + (counts.message_received || 0) >= 4) return 'happy';
  if ((counts.idle || 0) >= 5) return 'sleepy';
  if ((counts.pet || 0) >= 2) return 'loved';
  return 'neutral';
}

function checkMilestones(buddy) {
  const newMs = [];
  const existing = buddy.milestones.map(m => m.id);
  MILESTONES.forEach(ms => {
    if (!existing.includes(ms.id) && ms.check(buddy)) {
      newMs.push({ id: ms.id, name: ms.name, unlockedAt: new Date() });
    }
  });
  return newMs;
}

function inferenceModelMeta(proxyRes, requestedHost, requestedModel) {
  const resolvedHost = proxyRes?.headers?.get?.('x-routed-host') || '';
  const resolvedModel = proxyRes?.headers?.get?.('x-resolved-model') || '';
  return {
    host: resolvedHost || requestedHost || '',
    model: resolvedModel || requestedModel || '',
    requestedHost: requestedHost || '',
    requestedModel: requestedModel || '',
    routingSource: proxyRes?.headers?.get?.('x-routing-source') || '',
    lane: proxyRes?.headers?.get?.('x-inference-lane') || ''
  };
}

/**
 * POST /api/buddy/emit
 * Temporary Nestor v0.2.7 compatibility alias for POST /api/platform-events.
 * New AgentX producers must use the generic platform endpoint.
 *
 * Trust boundary (task 0277): accepted when the caller is loopback OR
 * (when BUDDY_EMIT_TOKEN is set) presents a matching X-Buddy-Emit-Token
 * header. In Docker the services are separate containers, so loopback
 * alone rejects cross-container emits (benchmark/rag -> core = 403); the
 * shared-secret token is the explicit, opt-in widening for that case.
 * If BUDDY_EMIT_TOKEN is unset the behavior is unchanged — loopback-only,
 * no silent widening. We do NOT widen to arbitrary IP ranges: Docker
 * Desktop NATs LAN traffic to the bridge gateway, so an IP-range allow
 * would re-expose the spoofing surface this guard exists to close.
 * Without auth in front, this guard is what prevents arbitrary callers
 * from spoofing platform events.
 */
router.post('/emit', platformEventIngress);

/**
 * GET /api/buddy/events/stream
 * SSE stream of platform events for cross-page buddy awareness.
 */
router.get('/events/stream', (req, res) => {
  // Prevent Node.js from timing out the SSE connection
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Content-Encoding': 'identity',
  });
  res.flushHeaders();
  res.write('\n');

  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 30000);

  function onEvent(event) {
    res.write('data: ' + JSON.stringify(event) + '\n\n');
  }

  buddyBus.on('buddy-event', onEvent);

  req.on('close', () => {
    clearInterval(keepalive);
    buddyBus.off('buddy-event', onEvent);
  });
});

const SINGLETON_SEED = 'global';

function warning(code, message, extra = {}) {
  return {
    code,
    severity: extra.severity || 'warning',
    message,
    ...extra,
  };
}

function configuredPersonalitySource(buddy) {
  return (buddy && buddy.personality && buddy.personality.source) || 'standalone';
}

function configuredAgentId(buddy) {
  return (buddy && buddy.personality && buddy.personality.agentId) || '';
}

function buildPersonalityWarnings(buddy, resolved) {
  const warnings = [];
  const configured = configuredPersonalitySource(buddy);
  const resolvedSource = (resolved && resolved.source) || 'standalone';
  const agentId = configuredAgentId(buddy);

  if (configured !== resolvedSource) {
    warnings.push(warning(
      'personality_source_unavailable',
      `Configured personality source "${configured}" resolved through "${resolvedSource}" fallback.`,
      {
        source: configured,
        resolvedSource,
        ref: (resolved && resolved.ref) || null,
      }
    ));
  }

  return warnings;
}

async function collectMemoryStatuses(sources) {
  const unique = Array.from(new Set(Array.isArray(sources) ? sources : []));
  const statuses = {};
  await Promise.all(unique.map(async (source) => {
    try {
      statuses[source] = await statusForSource(source);
    } catch (e) {
      statuses[source] = { source, available: false, error: e.message };
    }
  }));
  return statuses;
}

function buildMemoryWarnings(sources, statuses, chunkCount) {
  const configured = Array.isArray(sources) ? sources : [];
  const warnings = [];
  if (configured.length === 0) return warnings;

  const unavailable = configured.filter((source) => !statuses[source] || statuses[source].available === false);
  if (unavailable.length === configured.length) {
    warnings.push(warning(
      'memory_sources_unavailable',
      'All configured Buddy memory sources are unavailable; replies are not grounded in external memory.',
      { sources: configured, statuses }
    ));
  } else if (unavailable.length > 0) {
    warnings.push(warning(
      'memory_source_unavailable',
      'One or more configured Buddy memory sources are unavailable.',
      { sources: unavailable, statuses }
    ));
  } else if (chunkCount === 0 && configured.length > 0) {
    warnings.push(warning(
      'memory_no_matches',
      'Configured Buddy memory sources are available, but this request returned no matching memory chunks.',
      { sources: configured, severity: 'info' }
    ));
  }
  return warnings;
}

async function readNotesHealth(buddy) {
  let file = null;
  try {
    file = buddyNotesFile.resolveNotesPath(buddy);
    const notes = await buddyNotesFile.readNotes(buddy);
    return {
      file: notes.file,
      available: true,
      factCount: Array.isArray(notes.facts) ? notes.facts.length : 0,
    };
  } catch (e) {
    return {
      file,
      available: false,
      error: e.message,
    };
  }
}

async function assessBuddySourceHealth(buddy, resolved, memorySources, chunkCount) {
  const sources = Array.isArray(memorySources) ? memorySources : [];
  const [memoryStatuses, notes] = await Promise.all([
    collectMemoryStatuses(sources),
    readNotesHealth(buddy),
  ]);
  const warnings = [
    ...buildPersonalityWarnings(buddy, resolved),
    ...buildMemoryWarnings(sources, memoryStatuses, chunkCount),
  ];
  if (notes && notes.available === false) {
    warnings.push(warning(
      'notes_file_unavailable',
      'Buddy notes/facts file is not readable for the configured personality source.',
      { file: notes.file, error: notes.error }
    ));
  }
  return { warnings, memoryStatuses, notes };
}

// Phase 6g — best-effort one-shot legacy → brain.defaults migration.
setImmediate(() => {
  buddyRouting.migrateLegacyBrain(Buddy, SINGLETON_SEED).catch(() => {});
});

/**
 * GET /api/buddy/singleton — returns the canonical singleton buddy.
 */
router.get('/singleton', async (req, res) => {
  try {
    let buddy = await Buddy.findOne({ seed: SINGLETON_SEED });
    if (!buddy) buddy = await Buddy.create({ seed: SINGLETON_SEED });
    return envelope.success(res, { buddy });
  } catch (err) {
    return envelope.error(res, 500, err.message);
  }
});

/**
 * POST /api/buddy/singleton — set/update visual identity on the singleton.
 */
router.post('/singleton', async (req, res) => {
  const { name, species, rarity, soul, eyes, hat, pickedSpriteId, baseStats, stats, personality, memory, model, brain } = req.body || {};
  const $set = {};
  if (typeof name === 'string') $set.name = name;
  if (typeof species === 'string') $set.species = species;
  if (typeof rarity === 'string') $set.rarity = rarity;
  if (typeof soul === 'string') $set.soul = soul;
  if (typeof eyes === 'string') $set.eyes = eyes;
  if (typeof hat === 'string') $set.hat = hat;
  if (typeof pickedSpriteId === 'string') $set.pickedSpriteId = pickedSpriteId;
  if (baseStats && typeof baseStats === 'object') $set.baseStats = baseStats;
  if (stats && typeof stats === 'object') $set.stats = stats;
  if (personality && typeof personality === 'object') {
    const p = {};
    if (['standalone', 'agentx'].includes(personality.source)) p.source = personality.source;
    if (typeof personality.agentId === 'string') {
      p.agentId = '';
    }
    if (Object.keys(p).length > 0) $set.personality = p;
  }
  if (memory && typeof memory === 'object') {
    const m = {};
    if (Array.isArray(memory.sources)) {
      m.sources = buddyRouting.sanitizeMemorySources(memory.sources);
    }
    if (Number.isFinite(memory.k)) m.k = Math.max(1, Math.min(20, memory.k));
    if (Object.keys(m).length > 0) $set.memory = m;
  }
  if (model && typeof model === 'object') {
    const mm = {};
    if (typeof model.host === 'string') mm.host = model.host;
    if (typeof model.model === 'string') mm.model = model.model;
    if (Object.keys(mm).length > 0) $set.model = mm;
  }
  // Phase 6g — per-task brain config.
  const brainP = buddyRouting.brainPatch(brain);
  if (brainP) $set.brain = brainP;

  try {
    const buddy = await Buddy.findOneAndUpdate(
      { seed: SINGLETON_SEED },
      { $set, $setOnInsert: { mood: 'neutral' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return envelope.success(res, { buddy });
  } catch (err) {
    return envelope.error(res, 500, err.message);
  }
});

/**
 * GET /api/buddy/state?seed=xxx
 */
router.get('/state', async (req, res) => {
  const { seed } = req.query;
  if (!seed) return envelope.error(res, 400, 'seed is required');
  try {
    let buddy = await Buddy.findOne({ seed });
    if (!buddy) buddy = await Buddy.create({ seed });
    return envelope.success(res, { buddy });
  } catch (err) {
    return envelope.error(res, 500, err.message);
  }
});

/**
 * POST /api/buddy/state
 */
router.post('/state', async (req, res) => {
  const { seed, name, species, rarity, soul, stats, baseStats } = req.body;
  if (!seed) return envelope.error(res, 400, 'seed is required');
  try {
    const buddy = await Buddy.findOneAndUpdate(
      { seed },
      { $set: { name, species, rarity, soul, stats, baseStats } },
      { upsert: true, new: true }
    );
    return envelope.success(res, { buddy });
  } catch (err) {
    return envelope.error(res, 500, err.message);
  }
});

/**
 * POST /api/buddy/event
 */
router.post('/event', async (req, res) => {
  const { seed, eventType, model } = req.body;
  if (!seed || !eventType) return res.status(400).json({ error: 'seed and eventType required' });
  try {
    const entry = { type: eventType, timestamp: new Date() };

    // Build atomic update
    const $inc = { totalReactions: 1 };
    const $push = { moodHistory: { $each: [entry], $slice: -50 } };
    const $addToSet = {};

    if (eventType === 'pet') $inc.totalPets = 1;
    if (model) $addToSet.modelsUsed = model;

    // Stat progression
    if (eventType === 'long_response') $inc['stats.WISDOM'] = 1;
    if (eventType === 'model_switch' || eventType === 'host_switch') $inc['stats.CHAOS'] = 1;
    if (eventType === 'session_long') $inc['stats.PATIENCE'] = 1;

    const update = { $inc, $push };
    if (Object.keys($addToSet).length > 0) update.$addToSet = $addToSet;

    const buddy = await Buddy.findOneAndUpdate(
      { seed },
      update,
      { upsert: true, new: true }
    );

    // Cap stats at 100 (atomic $inc can overshoot)
    const statCaps = {};
    for (const [k, v] of Object.entries(buddy.stats.toObject ? buddy.stats.toObject() : buddy.stats)) {
      if (v > 100) statCaps[`stats.${k}`] = 100;
    }
    if (Object.keys(statCaps).length > 0) {
      await Buddy.updateOne({ _id: buddy._id }, { $set: statCaps });
      for (const [k, v] of Object.entries(statCaps)) buddy.set(k, v);
    }

    // DEBUGGING stat: success after error (needs history context)
    if (eventType === 'success' && buddy.moodHistory.length >= 2) {
      const prev = buddy.moodHistory[buddy.moodHistory.length - 2];
      if (prev && prev.type === 'error') {
        await Buddy.updateOne({ _id: buddy._id }, { $inc: { 'stats.DEBUGGING': 1 } });
        buddy.stats.DEBUGGING = Math.min(100, (buddy.stats.DEBUGGING || 0) + 1);
      }
    }

    // SNARK every 20 reactions
    if (buddy.totalReactions % 20 === 0) {
      await Buddy.updateOne({ _id: buddy._id }, { $inc: { 'stats.SNARK': 1 } });
      buddy.stats.SNARK = Math.min(100, (buddy.stats.SNARK || 0) + 1);
    }

    // Recompute mood from updated history
    const mood = computeMood(buddy.moodHistory);
    if (mood !== buddy.mood) {
      await Buddy.updateOne({ _id: buddy._id }, { $set: { mood } });
    }

    // Milestones
    const newMilestones = checkMilestones(buddy);
    if (newMilestones.length > 0) {
      const existingIds = buddy.milestones.map(m => m.id);
      const truly_new = newMilestones.filter(m => !existingIds.includes(m.id));
      if (truly_new.length > 0) {
        await Buddy.updateOne(
          { _id: buddy._id, 'milestones.id': { $nin: truly_new.map(m => m.id) } },
          { $push: { milestones: { $each: truly_new } } }
        );
      }
    }

    envelope.success(res, { mood, stats: buddy.stats, newMilestones, totalReactions: buddy.totalReactions });
  } catch (err) {
    console.error('[buddy/event] Error:', err.message, err.stack);
    envelope.error(res, 500, err.message);
  }
});

/**
 * POST /api/buddy/react
 * Generate an in-character reaction from the buddy companion.
 * Calls Ollama directly — no DB, no state.
 */
router.post('/react', async (req, res) => {
  const { context, seed, sentenceLimit, eventClass } = req.body || {};
  let { personality } = req.body || {};

  if (!context) {
    return res.status(400).json({ reaction: null, error: 'context is required' });
  }

  // Load singleton (drives personality, memory, and model routing).
  let buddy = null;
  if (!seed || seed === SINGLETON_SEED) {
    try {
      buddy = await Buddy.findOne({ seed: SINGLETON_SEED });
      if (!buddy) buddy = await Buddy.create({ seed: SINGLETON_SEED });
    } catch (err) {
      return res.status(500).json({ reaction: null, error: 'singleton_lookup_failed', message: err.message });
    }
  }

  let resolvedSource = 'standalone';
  let resolvedRef = null;
  let memorySnippets = [];
  let memorySources = [];
  let buddyModel = { host: '', model: '' };
  let factsCount = 0;
  let warnings = [];
  let sourceHealth = null;

  if (buddy) {
    const resolved = await buddyPersonalityModule.resolvePersonality(buddy);
    resolvedSource = resolved.source;
    resolvedRef = resolved.ref;
    memorySources = (buddy.memory && buddy.memory.sources) || [];
    // Phase 6g — per-task model resolution (react).
    buddyModel = buddyRouting.resolveTaskModel(buddy, 'react');

    // Memory retrieval based on the user-provided context.
    if (memorySources.length > 0) {
      try {
        memorySnippets = await searchMemory({
          sources: memorySources,
          query: context,
          k: (buddy.memory && buddy.memory.k) || 5,
        });
      } catch (err) {
        console.warn('[buddy/react] memory search failed:', err.message);
      }
    }

    let factsList = [];
    try {
      const notes = await buddyNotesFile.readNotes(buddy);
      factsList = (notes.facts || []).filter(f => !f.forgottenAt);
    } catch (e) {
      console.warn('[buddy/react] notes file read failed:', e.message);
    }
    if (factsList.length === 0 && Array.isArray(buddy.facts) && buddy.facts.length > 0) {
      factsList = buddy.facts;
    }
    factsCount = factsList.length;

    sourceHealth = await assessBuddySourceHealth(buddy, resolved, memorySources, memorySnippets.length);
    warnings = sourceHealth.warnings;

    if (!personality) {
      personality = buildServerPersonalityPrompt({
        buddy,
        mood: buddy.mood,
        eventClass,
        sentenceLimit,
        soul: resolved.soul,
        memorySnippets,
        facts: factsList,
      });
    }
  }

  if (!personality) {
    return res.status(400).json({ reaction: null, error: 'context and personality are required' });
  }

  // Dedup guard: reject if same seed reacted < 8s ago
  if (seed) {
    const lastTs = _reactTimestamps.get(seed);
    if (lastTs && Date.now() - lastTs < REACT_DEDUP_MS) {
      const retryAfterMs = REACT_DEDUP_MS - (Date.now() - lastTs);
      return res.json({ reaction: null, error: 'too_soon', retryAfterMs, message: 'Reaction cooldown active' });
    }
    _reactTimestamps.set(seed, Date.now());
  }

  const PORT = process.env.PORT || 3080;
  const proxyUrl = `http://localhost:${PORT}/api/inference/generate`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BUDDY_REACT_TIMEOUT_MS);

  // Reactions run through server-side Buddy routing only. Legacy browser
  // localStorage may contain stale host/model values, which must not bypass
  // the task router or displace pinned models on primary hosts.
  const effectiveHost = buddyModel.host || undefined;
  const effectiveModel = buddyModel.model || undefined;

  try {
    const proxyRes = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskType: 'buddy_reaction',
        host: effectiveHost,
        model: effectiveModel,
        messages: [
          { role: 'system', content: personality },
          { role: 'user', content: context },
        ],
        stream: false,
        responseMode: 'normalized',
        options: { num_predict: 100, temperature: 0.9 },
        thinkingMode: 'off',
        callerDetail: 'buddy/react',
      }),
      signal: controller.signal,
    });

    const data = await proxyRes.json();
    if (!proxyRes.ok || data.status === 'error') {
      const msg = data.message || data.error || proxyRes.statusText;
      throw new Error(msg);
    }

    const raw = (data.message?.content || data.response || '').trim();
    const maxSentences = Math.min(sentenceLimit || 2, 3);
    const sentences = raw.match(/[^.!?]*[.!?]+/g) || [raw];
    const reaction = sentences.slice(0, maxSentences).join(' ').trim() || raw.slice(0, 200);

    res.json({
      reaction,
      personality: { source: resolvedSource, ref: resolvedRef },
      memory: { sources: memorySources, chunks: memorySnippets.length },
      model: inferenceModelMeta(proxyRes, effectiveHost, effectiveModel),
      facts: { count: factsCount },
      warnings,
      sourceHealth: sourceHealth ? { memory: sourceHealth.memoryStatuses, notes: sourceHealth.notes } : null,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`[buddy/react] Timeout (${BUDDY_REACT_TIMEOUT_MS}ms)`);
      return res.status(504).json({ reaction: null, error: 'timeout', retryAfterMs: 10000, message: 'LLM request timed out' });
    }
    console.error('[buddy/react] Error:', err.message);
    const errorType = /model.*not found|no such model|no ollama host/i.test(err.message) ? 'model_unavailable' : 'internal_error';
    const retryAfterMs = errorType === 'model_unavailable' ? 30000 : 5000;
    res.status(502).json({ reaction: null, error: errorType, retryAfterMs, message: err.message });
  } finally {
    clearTimeout(timeout);
  }
});

// ── Chat constants ──
const CHAT_MAX_MESSAGES = 50;
const CHAT_MAX_CONTENT = 4000;
const CHAT_DEFAULT_SESSION = 'buddy-singleton';
const BUDDY_FACT_MEMORY_TIMEOUT_MS = Math.max(
  200,
  Math.min(5000, Number(process.env.BUDDY_FACT_MEMORY_TIMEOUT_MS) || 500)
);

function validateChatMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: 'messages must be a non-empty array' };
  }
  for (const m of messages) {
    if (!m || typeof m !== 'object') return { ok: false, error: 'each message must be an object' };
    if (m.role !== 'user' && m.role !== 'assistant') {
      return { ok: false, error: 'role must be user or assistant' };
    }
    if (typeof m.content !== 'string' || !m.content.trim()) {
      return { ok: false, error: 'content must be a non-empty string' };
    }
  }
  return { ok: true };
}

function normalizeChatMessages(messages) {
  let trimmed = messages;
  if (trimmed.length > CHAT_MAX_MESSAGES) trimmed = trimmed.slice(-CHAT_MAX_MESSAGES);
  return trimmed.map(m => {
    let c = m.content;
    if (c.length > CHAT_MAX_CONTENT) c = c.slice(0, CHAT_MAX_CONTENT - 1) + '…';
    return { role: m.role, content: c };
  });
}

/**
 * POST /api/buddy/chat
 * Multi-turn chat with the buddy singleton. Distinct from /react (single-turn).
 */
router.post('/chat', async (req, res) => {
  const t0 = Date.now();
  const { messages, sessionId } = req.body || {};

  const v = validateChatMessages(messages);
  if (!v.ok) return res.status(400).json({ error: 'invalid_messages', message: v.error });

  const cleanMessages = normalizeChatMessages(messages);
  const sid = (typeof sessionId === 'string' && sessionId.trim()) || CHAT_DEFAULT_SESSION;

  // Load singleton, resolve personality + memory.
  let buddy = null;
  try { buddy = await Buddy.findOne({ seed: SINGLETON_SEED }); } catch (_) { /* tolerate */ }

  let systemPrompt = 'You are a friendly buddy companion on the AgentX platform.';
  let resolvedSource = 'standalone';
  let resolvedRef = null;
  let memorySources = [];
  let memorySnippets = [];
  let buddyModel = { host: '', model: '' };
  let factsCount = 0;
  let warnings = [];
  let sourceHealth = null;

  if (buddy) {
    const resolved = await buddyPersonalityModule.resolvePersonality(buddy);
    resolvedSource = resolved.source;
    resolvedRef = resolved.ref;
    memorySources = (buddy.memory && buddy.memory.sources) || [];
    // Phase 6g — per-task model resolution (chat).
    buddyModel = buddyRouting.resolveTaskModel(buddy, 'chat');

    if (memorySources.length > 0) {
      const lastUser = [...cleanMessages].reverse().find(m => m.role === 'user');
      const query = lastUser ? lastUser.content : '';
      if (query.trim()) {
        try {
          memorySnippets = await searchMemory({
            sources: memorySources,
            query,
            k: (buddy.memory && buddy.memory.k) || 5,
          });
        } catch (err) {
          console.warn('[buddy/chat] memory search failed:', err.message);
        }
      }
    }

    let factsList = [];
    try {
      const notes = await buddyNotesFile.readNotes(buddy);
      factsList = (notes.facts || []).filter(f => !f.forgottenAt);
    } catch (e) {
      console.warn('[buddy/chat] notes file read failed:', e.message);
    }
    if (factsList.length === 0 && Array.isArray(buddy.facts) && buddy.facts.length > 0) {
      factsList = buddy.facts;
    }
    factsCount = factsList.length;

    sourceHealth = await assessBuddySourceHealth(buddy, resolved, memorySources, memorySnippets.length);
    warnings = sourceHealth.warnings;

    systemPrompt = buildServerPersonalityPrompt({
      buddy,
      mood: buddy.mood,
      eventClass: 'chat',
      soul: resolved.soul,
      memorySnippets,
      facts: factsList,
    });
  }

  const fullMessages = [{ role: 'system', content: systemPrompt }, ...cleanMessages];

  const PORT = process.env.PORT || 3080;
  const proxyUrl = `http://localhost:${PORT}/api/inference/generate`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BUDDY_REACT_TIMEOUT_MS);

  const effectiveHost = buddyModel.host || undefined;
  const effectiveModel = buddyModel.model || undefined;

  try {
    const proxyRes = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskType: 'buddy_chat',
        host: effectiveHost,
        model: effectiveModel,
        messages: fullMessages,
        stream: false,
        responseMode: 'normalized',
        options: { num_predict: 400, temperature: 0.8 },
        thinkingMode: 'off',
        callerDetail: 'buddy/chat',
      }),
      signal: controller.signal,
    });

    const data = await proxyRes.json();
    if (!proxyRes.ok || data.status === 'error') {
      const msg = data.message || data.error || proxyRes.statusText;
      throw new Error(msg);
    }

    const reply = (data.message?.content || data.response || '').trim();
    if (!reply) throw new Error('empty_reply');

    const latency = Date.now() - t0;
    console.info(`[buddy/chat] messages_count=${cleanMessages.length} latency_ms=${latency} personality=${resolvedSource} memory=${memorySnippets.length} facts=${factsCount}`);
    return res.json({
      reply,
      personality: { source: resolvedSource, ref: resolvedRef },
      memory: { sources: memorySources, chunks: memorySnippets.length },
      model: inferenceModelMeta(proxyRes, effectiveHost, effectiveModel),
      facts: { count: factsCount },
      warnings,
      sourceHealth: sourceHealth ? { memory: sourceHealth.memoryStatuses, notes: sourceHealth.notes } : null,
      sessionId: sid,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`[buddy/chat] Timeout (${BUDDY_REACT_TIMEOUT_MS}ms)`);
      return res.status(504).json({ error: 'timeout', retryAfterMs: 10000, message: 'LLM request timed out' });
    }
    console.error('[buddy/chat] Error:', err.message);
    const errorType = /model.*not found|no such model|no ollama host/i.test(err.message) ? 'model_unavailable' : 'internal_error';
    const retryAfterMs = errorType === 'model_unavailable' ? 30000 : 5000;
    return res.status(502).json({ error: errorType, retryAfterMs, message: err.message });
  } finally {
    clearTimeout(timeout);
  }
});

/**
 * GET /api/buddy/hosts
 * Return available Ollama hosts for the settings UI.
 */
router.get('/hosts', (req, res) => {
  try {
    const hosts = getConfiguredHosts();
    return envelope.success(res, { hosts: hosts.map(h => ({ id: h.id, name: h.name, url: h.url })) });
  } catch (err) {
    return envelope.success(res, { hosts: [] });
  }
});

// Phase 6f endpoints --------------------------------------------------------

/**
 * GET /api/buddy/personality-sources
 * Returns the product-owned personality sources available to Buddy.
 */
router.get('/personality-sources', async (req, res) => {
  try {
    return envelope.success(res, {
      sources: [
        { source: 'standalone', available: true },
        { source: 'agentx', available: true, ref: 'agentx:buddy.soul' },
      ],
    });
  } catch (err) {
    return envelope.error(res, 500, err.message);
  }
});

/**
 * GET /api/buddy/personality-resolved
 * Resolves the buddy singleton's personality source and returns the soul preview.
 */
router.get('/personality-resolved', async (req, res) => {
  try {
    let buddy = await Buddy.findOne({ seed: SINGLETON_SEED });
    if (!buddy) buddy = await Buddy.create({ seed: SINGLETON_SEED });
    const resolved = await buddyPersonalityModule.resolvePersonality(buddy);
    return envelope.success(res, {
      source: resolved.source,
      ref: resolved.ref,
      profile: resolved.profile || null,
      agentId: resolved.agentId || null,
      agentName: resolved.agentName || null,
      sourceDetail: resolved.sourceDetail || null,
      soul: resolved.soul || '',
    });
  } catch (err) {
    return envelope.error(res, 500, err.message);
  }
});

/**
 * GET /api/buddy/source-health
 * Returns configured-source diagnostics for Nestor v0.2.7 compatibility.
 */
router.get('/source-health', async (req, res) => {
  try {
    let buddy = await Buddy.findOne({ seed: SINGLETON_SEED });
    if (!buddy) buddy = await Buddy.create({ seed: SINGLETON_SEED });
    const resolved = await buddyPersonalityModule.resolvePersonality(buddy);
    const memorySources = (buddy.memory && buddy.memory.sources) || [];
    const health = await assessBuddySourceHealth(buddy, resolved, memorySources, null);
    return envelope.success(res, {
      configuredPersonality: configuredPersonalitySource(buddy),
      configuredAgentId: configuredAgentId(buddy) || null,
      resolvedPersonality: {
        source: resolved.source,
        ref: resolved.ref,
        profile: resolved.profile || null,
        agentId: resolved.agentId || null,
        agentName: resolved.agentName || null,
        sourceDetail: resolved.sourceDetail || null,
      },
      memorySources,
      memory: health.memoryStatuses,
      notes: health.notes,
      warnings: health.warnings,
    });
  } catch (err) {
    return envelope.error(res, 500, err.message);
  }
});

/**
 * POST /api/buddy/personality-preview
 * Resolves a candidate personality config without saving it.
 */
router.post('/personality-preview', async (req, res) => {
  try {
    let buddy = await Buddy.findOne({ seed: SINGLETON_SEED });
    if (!buddy) buddy = await Buddy.create({ seed: SINGLETON_SEED });

    const candidate = typeof buddy.toObject === 'function' ? buddy.toObject() : { ...buddy };
    const personality = req.body && req.body.personality;
    if (personality && typeof personality === 'object') {
      const source = String(personality.source || '').trim();
      if (!['standalone', 'agentx'].includes(source)) {
        return envelope.error(res, 400, 'invalid personality source');
      }
      candidate.personality = {
        source,
        agentId: typeof personality.agentId === 'string' ? personality.agentId : '',
      };
    }
    if (typeof req.body?.soul === 'string') {
      candidate.soul = req.body.soul;
    }

    const resolved = await buddyPersonalityModule.resolvePersonality(candidate);
    return envelope.success(res, {
      source: resolved.source,
      ref: resolved.ref,
      profile: resolved.profile || null,
      agentId: resolved.agentId || null,
      agentName: resolved.agentName || null,
      sourceDetail: resolved.sourceDetail || null,
      soul: resolved.soul || '',
    });
  } catch (err) {
    return envelope.error(res, 500, err.message);
  }
});

/**
 * GET /api/buddy/bootstrap-soul
 * Returns a synthesized starter soul (used to pre-fill the standalone textarea).
 */
router.get('/bootstrap-soul', async (req, res) => {
  try {
    const soul = await personalityAdapters.bootstrapSoul();
    return envelope.success(res, { soul });
  } catch (err) {
    return envelope.error(res, 500, err.message);
  }
});

// Phase 6h endpoints — file-based facts -------------------------------------

// Load the singleton, run one-shot Mongo→file migration if needed.
async function loadSingletonForFacts() {
  let buddy = await Buddy.findOne({ seed: SINGLETON_SEED });
  if (!buddy) buddy = await Buddy.create({ seed: SINGLETON_SEED });
  try {
    await buddyNotesFile.migrateMongoFacts(buddy, Buddy);
  } catch (e) {
    console.warn('[buddy/facts] migration check failed:', e.message);
  }
  return buddy;
}

function sortDesc(facts, key) {
  return facts.slice().sort((a, b) => new Date(b[key] || 0) - new Date(a[key] || 0));
}

async function ingestFactMemory(text, tags) {
  try {
    const memory = await saveMemory({
      text,
      type: 'fact',
      agent: 'buddy',
      topic: 'buddy-facts',
      tags: ['buddy-fact', ...(Array.isArray(tags) ? tags : [])],
    }, { timeoutMs: BUDDY_FACT_MEMORY_TIMEOUT_MS });
    return { ingested: true, documentId: memory.documentId, tags: memory.tags };
  } catch (err) {
    return {
      ingested: false,
      warning: {
        code: err.code || 'NESTOR_MEMORY_INGEST_FAILED',
        message: err.message,
      },
    };
  }
}

// GET /facts — active list. ?include=forgotten -> {active, forgotten, file}.
router.get('/facts', async (req, res) => {
  try {
    const buddy = await loadSingletonForFacts();
    const { facts, file } = await buddyNotesFile.readNotes(buddy);
    const active = sortDesc(facts.filter(f => !f.forgottenAt), 'addedAt');
    const forgotten = sortDesc(facts.filter(f => f.forgottenAt), 'forgottenAt');
    if (String(req.query.include || '').toLowerCase() === 'forgotten') {
      return envelope.success(res, { active, forgotten, file });
    }
    return envelope.success(res, { facts: active, file });
  } catch (err) {
    return envelope.error(res, 500, err.message);
  }
});

// POST /facts {text, weight?, tags?} — append to the notes file.
router.post('/facts', async (req, res) => {
  const { text, weight, tags } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return envelope.error(res, 400, 'text is required');
  }
  try {
    assertMemoryText(text);
  } catch (err) {
    const status = err instanceof NestorMemoryError ? err.status : 400;
    return envelope.error(res, status, err.message);
  }
  try {
    const buddy = await loadSingletonForFacts();
    const { facts, file } = await buddyNotesFile.appendFact(buddy, { text, weight, tags });
    const active = sortDesc(facts.filter(f => !f.forgottenAt), 'addedAt');
    const memory = await ingestFactMemory(text, tags);
    return envelope.success(res, { facts: active.slice(0, 10), count: active.length, file, memory });
  } catch (err) {
    return envelope.error(res, 500, err.message);
  }
});

// DELETE /facts/:index — mark forgotten (does not erase).
router.delete('/facts/:index', async (req, res) => {
  const idx = parseInt(req.params.index, 10);
  if (!Number.isFinite(idx) || idx < 0) {
    return envelope.error(res, 400, 'invalid index');
  }
  try {
    const buddy = await loadSingletonForFacts();
    const { facts, file } = await buddyNotesFile.forgetFact(buddy, idx);
    const active = sortDesc(facts.filter(f => !f.forgottenAt), 'addedAt');
    return envelope.success(res, { facts: active.slice(0, 10), count: active.length, file });
  } catch (err) {
    if (/index out of range/i.test(err.message)) {
      return envelope.error(res, 400, err.message);
    }
    return envelope.error(res, 500, err.message);
  }
});

// GET /facts/file — raw markdown file contents.
router.get('/facts/file', async (req, res) => {
  try {
    const buddy = await loadSingletonForFacts();
    const filePath = buddyNotesFile.resolveNotesPath(buddy);
    let content = '';
    try {
      const fs = require('fs').promises;
      content = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('X-Buddy-Notes-File', filePath);
    return res.send(content);
  } catch (err) {
    return envelope.error(res, 500, err.message);
  }
});

/**
 * GET /api/buddy/memory/search?source=&q=&k=
 */
router.get('/memory/search', async (req, res) => {
  const source = (req.query.source || '').toString().toLowerCase();
  const q = (req.query.q || '').toString();
  const k = Math.max(1, Math.min(20, parseInt(req.query.k, 10) || 5));
  if (!buddyRouting.VALID_MEMORY_SOURCES.includes(source)) {
    return envelope.error(res, 400, 'invalid source');
  }
  if (!q.trim()) return envelope.success(res, { results: [] });
  try {
    const results = await searchSingle(source, q, k);
    return envelope.success(res, { results });
  } catch (err) {
    return envelope.error(res, 500, err.message);
  }
});

/**
 * GET /api/buddy/memory/status?source=
 */
router.get('/memory/status', async (req, res) => {
  const source = (req.query.source || '').toString().toLowerCase();
  if (!buddyRouting.VALID_MEMORY_SOURCES.includes(source)) {
    return envelope.error(res, 400, 'invalid source');
  }
  try {
    const status = await statusForSource(source);
    return envelope.success(res, { status });
  } catch (err) {
    return envelope.error(res, 500, err.message);
  }
});

/**
 * GET /api/buddy/memory/alignment
 */
router.get('/memory/alignment', async (req, res) => {
  try {
    const status = await getEcosystemMemoryAlignmentStatus();
    return envelope.success(res, { status });
  } catch (err) {
    return envelope.error(res, 500, err.message);
  }
});

module.exports = router;
