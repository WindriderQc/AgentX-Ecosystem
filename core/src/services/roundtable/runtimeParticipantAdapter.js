/**
 * Optional Codex bridge for Roundtable v2.
 *
 * Model participants remain native to AgentX. This bounded HTTP bridge is the
 * only product-owned runtime adapter; private operator runtimes are integrated
 * outside this repository.
 */

const fetch = require('node-fetch');

const RUNTIME_TYPES = new Set(['codex']);
const MAX_PROMPT_CHARS = 30000;
const MAX_RESPONSE_CHARS = 20000;

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function buildRuntimePrompt(messages, agent) {
  const transcript = (messages || []).map((message) => {
    const role = String(message.role || 'user').toUpperCase();
    return `[${role}]\n${String(message.content || '')}`;
  }).join('\n\n');
  const guard = [
    'You are participating in an AgentX Roundtable deliberation.',
    `Speak as ${agent.role || agent.agentId}.`,
    'This turn is advisory only: do not execute commands, modify files, send messages, or change external state.',
    'Return only your concise position, evidence, disagreements, and recommended next step.',
    'Do not reveal hidden chain-of-thought or private credentials.'
  ].join(' ');
  const transcriptBudget = Math.max(0, MAX_PROMPT_CHARS - guard.length - 2);
  return `${guard}\n\n${transcript.slice(-transcriptBudget)}`;
}

function configuredBridgeUrl(env) {
  const raw = env.ROUNDTABLE_CODEX_BRIDGE_URL;
  if (!raw) throw new Error('ROUNDTABLE_CODEX_BRIDGE_URL is not configured');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Codex bridge URL must use http or https');
  }
  return url.toString();
}

function validateRuntimeConfiguration(panel, env = process.env) {
  try {
    const runtimes = new Set((panel || []).map((agent) => String(agent.runtime || 'model').toLowerCase()));
    runtimes.delete('model');
    if (!runtimes.size) return true;
    const unsupported = [...runtimes].filter((runtime) => !RUNTIME_TYPES.has(runtime));
    if (unsupported.length) throw new Error(`Unsupported runtime participant: ${unsupported.join(', ')}`);
    if (!enabled(env.ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED)) {
      throw new Error('Runtime participants are disabled; set ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED=true');
    }
    configuredBridgeUrl(env);
    return true;
  } catch (err) {
    err.status = err.status || 503;
    throw err;
  }
}

async function callCodex(agent, prompt, context, deps) {
  const url = configuredBridgeUrl(deps.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (deps.env.ROUNDTABLE_CODEX_BRIDGE_TOKEN) {
      headers.Authorization = `Bearer ${deps.env.ROUNDTABLE_CODEX_BRIDGE_TOKEN}`;
    }
    const response = await deps.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: prompt,
        sessionKey: agent.runtimeConfig?.sessionKey || `roundtable-${context.roundtableId}`,
        metadata: { roundtableId: context.roundtableId, round: context.round, agentId: agent.agentId }
      }),
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || body.message || `Codex bridge returned ${response.status}`);
    const text = body.response || body.text || body.result?.response || body.result?.text;
    if (!String(text || '').trim()) throw new Error('Codex bridge returned no final response text');
    return {
      response: String(text).trim().slice(0, MAX_RESPONSE_CHARS),
      target: 'codex://bridge',
      hostName: new URL(url).host,
      runtimeRef: body.sessionId || body.sessionKey || null
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callRuntimeParticipant(agent, messages, context = {}, options = {}) {
  const startedAt = new Date();
  const env = options.env || process.env;
  const runtime = String(agent.runtime || 'model').toLowerCase();
  const timeoutMs = Math.max(1000, Number(context.timeoutMs) || 120000);
  try {
    if (!RUNTIME_TYPES.has(runtime)) throw new Error(`Unsupported runtime participant: ${runtime}`);
    if (!enabled(env.ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED)) {
      throw new Error('Runtime participants are disabled; set ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED=true');
    }
    const result = await callCodex(agent, buildRuntimePrompt(messages, agent), { ...context, timeoutMs }, {
      env,
      fetchImpl: options.fetchImpl || fetch,
    });
    const completedAt = new Date();
    return {
      response: result.response,
      thinking: null,
      stats: { tokensPerSecond: null, latencyMs: completedAt - startedAt },
      error: null,
      target: result.target,
      hostName: result.hostName,
      runtime,
      runtimeRef: result.runtimeRef,
      startedAt,
      completedAt
    };
  } catch (err) {
    const completedAt = new Date();
    return {
      response: '', thinking: null,
      stats: { tokensPerSecond: null, latencyMs: completedAt - startedAt },
      error: err.name === 'AbortError' ? `Timeout after ${timeoutMs}ms` : err.message,
      target: `${runtime}://unavailable`, hostName: null, runtime, runtimeRef: null,
      startedAt, completedAt
    };
  }
}

module.exports = {
  RUNTIME_TYPES,
  buildRuntimePrompt,
  callRuntimeParticipant,
  validateRuntimeConfiguration
};
