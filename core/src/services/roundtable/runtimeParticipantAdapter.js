/**
 * Runtime participant adapters for Roundtable v2.
 *
 * Model participants stay in orchestrator.js. This module talks to real
 * OpenClaw/Hermes identities over the existing SSH trust and to an optional
 * Codex bridge whose URL is server-owned configuration. Request payloads can
 * select identities/sessions, but never commands, hosts, tokens, or URLs.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fetch = require('node-fetch');

const execFileAsync = promisify(execFile);
const RUNTIME_TYPES = new Set(['openclaw', 'hermes', 'codex']);
const MAX_PROMPT_CHARS = 30000;
const MAX_RESPONSE_CHARS = 20000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function assertSafeIdentifier(value, label) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(text)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return text;
}

function assertSafeSshTarget(value) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9._@:-]{1,200}$/.test(text)) {
    throw new Error('Roundtable runtime SSH target is missing or invalid');
  }
  return text;
}

function configuredOpenClawAgentIds(env) {
  return new Set(String(env.ROUNDTABLE_OPENCLAW_AGENT_ALLOWLIST || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean));
}

function configuredHermesToolsets(env) {
  const value = String(env.ROUNDTABLE_HERMES_TOOLSETS || '').trim();
  if (!/^[A-Za-z0-9_,.-]{1,200}$/.test(value)) {
    throw new Error('ROUNDTABLE_HERMES_TOOLSETS must name a dedicated bounded toolset');
  }
  return value;
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

function parseJsonOutput(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('runtime returned no output');
  try {
    return JSON.parse(text);
  } catch (_) {
    const starts = [];
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '{' || text[i] === '[') starts.push(i);
    }
    for (const start of starts) {
      try { return JSON.parse(text.slice(start)); } catch (_) { /* continue */ }
    }
    throw new Error('runtime did not return valid JSON');
  }
}

function extractOpenClawResponse(payload) {
  const root = payload?.result || payload || {};
  const payloadText = Array.isArray(root.payloads)
    ? root.payloads.map((item) => item?.text || '').filter(Boolean).join('\n')
    : '';
  const text = payloadText
    || root.response
    || root.text
    || root.content
    || root.message?.content
    || payload?.response
    || payload?.text
    || '';
  if (!String(text).trim()) throw new Error('OpenClaw returned no final response text');
  return String(text).trim().slice(0, MAX_RESPONSE_CHARS);
}

function extractHermesResponse(raw) {
  const text = String(raw || '')
    .replace(/^session(?:_id)?\s*:\s*\S+\s*$/gim, '')
    .trim();
  if (!text) throw new Error('Hermes returned no final response text');
  return text.slice(0, MAX_RESPONSE_CHARS);
}

async function defaultSshRunner(target, command, timeoutMs, env = process.env) {
  const sshBin = env.ROUNDTABLE_RUNTIME_SSH_BIN || env.OPENCLAW_INVENTORY_SSH_BIN || 'ssh';
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  const keyPath = env.ROUNDTABLE_RUNTIME_SSH_KEY_PATH
    || env.OPENCLAW_INVENTORY_SSH_KEY_PATH
    || env.OLLAMA_SSH_KEY_PATH;
  if (keyPath) args.push('-i', keyPath);
  args.push(target, command);
  const { stdout } = await execFileAsync(sshBin, args, {
    timeout: timeoutMs,
    maxBuffer: DEFAULT_MAX_BUFFER,
    windowsHide: true
  });
  return stdout;
}

function runtimeSshTarget(env) {
  return assertSafeSshTarget(
    env.ROUNDTABLE_RUNTIME_SSH_TARGET || env.OPENCLAW_INVENTORY_SSH_TARGET
  );
}

async function callOpenClaw(agent, prompt, context, deps) {
  const env = deps.env;
  const target = runtimeSshTarget(env);
  const cli = env.ROUNDTABLE_OPENCLAW_CLI || '/home/agentx/.npm-global/bin/openclaw';
  const agentId = assertSafeIdentifier(agent.agentId, 'OpenClaw agent id');
  if (!configuredOpenClawAgentIds(env).has(agentId)) {
    throw new Error(`OpenClaw agent is not allowlisted for Roundtable: ${agentId}`);
  }
  const configuredKey = agent.runtimeConfig?.sessionKey;
  const sessionKey = assertSafeIdentifier(
    configuredKey || `agent:${agentId}:roundtable-${context.roundtableId}`,
    'OpenClaw session key'
  );
  const timeoutSeconds = Math.max(10, Math.ceil(context.timeoutMs / 1000));
  const thinking = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max']
    .includes(env.ROUNDTABLE_OPENCLAW_THINKING)
    ? env.ROUNDTABLE_OPENCLAW_THINKING
    : 'medium';
  const command = [
    `PATH=${shellQuote(env.ROUNDTABLE_REMOTE_PATH || '/home/agentx/.npm-global/bin:/usr/local/bin:/usr/bin:/bin')}`,
    shellQuote(cli),
    'agent', '--agent', shellQuote(agentId),
    '--session-key', shellQuote(sessionKey),
    '--message', shellQuote(prompt),
    '--thinking', shellQuote(thinking),
    '--timeout', String(timeoutSeconds),
    '--json'
  ].join(' ');
  const raw = await deps.sshRunner(target, command, context.timeoutMs + 15000, env);
  return {
    response: extractOpenClawResponse(parseJsonOutput(raw)),
    target: `openclaw://agent/${agentId}`,
    hostName: target,
    runtimeRef: sessionKey
  };
}

async function callHermes(agent, prompt, context, deps) {
  const env = deps.env;
  const target = runtimeSshTarget(env);
  const python = env.ROUNDTABLE_HERMES_PYTHON
    || '/home/agentx/.hermes/hermes-agent/.venv/bin/python';
  const maxTurns = Math.max(1, Math.min(Number(env.ROUNDTABLE_HERMES_MAX_TURNS) || 4, 12));
  const toolsets = configuredHermesToolsets(env);
  const args = [
    shellQuote(python), '-m', 'hermes_cli.main', 'chat',
    '--query', shellQuote(prompt), '--quiet', '--source', 'tool',
    '--no-restore-cwd', '--max-turns', String(maxTurns),
    '--toolsets', shellQuote(toolsets)
  ];
  const sessionId = agent.runtimeConfig?.sessionId;
  if (sessionId) {
    args.push('--resume', shellQuote(assertSafeIdentifier(sessionId, 'Hermes session id')));
  }
  const raw = await deps.sshRunner(target, args.join(' '), context.timeoutMs + 15000, env);
  return {
    response: extractHermesResponse(raw),
    target: 'hermes://agent/default',
    hostName: target,
    runtimeRef: sessionId || null
  };
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
    if (!enabled(env.ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED)) {
      throw new Error('Runtime participants are disabled; set ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED=true');
    }
    if (runtimes.has('openclaw') || runtimes.has('hermes')) runtimeSshTarget(env);
    if (runtimes.has('openclaw')) {
      const allowed = configuredOpenClawAgentIds(env);
      for (const agent of panel || []) {
        if (String(agent.runtime || 'model').toLowerCase() === 'openclaw' && !allowed.has(String(agent.agentId))) {
          throw new Error(`OpenClaw agent is not allowlisted for Roundtable: ${agent.agentId}`);
        }
      }
    }
    if (runtimes.has('hermes')) configuredHermesToolsets(env);
    if (runtimes.has('codex')) configuredBridgeUrl(env);
    return true;
  } catch (err) {
    err.status = err.status || 503;
    throw err;
  }
}

async function callCodex(agent, prompt, context, deps) {
  const env = deps.env;
  const url = configuredBridgeUrl(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (env.ROUNDTABLE_CODEX_BRIDGE_TOKEN) {
      headers.Authorization = `Bearer ${env.ROUNDTABLE_CODEX_BRIDGE_TOKEN}`;
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
  const deps = {
    env,
    fetchImpl: options.fetchImpl || fetch,
    sshRunner: options.sshRunner || defaultSshRunner
  };
  try {
    if (!RUNTIME_TYPES.has(runtime)) throw new Error(`Unsupported runtime participant: ${runtime}`);
    if (!enabled(env.ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED)) {
      throw new Error('Runtime participants are disabled; set ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED=true');
    }
    const prompt = buildRuntimePrompt(messages, agent);
    const callContext = { ...context, timeoutMs };
    const result = runtime === 'openclaw'
      ? await callOpenClaw(agent, prompt, callContext, deps)
      : runtime === 'hermes'
        ? await callHermes(agent, prompt, callContext, deps)
        : await callCodex(agent, prompt, callContext, deps);
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
  extractHermesResponse,
  extractOpenClawResponse,
  parseJsonOutput,
  shellQuote,
  validateRuntimeConfiguration
};
