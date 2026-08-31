/**
 * Roundtable Orchestrator
 *
 * Runs the full multi-agent discussion:
 *   Round 1 (blind)  → Rounds 2..N (rebuttals) → Synthesis
 *
 * Streams chunks through an EventEmitter so SSE clients see tokens as they
 * arrive. Persists each completed turn immediately so a restart doesn't lose
 * in-flight state.
 */

const fetch = require('node-fetch');
const { EventEmitter } = require('events');
const logger = require('../../../config/logger');
const Roundtable = require('../../../models/Roundtable');
const { buildOllamaPayload, buildOllamaStats, extractResponse } = require('../../helpers/ollamaResponseHandler');
const { getTargetForModel } = require('../modelRouter');
const hostPreferenceService = require('../hostPreferenceService');
const { getFetchOptions } = require('../../helpers/httpAgent');
const {
  DEFAULT_PANEL,
  DEFAULT_SYNTHESIZER,
  REBUTTAL_PREAMBLE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  withCouncilAdvisoryGuard
} = require('./defaults');
const { callRuntimeParticipant } = require('./runtimeParticipantAdapter');
const {
  formatInterjectionContext,
  getPendingInterjections,
  markInterjectionsApplied
} = require('./controls');

// Optional web-search integration. If the module isn't present at runtime,
// agents with enableWebSearch=true will just run without web context.
let searchWeb = async () => ({ results: [], formatted: '', error: 'webSearch not available' });
try {
  ({ searchWeb } = require('../webSearch'));
} catch { /* noop */ }

// Per-roundtable streaming emitters — the SSE route picks these up.
const emitterRegistry = new Map();

function resolveHostName(target) {
  if (!target) return 'unknown';
  try {
    return new URL(target).hostname;
  } catch {
    return target;
  }
}

async function assessModelParticipantReadiness(agent) {
  const target = getTargetForModel(agent.model);
  if (!target) {
    return { ready: false, target: null, hostName: 'unknown', error: `No host found for model ${agent.model}` };
  }

  const hostName = resolveHostName(target);
  try {
    const preference = await hostPreferenceService.getByHost(target);
    const status = String(preference?.status || '').toLowerCase();
    const claimed = Boolean(preference?.benchmarkClaim?.batchId);
    if (claimed || ['benchmarking', 'restoring', 'swapping', 'offline'].includes(status)) {
      const reason = claimed ? 'reserved for benchmark/judge work' : status;
      return {
        ready: false,
        target,
        hostName,
        error: `${preference?.displayName || hostName} is ${reason}; Council did not start this participant`
      };
    }
  } catch (err) {
    logger.warn('Council host-preference readiness evidence unavailable; continuing with direct probe', {
      model: agent.model,
      target,
      error: err.message
    });
  }
  return { ready: true, target, hostName, error: null };
}

function isSystemicParticipantFailure(result) {
  const error = String(result?.error || '').toLowerCase();
  return Boolean(error) && (
    error.includes('timeout after')
    || error.includes('no host found')
    || error.includes('council did not start this participant')
    || error.includes('econnrefused')
    || error.includes('connection refused')
    || error.includes('fetch failed')
    || error.includes('socket hang up')
    || error.includes('stream ended before')
  );
}

function participantRouteKey(agent) {
  const runtime = String(agent.runtime || 'model').toLowerCase();
  if (runtime !== 'model') return `${runtime}:${agent.runtimeConfig?.sessionKey || agent.agentId}`;
  return `model:${getTargetForModel(agent.model) || 'unrouted'}`;
}

async function buildPinnedAgentPayload(agent, messages, target, streamEnabled = false) {
  let runtimeOptions = {
    options: { num_predict: -1 },
    keepAlive: undefined
  };

  try {
    const pref = await hostPreferenceService.getByHost(target);
    runtimeOptions = hostPreferenceService.resolvePinnedRuntimeOptions(
      pref,
      agent.model,
      runtimeOptions.options
    );
  } catch (err) {
    logger.warn('Roundtable pin options unavailable; using model defaults', {
      model: agent.model,
      target,
      error: err.message
    });
  }

  const options = { ...runtimeOptions.options };
  if (runtimeOptions.keepAlive !== undefined && runtimeOptions.keepAlive !== '') {
    options.keep_alive = runtimeOptions.keepAlive;
  }
  return buildOllamaPayload({ model: agent.model, messages, streamEnabled, options });
}

// ─── single-shot agent call (non-streaming path) ─────────────────────────
async function callAgent(agent, messages, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const startedAt = new Date();
  const readiness = await assessModelParticipantReadiness(agent);
  const { target, hostName } = readiness;

  if (!readiness.ready) {
    return {
      response: '', thinking: null,
      stats: { tokensPerSecond: null, latencyMs: null },
      error: readiness.error,
      target, hostName, startedAt, completedAt: new Date()
    };
  }

  const url = `${target}/api/chat`;
  const payload = await buildPinnedAgentPayload(agent, messages, target);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const fetchOpts = getFetchOptions(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const res = await fetch(url, fetchOpts);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama ${res.status}: ${body.substring(0, 200)}`);
    }

    const data = await res.json();
    clearTimeout(timer);
    const parsed = extractResponse(data, agent.model);
    const completedAt = new Date();
    return {
      response: parsed.content || '',
      thinking: parsed.thinking || null,
      stats: {
        tokensPerSecond: parsed.stats?.performance?.tokensPerSecond || null,
        latencyMs: completedAt - startedAt,
        promptTokens: parsed.stats?.usage?.promptTokens || null,
        completionTokens: parsed.stats?.usage?.completionTokens || null
      },
      error: null, target, hostName, startedAt, completedAt
    };
  } catch (err) {
    clearTimeout(timer);
    const completedAt = new Date();
    const isTimeout = err.name === 'AbortError';
    const errorMsg = isTimeout ? `Timeout after ${timeoutMs}ms` : err.message;
    logger.error('Roundtable callAgent failed', { agentId: agent.agentId, model: agent.model, target, error: errorMsg });
    return {
      response: '', thinking: null,
      stats: { tokensPerSecond: null, latencyMs: completedAt - startedAt },
      error: errorMsg, target, hostName, startedAt, completedAt
    };
  }
}

// ─── streaming agent call (NDJSON, chunks emitted live) ──────────────────
async function callAgentStreaming(agent, messages, timeoutMs, emitter, eventPrefix) {
  if (!emitter) return callAgent(agent, messages, timeoutMs);

  const startedAt = new Date();
  const readiness = await assessModelParticipantReadiness(agent);
  const { target, hostName } = readiness;

  if (!readiness.ready) {
    return {
      response: '', thinking: null,
      stats: { tokensPerSecond: null, latencyMs: null },
      error: readiness.error,
      target, hostName, startedAt, completedAt: new Date()
    };
  }

  const url = `${target}/api/chat`;
  const payload = await buildPinnedAgentPayload(agent, messages, target, true);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const fetchOpts = getFetchOptions(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const res = await fetch(url, fetchOpts);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama ${res.status}: ${body.substring(0, 200)}`);
    }

    let fullContent = '';
    let thinkingContent = '';
    let inThinking = false;
    let finalData = null;
    const reader = res.body;
    let buffer = '';

    await new Promise((resolve, reject) => {
      reader.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.done) { finalData = obj; continue; }
            const token = obj.message?.content || '';
            if (!token) continue;
            if (token.includes('<think>')) { inThinking = true; continue; }
            if (token.includes('</think>')) { inThinking = false; continue; }
            if (inThinking) { thinkingContent += token; continue; }
            fullContent += token;
            emitter.emit('chunk', { type: `${eventPrefix}-chunk`, agentId: agent.agentId, round: agent._round, content: token });
          } catch { /* skip malformed line */ }
        }
      });
      reader.on('end', resolve);
      reader.on('error', reject);
    });
    if (finalData?.done !== true) {
      throw new Error('Ollama stream ended before its terminal record');
    }
    clearTimeout(timer);

    const completedAt = new Date();
    const latencyMs = completedAt - startedAt;
    const parsedStats = buildOllamaStats(finalData || {}, fullContent);

    return {
      response: fullContent,
      thinking: thinkingContent || null,
      stats: {
        tokensPerSecond: parsedStats?.performance?.tokensPerSecond ?? null,
        latencyMs,
        promptTokens: parsedStats?.usage?.promptTokens || null,
        completionTokens: parsedStats?.usage?.completionTokens || null
      },
      error: null, target, hostName, startedAt, completedAt
    };
  } catch (err) {
    clearTimeout(timer);
    const completedAt = new Date();
    const isTimeout = err.name === 'AbortError';
    const errorMsg = isTimeout ? `Timeout after ${timeoutMs}ms` : err.message;
    logger.error('Roundtable streaming callAgent failed', { agentId: agent.agentId, model: agent.model, target, error: errorMsg });
    return {
      response: '', thinking: null,
      stats: { tokensPerSecond: null, latencyMs: completedAt - startedAt },
      error: errorMsg, target, hostName, startedAt, completedAt
    };
  }
}

async function callParticipant(agent, messages, timeoutMs, emitter, eventPrefix, context) {
  const runtime = String(agent.runtime || 'model').toLowerCase();
  if (runtime === 'model') {
    const result = await callAgentStreaming(agent, messages, timeoutMs, emitter, eventPrefix);
    return { ...result, runtime: 'model', runtimeRef: null };
  }
  const result = await callRuntimeParticipant(agent, messages, {
    ...context,
    timeoutMs
  });
  if (emitter && result.response) {
    emitter.emit('chunk', {
      type: `${eventPrefix}-chunk`,
      agentId: agent.agentId,
      round: context.round,
      content: result.response
    });
  }
  return result;
}

function withInterjectionContext(messages, interjections) {
  const context = formatInterjectionContext(interjections);
  if (!context) return messages;
  return [...messages, { role: 'user', content: context }];
}

function buildSynthesisRequest(question, transcript) {
  return `Original question: ${question}\n\n---\n\nPanel Discussion:\n\n${transcript}\n\n---\n\nAnswer the original question using the panel evidence. Preserve consensus, material dissent, evidence, and risks when the requested format permits. This verdict is advisory and must not claim that any action was approved or executed.\n\nOUTPUT CONTRACT: Every explicit format or length constraint in the original question is mandatory. If it requests an exact shape (for example, exactly two bullets), return exactly that shape and nothing else—no preamble, headings, appendix, or open-questions section.`;
}

async function recordAppliedInterjections(roundtableDoc, interjections, round, emitter) {
  if (!interjections.length) return [];
  await markInterjectionsApplied(roundtableDoc._id, interjections, round);
  if (emitter) {
    emitter.emit('chunk', {
      type: 'interjections-applied',
      round,
      count: interjections.length
    });
  }
  return interjections;
}

// ─── one round (all agents in order) ─────────────────────────────────────
async function executeRound(roundtableDoc, roundNum, agents, buildMessages, timeoutMs, emitter, options = {}) {
  const results = {};
  const failedRoutes = new Map();
  const participantCaller = options.callParticipantImpl || callParticipant;

  for (const agent of agents) {
    const routeKey = participantRouteKey(agent);
    const messages = buildMessages(agent);

    let webSearchResults = [];
    if (agent.enableWebSearch) {
      if (emitter) emitter.emit('chunk', { type: 'web-search-start', agentId: agent.agentId, round: roundNum });
      const searchResult = await searchWeb(roundtableDoc.question);
      webSearchResults = searchResult.results || [];
      if (searchResult.formatted) {
        messages.splice(messages.length - 1, 0, {
          role: 'user',
          content: `Use these web search results as additional context for your analysis:\n\n${searchResult.formatted}`
        });
      }
      if (emitter) emitter.emit('chunk', { type: 'web-search-done', agentId: agent.agentId, round: roundNum, resultCount: webSearchResults.length });
    }

    const runtime = String(agent.runtime || 'model').toLowerCase();
    if (emitter) emitter.emit('chunk', {
      type: 'turn-start', agentId: agent.agentId, round: roundNum,
      role: agent.role, model: agent.model, runtime
    });

    const priorFailure = failedRoutes.get(routeKey);
    const result = priorFailure
      ? {
          response: '',
          thinking: null,
          stats: { tokensPerSecond: null, latencyMs: 0 },
          error: `Skipped after shared route failure: ${priorFailure}`,
          target: null,
          hostName: null,
          runtime,
          runtimeRef: null,
          startedAt: new Date(),
          completedAt: new Date()
        }
      : await participantCaller(
          { ...agent, _round: roundNum },
          messages,
          timeoutMs,
          emitter,
          'turn',
          { roundtableId: String(roundtableDoc._id), round: roundNum }
        );

    if (!priorFailure && isSystemicParticipantFailure(result)) {
      failedRoutes.set(routeKey, result.error);
    }

    if (emitter) emitter.emit('chunk', { type: 'turn-done', agentId: agent.agentId, round: roundNum, stats: result.stats, error: result.error });

    const persistedTurn = {
      agentId: agent.agentId, role: agent.role, round: roundNum, model: agent.model,
      runtime, runtimeRef: result.runtimeRef || null,
      target: result.target, hostName: result.hostName,
      // Persist only the participant's final answer. Private reasoning is not
      // part of the Council contract and must never enter Mongo or transcripts.
      response: result.response, thinking: null, error: result.error,
      webSearchResults: webSearchResults.length > 0 ? webSearchResults : undefined,
      stats: result.stats, startedAt: result.startedAt, completedAt: result.completedAt
    };
    await Roundtable.updateOne(
      { _id: roundtableDoc._id },
      { $push: { turns: persistedTurn } }
    );
    await Roundtable.updateOne(
      { _id: roundtableDoc._id, 'panelConfig.agentId': agent.agentId },
      { $set: { 'panelConfig.$.resolvedTarget': result.target, 'panelConfig.$.resolvedHostName': result.hostName } }
    );

    results[agent.agentId] = result;
  }

  return results;
}

// ─── run: orchestrate the whole discussion ───────────────────────────────
async function runRoundtable(roundtableId, emitter) {
  const startTime = Date.now();
  let doc = await Roundtable.findById(roundtableId);
  if (!doc) {
    logger.error('Roundtable not found', { roundtableId });
    return;
  }

  try {
    doc.status = 'running';
    await doc.save();
    if (emitter) emitter.emit('chunk', { type: 'started', roundtableId, rounds: doc.rounds });

    const agents = doc.panelConfig.map((a) => a.toObject());
    const totalTimer = setTimeout(async () => {
      logger.error('Roundtable total timeout exceeded', { roundtableId });
      await Roundtable.updateOne(
        { _id: roundtableId, status: 'running' },
        { $set: { status: 'timeout', error: `Total timeout after ${DEFAULT_TOTAL_TIMEOUT_MS}ms`, completedAt: new Date(), totalDurationMs: Date.now() - startTime } }
      );
    }, DEFAULT_TOTAL_TIMEOUT_MS);

    // Round 1 — blind
    const r1Interjections = await getPendingInterjections(roundtableId);
    if (emitter) emitter.emit('chunk', { type: 'round-start', round: 1, label: 'Initial Analysis' });
    const r1Results = await executeRound(doc, 1, agents, (agent) => withInterjectionContext([
      { role: 'system', content: withCouncilAdvisoryGuard(agent.systemPrompt) },
      { role: 'user', content: doc.question }
    ], r1Interjections), DEFAULT_TIMEOUT_MS, emitter);
    await recordAppliedInterjections(doc, r1Interjections, 1, emitter);
    if (emitter) emitter.emit('chunk', { type: 'round-done', round: 1 });
    if (!Object.values(r1Results).some(result => String(result?.response || '').trim())) {
      throw new Error('Council stopped: no panelist returned a response. Review host readiness and retry.');
    }

    // Rounds 2..N — rebuttals
    if (doc.rounds >= 2) {
      doc = await Roundtable.findById(roundtableId);
      if (doc.status !== 'running') { clearTimeout(totalTimer); return; }

      for (let roundNum = 2; roundNum <= doc.rounds; roundNum += 1) {
        const previousTurns = doc.turns.filter((t) => t.round === roundNum - 1);
        const roundInterjections = await getPendingInterjections(roundtableId);
        if (emitter) emitter.emit('chunk', { type: 'round-start', round: roundNum, label: `Rebuttal Round ${roundNum}` });

        await executeRound(doc, roundNum, agents, (agent) => {
          const otherResponses = previousTurns
            .filter((t) => t.agentId !== agent.agentId && t.response)
            .map((t) => `**${t.role}:**\n${t.response}`)
            .join('\n\n');
          return withInterjectionContext([
            { role: 'system', content: withCouncilAdvisoryGuard(agent.systemPrompt) },
            { role: 'user', content: doc.question },
            { role: 'assistant', content: r1Results[agent.agentId]?.response || '' },
            { role: 'user', content: REBUTTAL_PREAMBLE + otherResponses + '\n\n---\nNow provide your rebuttal.' }
          ], roundInterjections);
        }, DEFAULT_TIMEOUT_MS, emitter);

        await recordAppliedInterjections(doc, roundInterjections, roundNum, emitter);
        if (emitter) emitter.emit('chunk', { type: 'round-done', round: roundNum });
        doc = await Roundtable.findById(roundtableId);
        if (doc.status !== 'running') { clearTimeout(totalTimer); return; }
      }
    }

    // Synthesis
    doc = await Roundtable.findById(roundtableId);
    if (doc.status !== 'running') { clearTimeout(totalTimer); return; }

    const allTurns = doc.turns;
    const synthesisInterjections = await getPendingInterjections(roundtableId);
    const transcriptForSynthesis = allTurns
      .map((t) => `[Round ${t.round}] ${t.role} (${t.model}):\n${t.response || t.error || 'No response'}`)
      .join('\n\n---\n\n');

    const synthesizer = doc.synthesizerConfig.toObject ? doc.synthesizerConfig.toObject() : doc.synthesizerConfig;
    const synthMessages = withInterjectionContext([
      { role: 'system', content: withCouncilAdvisoryGuard(synthesizer.systemPrompt) },
      { role: 'user', content: buildSynthesisRequest(doc.question, transcriptForSynthesis) }
    ], synthesisInterjections);

    if (emitter) emitter.emit('chunk', { type: 'synthesis-start', model: synthesizer.model });

    const synthResult = await callAgentStreaming(
      { agentId: 'synthesizer', role: 'Synthesizer', model: synthesizer.model, systemPrompt: synthesizer.systemPrompt, _round: 0 },
      synthMessages, DEFAULT_TIMEOUT_MS, emitter, 'synthesis'
    );

    if (emitter) emitter.emit('chunk', { type: 'synthesis-done', stats: synthResult.stats, error: synthResult.error });
    await recordAppliedInterjections(doc, synthesisInterjections, 0, emitter);
    clearTimeout(totalTimer);

    doc = await Roundtable.findById(roundtableId);
    if (doc.status !== 'running') return;

    if (synthResult.error || !String(synthResult.response || '').trim()) {
      throw new Error(`Council synthesis failed: ${synthResult.error || 'no response returned'}`);
    }

    const totalDurationMs = Date.now() - startTime;
    const decisionStatus = doc.governance?.requireApproval ? 'awaiting_approval' : 'advisory';
    const completedAt = new Date();
    await Roundtable.updateOne(
      { _id: roundtableId },
      { $set: {
        synthesis: {
          model: synthesizer.model, target: synthResult.target, hostName: synthResult.hostName,
          response: synthResult.response, thinking: null, error: synthResult.error,
          stats: synthResult.stats, startedAt: synthResult.startedAt, completedAt: synthResult.completedAt
        },
        'synthesizerConfig.resolvedTarget': synthResult.target,
        'synthesizerConfig.resolvedHostName': synthResult.hostName,
        'governance.decisionStatus': decisionStatus,
        'governance.requestedAt': doc.governance?.requireApproval ? completedAt : null,
        status: 'completed', totalDurationMs, completedAt
      } }
    );

    doc = await Roundtable.findById(roundtableId);
    logger.info('Roundtable completed', { roundtableId, totalDurationMs, turns: allTurns.length });
    if (emitter) emitter.emit('chunk', {
      type: 'done', status: 'completed', totalDurationMs, decisionStatus
    });
  } catch (err) {
    logger.error('Roundtable failed', { roundtableId, error: err.message });
    await Roundtable.updateOne(
      { _id: roundtableId },
      { $set: { status: 'failed', error: err.message, totalDurationMs: Date.now() - startTime, completedAt: new Date() } }
    ).catch(() => {});
    if (emitter) emitter.emit('chunk', { type: 'done', status: 'failed', error: err.message });
  } finally {
    emitterRegistry.delete(roundtableId);
  }
}

async function createRoundtable(options) {
  const {
    question,
    rounds = 2,
    panel = DEFAULT_PANEL,
    synthesizer = DEFAULT_SYNTHESIZER,
    source = 'api',
    tags = [],
    governance = {}
  } = options;

  // Merge partial overrides (UI may ship model-only changes) onto defaults keyed by agentId.
  const defaultByAgent = {};
  for (const d of DEFAULT_PANEL) defaultByAgent[d.agentId] = d;

  if (!Array.isArray(panel) || panel.length === 0) {
    const err = new Error('panel must contain at least one participant');
    err.status = 400;
    throw err;
  }
  const seenAgentIds = new Set();
  const mergedPanel = panel.map((a) => {
    const dflt = defaultByAgent[a.agentId] || {};
    const agentId = String(a.agentId || '').trim();
    const runtime = String(a.runtime || dflt.runtime || 'model').toLowerCase();
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(agentId)) {
      const err = new Error('panel agentId is missing or invalid');
      err.status = 400;
      throw err;
    }
    if (seenAgentIds.has(agentId)) {
      const err = new Error(`duplicate panel agentId: ${agentId}`);
      err.status = 400;
      throw err;
    }
    seenAgentIds.add(agentId);
    if (!['model', 'codex'].includes(runtime)) {
      const err = new Error(`unsupported participant runtime: ${runtime}`);
      err.status = 400;
      throw err;
    }
    const model = String(a.model || dflt.model || (runtime === 'model' ? '' : 'runtime-managed')).trim();
    if (runtime === 'model' && !model) {
      const err = new Error(`model is required for participant ${agentId}`);
      err.status = 400;
      throw err;
    }
    return {
      agentId,
      role: a.role || dflt.role || agentId,
      runtime,
      model,
      runtimeConfig: {
        sessionKey: a.runtimeConfig?.sessionKey || null,
        sessionId: a.runtimeConfig?.sessionId || null
      },
      systemPrompt: a.systemPrompt || dflt.systemPrompt || '',
      enableWebSearch: a.enableWebSearch ?? dflt.enableWebSearch ?? false
    };
  });

  const mergedSynthesizer = {
    model: synthesizer.model || DEFAULT_SYNTHESIZER.model,
    systemPrompt: synthesizer.systemPrompt || DEFAULT_SYNTHESIZER.systemPrompt
  };
  if (!String(mergedSynthesizer.model || '').trim()) {
    const err = new Error('synthesizer model is required; select a configured or discovered model');
    err.status = 400;
    err.code = 'COUNCIL_MODEL_REQUIRED';
    throw err;
  }

  return Roundtable.create({
    question,
    rounds: Math.min(Math.max(rounds, 1), 3),
    panelConfig: mergedPanel,
    synthesizerConfig: mergedSynthesizer,
    governance: {
      requireApproval: Boolean(governance.requireApproval),
      decisionStatus: 'deliberating'
    },
    status: 'pending',
    source,
    tags
  });
}

async function getRoundtable(id) {
  return Roundtable.findById(id);
}

async function listRoundtables({ limit = 20, skip = 0 } = {}) {
  const [docs, total] = await Promise.all([
    Roundtable.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Roundtable.countDocuments({})
  ]);
  return { docs, total };
}

module.exports = {
  callAgent,
  buildPinnedAgentPayload,
  assessModelParticipantReadiness,
  isSystemicParticipantFailure,
  participantRouteKey,
  callAgentStreaming,
  buildSynthesisRequest,
  executeRound,
  runRoundtable,
  createRoundtable,
  getRoundtable,
  listRoundtables,
  emitterRegistry
};
