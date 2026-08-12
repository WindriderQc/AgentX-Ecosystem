/**
 * OpenClaw Gateway Client
 *
 * HTTP + WebSocket client for controlling OpenClaw agents from AgentX.
 * Talks to the OpenClaw Gateway on port 18789 (configurable).
 *
 * Self-contained integration layer — extraction-ready for a future
 * standalone service if core needs to stay lean.
 *
 * Features:
 *   - Gateway RPC via POST /tools/invoke
 *   - Agent listing, session tracking, config management
 *   - Chat streaming via OpenResponses SSE endpoint
 *   - TTL cache with stale-while-revalidate for status/agents
 *   - Graceful degradation when Gateway is offline
 */

const { Readable } = require('stream');
const { existsSync, readFileSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');
const logger = require('../../config/logger');
const { getOpenClawControlUiConfig } = require('./openclawControlUiService');

// ── Config ──────────────────────────────────────

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:18789';
const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10_000;       // 10 s for live data
const STALE_MAX_MS = 60_000;       // serve stale up to 60 s during outages

function getOpenClawHome() {
  return process.env.OPENCLAW_HOME || join(homedir(), '.openclaw');
}

function getOpenClawConfigPath() {
  return join(getOpenClawHome(), 'openclaw.json');
}

function parseExplicitToggle(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function isOpenClawIntegrationEnabled() {
  const explicit = parseExplicitToggle(
    process.env.AGENTX_OPENCLAW_ENABLED ?? process.env.OPENCLAW_INTEGRATION_ENABLED
  );
  if (explicit !== null) return explicit;

  if (process.env.OPENCLAW_GATEWAY_URL) return true;
  if (process.env.OPENCLAW_INVENTORY_SSH_TARGET) return true;
  return existsSync(getOpenClawConfigPath());
}

function getOpenClawRuntimeConfig() {
  const gatewayUrl = getGatewayUrl();
  return {
    enabled: isOpenClawIntegrationEnabled(),
    home: getOpenClawHome(),
    configPath: getOpenClawConfigPath(),
    gatewayUrl,
    controlUi: getOpenClawControlUiConfig({ gatewayUrl })
  };
}

/** Read openclaw.json config once and cache it. */
let _openclawConfig = null;
function readOpenClawConfig() {
  if (_openclawConfig) return _openclawConfig;
  try {
    const configPath = getOpenClawConfigPath();
    _openclawConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    _openclawConfig = {};
  }
  return _openclawConfig;
}

function getGatewayUrl() {
  if (process.env.OPENCLAW_GATEWAY_URL) return process.env.OPENCLAW_GATEWAY_URL;
  const config = readOpenClawConfig();
  const port = config?.gateway?.port;
  if (port) return `http://127.0.0.1:${port}`;
  return DEFAULT_GATEWAY_URL;
}

function getGatewayToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  const config = readOpenClawConfig();
  return config?.gateway?.auth?.token || '';
}

/**
 * Build the official Control UI launch URL using OpenClaw's supported
 * `#token=...` browser handoff. The fragment is never sent to the HTTP server;
 * the Control UI consumes it and remembers the credential in browser storage.
 * Keep this helper server-side so the token is not embedded in rendered HTML.
 */
function getOpenClawControlLaunchUrl(target = 'chat', query = {}) {
  const controlUi = getOpenClawControlUiConfig({ gatewayUrl: getGatewayUrl() });
  const capability = controlUi.nativeCapabilities.find((item) => item.id === target);
  if (!capability?.href) {
    throw new OpenClawClientError('Unknown OpenClaw Control UI target', {
      status: 400,
      code: 'OPENCLAW_CONTROL_TARGET_INVALID'
    });
  }

  const tokenValue = getGatewayToken();
  const token = typeof tokenValue === 'string' ? tokenValue.trim() : '';
  if (!token) {
    throw new OpenClawClientError('OpenClaw gateway token is not configured in AgentX', {
      status: 503,
      code: 'OPENCLAW_CONTROL_TOKEN_UNAVAILABLE'
    });
  }

  const url = new URL(capability.href);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && String(value) !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  url.hash = `token=${encodeURIComponent(token)}`;
  return url.toString();
}

// ── Errors ──────────────────────────────────────

class OpenClawClientError extends Error {
  constructor(message, { status = 502, code = 'OPENCLAW_CLIENT_ERROR' } = {}) {
    super(message);
    this.name = 'OpenClawClientError';
    this.status = status;
    this.code = code;
  }
}

function parseSseFrame(frame) {
  let event = 'message';
  const data = [];
  for (const line of String(frame || '').split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim() || 'message';
    } else if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trimStart());
    }
  }
  return { event, data: data.join('\n') };
}

function createSseParser(onFrame) {
  let buffer = '';
  function drain(final = false) {
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (frame.trim()) onFrame(parseSseFrame(frame));
    }
    if (final && buffer.trim()) {
      onFrame(parseSseFrame(buffer));
      buffer = '';
    }
  }
  return {
    push(chunk) {
      buffer += String(chunk || '');
      drain(false);
    },
    finish() {
      drain(true);
    }
  };
}

function extractCompletedResponseText(payload) {
  const response = payload?.response || payload;
  const output = Array.isArray(response?.output) ? response.output : [];
  return output
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

// ── Client ──────────────────────────────────────

class OpenClawClient {
  constructor() {
    this._cache = new Map();
  }

  // ── Low-level Gateway call ──────────────────

  /**
   * Call the Gateway /tools/invoke endpoint.
   * @param {string} tool  - Tool name (e.g. 'exec', 'read', 'write')
   * @param {Object} args  - Tool arguments
   * @param {Object} [opts]
   * @param {number} [opts.timeout] - Fetch timeout in ms
   * @returns {Promise<*>} Parsed result payload
   */
  async invoke(tool, args = {}, { timeout = FETCH_TIMEOUT_MS } = {}) {
    const url = `${getGatewayUrl()}/tools/invoke`;
    const token = getGatewayToken();

    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tool, args, action: 'json' }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new OpenClawClientError(
          `Gateway returned ${response.status}: ${text}`,
          { status: response.status, code: 'GATEWAY_HTTP_ERROR' }
        );
      }

      const json = await response.json();
      if (json.ok === false) {
        throw new OpenClawClientError(
          json.error?.message || 'Gateway tool error',
          { status: 502, code: json.error?.code || 'GATEWAY_TOOL_ERROR' }
        );
      }

      return json.result ?? json;
    } catch (err) {
      if (err instanceof OpenClawClientError) throw err;
      if (err.name === 'AbortError') {
        throw new OpenClawClientError('Gateway request timed out', { code: 'GATEWAY_TIMEOUT' });
      }
      throw new OpenClawClientError(`Gateway unreachable: ${err.message}`, { code: 'GATEWAY_UNREACHABLE' });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Run a non-streaming turn through the Gateway's supported OpenResponses API.
   * Agent and session routing live in headers; `model: openclaw` keeps backend
   * selection under the chosen agent's configured model chain.
   * @param {string} [opts.instructions] - Per-request system instructions/context.
   */
  async respond(input, {
    agentId = 'main',
    sessionKey,
    instructions,
    timeout = 180_000,
  } = {}) {
    const url = `${getGatewayUrl().replace(/\/$/, '')}/v1/responses`;
    const token = getGatewayToken();
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-openclaw-agent-id': agentId,
    };
    if (sessionKey) headers['x-openclaw-session-key'] = sessionKey;
    if (token) headers.Authorization = `Bearer ${token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'openclaw',
          input,
          ...(instructions ? { instructions } : {}),
          stream: false
        }),
        signal: controller.signal,
      });
      const contentType = response.headers?.get?.('content-type') || '';
      const payload = contentType.includes('application/json')
        ? await response.json().catch(() => null)
        : await response.text().catch(() => '');
      if (!response.ok) {
        const detail = typeof payload === 'string' ? payload : JSON.stringify(payload);
        throw new OpenClawClientError(
          `Gateway OpenResponses returned ${response.status}: ${detail}`,
          { status: response.status, code: 'GATEWAY_RESPONSES_ERROR' }
        );
      }
      return payload;
    } catch (err) {
      if (err instanceof OpenClawClientError) throw err;
      if (err.name === 'AbortError') {
        throw new OpenClawClientError('Gateway OpenResponses request timed out', {
          code: 'GATEWAY_TIMEOUT'
        });
      }
      throw new OpenClawClientError(`Gateway unreachable: ${err.message}`, {
        code: 'GATEWAY_UNREACHABLE'
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Run a streaming turn through OpenResponses and expose only assistant-text
   * deltas. Reasoning and tool events remain inside OpenClaw.
   */
  async respondStream(input, {
    agentId = 'main',
    sessionKey,
    instructions,
    timeout = 180_000,
    signal,
    onEvent,
    onDelta,
  } = {}) {
    const url = `${getGatewayUrl().replace(/\/$/, '')}/v1/responses`;
    const token = getGatewayToken();
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'x-openclaw-agent-id': agentId,
    };
    if (sessionKey) headers['x-openclaw-session-key'] = sessionKey;
    if (token) headers.Authorization = `Bearer ${token}`;

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener?.('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);
    let outputText = '';
    let completedPayload = null;
    let failedPayload = null;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'openclaw',
          input,
          ...(instructions ? { instructions } : {}),
          stream: true
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new OpenClawClientError(
          `Gateway OpenResponses returned ${response.status}: ${detail}`,
          { status: response.status, code: 'GATEWAY_RESPONSES_ERROR' }
        );
      }
      if (!response.body?.getReader) {
        throw new OpenClawClientError('Gateway OpenResponses stream is unavailable', {
          code: 'GATEWAY_STREAM_UNAVAILABLE'
        });
      }

      const parser = createSseParser(({ event, data: rawData }) => {
        if (!rawData || rawData === '[DONE]') return;
        let data;
        try {
          data = JSON.parse(rawData);
        } catch {
          data = { raw: rawData };
        }
        onEvent?.({ event, data });
        if (event === 'response.output_text.delta') {
          const delta = typeof data.delta === 'string' ? data.delta : '';
          if (delta) {
            outputText += delta;
            onDelta?.(delta, data);
          }
        } else if (event === 'response.completed') {
          completedPayload = data;
        } else if (event === 'response.failed') {
          failedPayload = data;
        }
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
        if (failedPayload) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
      parser.push(decoder.decode());
      parser.finish();

      if (failedPayload) {
        const message = failedPayload?.response?.error?.message
          || failedPayload?.error?.message
          || failedPayload?.message
          || 'Gateway OpenResponses stream failed';
        throw new OpenClawClientError(message, { code: 'GATEWAY_STREAM_FAILED' });
      }

      const completedText = extractCompletedResponseText(completedPayload);
      return {
        text: (outputText || completedText).trim(),
        response: completedPayload?.response || completedPayload,
      };
    } catch (err) {
      if (err instanceof OpenClawClientError) throw err;
      if (err.name === 'AbortError') {
        const cancelled = signal?.aborted;
        throw new OpenClawClientError(
          cancelled ? 'Gateway OpenResponses stream cancelled' : 'Gateway OpenResponses stream timed out',
          { status: cancelled ? 499 : 502, code: cancelled ? 'GATEWAY_ABORTED' : 'GATEWAY_TIMEOUT' }
        );
      }
      throw new OpenClawClientError(`Gateway unreachable: ${err.message}`, {
        code: 'GATEWAY_UNREACHABLE'
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abortFromCaller);
    }
  }

  /**
   * Execute a CLI command on the Gateway via the exec tool.
   * @param {string} command - Shell command to run
   * @param {number} [timeout] - Timeout in ms
   * @returns {Promise<string>} stdout
   */
  async exec(command, timeout = FETCH_TIMEOUT_MS) {
    const result = await this.invoke('exec', { command }, { timeout });
    // Normalize various output shapes the Gateway may return
    if (typeof result === 'string') return result;
    return result?.output || result?.stdout || result?.result || result?.text || JSON.stringify(result);
  }

  /**
   * Execute an openclaw CLI command and parse JSON output.
   * @param {string[]} args - CLI arguments (e.g. ['agents', '--json'])
   * @returns {Promise<*>} Parsed JSON
   */
  async cli(args, timeout = FETCH_TIMEOUT_MS) {
    const command = `openclaw ${args.join(' ')} --json`;
    const raw = await this.exec(command, timeout);
    // openclaw CLI may emit non-JSON lines before the JSON output
    const jsonStart = raw.indexOf('[') !== -1 && raw.indexOf('{') !== -1
      ? Math.min(raw.indexOf('['), raw.indexOf('{'))
      : raw.indexOf('[') !== -1 ? raw.indexOf('[') : raw.indexOf('{');
    if (jsonStart === -1) return raw;
    try {
      return JSON.parse(raw.slice(jsonStart));
    } catch {
      return raw;
    }
  }

  /**
   * Read a file from the OpenClaw filesystem via the read tool.
   * @param {string} filePath
   * @returns {Promise<string>}
   */
  async readFile(filePath) {
    const result = await this.invoke('read', { path: filePath });
    if (typeof result === 'string') return result;
    return result?.content || result?.output || result?.text || JSON.stringify(result);
  }

  // ── Cached wrapper ──────────────────────────

  async _cached(key, fetcher) {
    const entry = this._cache.get(key);
    const now = Date.now();

    if (entry && (now - entry.ts < CACHE_TTL_MS)) {
      return entry.data;
    }

    try {
      const data = await fetcher();
      this._cache.set(key, { data, ts: now });
      return data;
    } catch (err) {
      // Serve stale if within tolerance
      if (entry && (now - entry.ts < STALE_MAX_MS)) {
        logger.warn('OpenClaw: serving stale cache', { key, age: now - entry.ts });
        return entry.data;
      }
      throw err;
    }
  }

  // ── Gateway health ──────────────────────────

  /**
   * Check if the Gateway is reachable.
   * @returns {Promise<{ok: boolean, latencyMs: number, error?: string}>}
   */
  async healthCheck() {
    const start = Date.now();
    try {
      const url = `${getGatewayUrl().replace(/\/$/, '')}/health`;
      const token = getGatewayToken();
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);

      return { ok: response.ok, latencyMs: Date.now() - start, status: response.status };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, error: err.message };
    }
  }

  // ── Agents ──────────────────────────────────

  /**
   * List all OpenClaw agents from config.
   * Reads from openclaw.json (file-based, no RPC needed).
   * @returns {Promise<Array>}
   */
  async listAgents() {
    return this._cached('agents', () => {
      const config = readOpenClawConfig();
      const agentsList = config?.agents?.list || [];
      const defaults = config?.agents?.defaults || {};
      return Promise.resolve(agentsList.map(a => ({
        ...a,
        model: a.model || { primary: defaults?.model?.primary || 'unknown' },
        workspace: a.workspace || defaults?.workspace || '',
      })));
    });
  }

  /**
   * Get detailed status for a specific agent.
   * @param {string} agentId
   * @returns {Promise<Object>}
   */
  async getAgent(agentId) {
    const agents = await this.listAgents();
    return agents.find(a => a.id === agentId) || null;
  }

  // ── Sessions ────────────────────────────────

  /**
   * List all active sessions via openclaw CLI.
   * @returns {Promise<Array>}
   */
  async listSessions() {
    return this._cached('sessions', async () => {
      try {
        const result = await this.cli(['sessions', 'list']);
        return Array.isArray(result) ? result : result?.sessions || [];
      } catch {
        return []; // sessions CLI may not be available
      }
    });
  }

  // ── Config ──────────────────────────────────

  /**
   * Read the OpenClaw configuration (from file), with secrets redacted.
   * @returns {Promise<Object>}
   */
  async getConfig() {
    return this._cached('config', () => {
      _openclawConfig = null;
      const config = readOpenClawConfig();
      return Promise.resolve(_redactSecrets(config));
    });
  }

  /**
   * Patch the OpenClaw configuration via openclaw CLI.
   * @param {string} path - Config path (e.g. 'agents.defaults.model.primary')
   * @param {*} value - New value
   * @returns {Promise<string>}
   */
  async setConfig(path, value) {
    this._cache.delete('config');
    _openclawConfig = null;
    return this.exec(`openclaw config set ${path} ${JSON.stringify(value)}`);
  }

  // ── Models ──────────────────────────────────

  /**
   * Get available models from OpenClaw config.
   * @returns {Promise<Object>}
   */
  async getModels() {
    return this._cached('models', () => {
      const config = readOpenClawConfig();
      return Promise.resolve(config?.models || {});
    });
  }

  // ── Channels ────────────────────────────────

  /**
   * Get channel configuration.
   * @returns {Promise<Object>}
   */
  async getChannels() {
    return this._cached('channels', () => {
      const config = readOpenClawConfig();
      const channels = config?.channels || {};
      return Promise.resolve(Object.entries(channels).map(([id, cfg]) => ({
        id,
        label: id.charAt(0).toUpperCase() + id.slice(1),
        enabled: cfg.enabled !== false,
        connected: cfg.enabled && cfg.botToken ? true : false,
        icon: id === 'telegram' ? 'fa-paper-plane' : id === 'discord' ? 'fa-discord' : 'fa-plug',
        streaming: cfg.streaming || null,
        dmPolicy: cfg.dmPolicy || null,
        // Never expose tokens
      })));
    });
  }

  // ── Chat ────────────────────────────────────
  // OpenClaw chat is handled by the official Control UI. AgentX only links to it.

  // ── Memory ──────────────────────────────────

  /**
   * List memory entries for an agent by reading its memory directory.
   * @param {string} agentId
   * @returns {Promise<Array>}
   */
  async listMemory(agentId) {
    try {
      const config = readOpenClawConfig();
      const agent = (config?.agents?.list || []).find(a => a.id === agentId);
      const workspace = agent?.workspace || config?.agents?.defaults?.workspace;
      if (!workspace) return [];
      const result = await this.exec(`ls -1 "${workspace}/memory/" 2>/dev/null || echo "[]"`);
      if (result.startsWith('[')) return [];
      return result.split('\n').filter(Boolean).map(f => ({ file: f, agent: agentId }));
    } catch {
      return [];
    }
  }

  // ── Cron ────────────────────────────────────

  /**
   * List all cron jobs from the cron config directory.
   * @returns {Promise<Array>}
   */
  async listCronJobs() {
    return this._cached('cron', async () => {
      try {
        const home = process.env.OPENCLAW_HOME || join(homedir(), '.openclaw');
        const cronDir = join(home, 'cron');
        const { readdirSync, readFileSync: readSync } = require('fs');
        const files = readdirSync(cronDir).filter(f => f.endsWith('.json'));
        return files.map(f => {
          try {
            return JSON.parse(readSync(join(cronDir, f), 'utf-8'));
          } catch { return { file: f, error: 'parse error' }; }
        });
      } catch {
        return [];
      }
    });
  }

  // ── Utilities ───────────────────────────────

  clearCache() { this._cache.clear(); }
}

// ── Secret redaction ──────────────────────────

const SENSITIVE_KEYS = new Set(['token', 'botToken', 'apiKey', 'secret', 'password', 'api_key']);

function _redactSecrets(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(_redactSecrets);
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k) && typeof v === 'string') {
      result[k] = v.length > 8 ? v.slice(0, 4) + '****' + v.slice(-4) : '****';
    } else if (typeof v === 'object' && v !== null) {
      result[k] = _redactSecrets(v);
    } else {
      result[k] = v;
    }
  }
  return result;
}

// ── Singleton ─────────────────────────────────

let _client = null;

function getOpenClawClient() {
  if (!_client) _client = new OpenClawClient();
  return _client;
}

module.exports = {
  OpenClawClient,
  OpenClawClientError,
  getOpenClawClient,
  getOpenClawRuntimeConfig,
  getOpenClawControlLaunchUrl,
  getOpenClawHome,
  getOpenClawConfigPath,
  isOpenClawIntegrationEnabled,
};
