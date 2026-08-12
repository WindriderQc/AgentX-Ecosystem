'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
  loadRemoteAgentsConfig,
} = require('./openclawRemoteConfigProjection');

const execFileAsync = promisify(execFile);

const PROMPT_FILE_NAMES = [
  'IDENTITY.md',
  'SOUL.md',
  'AGENTS.md',
  'TOOLS.md',
  'USER.md',
  'MEMORY.md',
];

const DEFAULT_COMMAND_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_CONTENT_CHARS = 4000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_REMOTE_OPENCLAW_HOME = '/home/agentx/.openclaw';
const LOCAL_MODEL_PREFIXES = ['ollama/', 'host-alpha-ollama/', 'host-gamma-ollama/', 'host-beta-ollama/'];

function getDefaultOpenClawHome() {
  return process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
}

function getDefaultConfigPath(openclawHome = getDefaultOpenClawHome()) {
  return process.env.OPENCLAW_CONFIG_PATH || path.join(openclawHome, 'openclaw.json');
}

function stableNow(options = {}) {
  return options.generatedAt || new Date().toISOString();
}

function sha256(textOrBuffer) {
  return crypto.createHash('sha256').update(textOrBuffer).digest('hex');
}

function normalizeAgentId(id) {
  return String(id || '').trim();
}

function workspaceIdFromPath(workspacePath) {
  const base = path.basename(String(workspacePath || '').replace(/[\\\/]+$/, ''));
  return base.startsWith('workspace-') ? base.slice('workspace-'.length) : base;
}

function isLocalModel(model) {
  const value = String(model || '').trim();
  return LOCAL_MODEL_PREFIXES.some(prefix => value.startsWith(prefix));
}

function getAgentsSection(configOrAgents = {}) {
  if (configOrAgents && configOrAgents.agents) return configOrAgents.agents;
  return configOrAgents || {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (String(value || '').trim()) return value;
  }
  return null;
}

function normalizeStrictHostKey(value) {
  const raw = String(value ?? 'no').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return 'yes';
  if (['0', 'false', 'no', 'off', ''].includes(raw)) return 'no';
  return raw;
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function toById(items, idKey = 'id') {
  const out = new Map();
  for (const item of safeArray(items)) {
    const id = normalizeAgentId(item && item[idKey]);
    if (id) out.set(id, item);
  }
  return out;
}

function redactSensitiveText(text) {
  if (!text) return '';
  let redacted = String(text);

  redacted = redacted.replace(
    /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g,
    '[REDACTED_SECRET]'
  );
  redacted = redacted.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi,
    '$1 [REDACTED_SECRET]'
  );
  redacted = redacted.replace(
    /^(\s*(?:api[_-]?key|token|secret|password|authorization|bearer|refresh[_-]?token|botToken)\s*[:=]\s*).+$/gim,
    '$1[REDACTED_SECRET]'
  );

  return redacted;
}

function truncateContent(text, maxChars = DEFAULT_MAX_CONTENT_CHARS) {
  const value = String(text || '');
  if (value.length <= maxChars) {
    return { content: value, truncated: false, originalChars: value.length };
  }
  return {
    content: value.slice(0, maxChars),
    truncated: true,
    originalChars: value.length,
  };
}

function sanitizeContent(text, options = {}) {
  const maxChars = Number(options.maxContentChars) || DEFAULT_MAX_CONTENT_CHARS;
  const redacted = redactSensitiveText(text);
  return truncateContent(redacted, maxChars);
}

function isSensitivePromptFile(fileName) {
  return fileName === 'USER.md';
}

async function readJsonFile(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildSshArgs(target, command, options = {}) {
  const strict = normalizeStrictHostKey(
    options.sshStrictHostKeyChecking
      ?? process.env.OPENCLAW_INVENTORY_SSH_STRICT_HOST_KEY_CHECKING
      ?? process.env.OLLAMA_SSH_STRICT_HOST_KEY_CHECKING
      ?? 'no'
  );
  const args = [
    '-o', 'BatchMode=yes',
    '-o', `StrictHostKeyChecking=${strict}`,
  ];
  if (strict === 'no') {
    args.push('-o', 'UserKnownHostsFile=/dev/null');
  }

  const port = firstNonEmpty(options.sshPort, process.env.OPENCLAW_INVENTORY_SSH_PORT);
  if (port) args.push('-p', String(port));

  const keyPath = firstNonEmpty(
    options.sshKeyPath,
    process.env.OPENCLAW_INVENTORY_SSH_KEY_PATH,
    process.env.OLLAMA_SSH_KEY_PATH
  );
  if (keyPath) args.push('-i', String(keyPath));

  args.push(target, command);
  return args;
}

async function runSshCommand(target, command, options = {}) {
  if (!target) throw new Error('Missing OpenClaw inventory SSH target');
  if (typeof options.sshRunner === 'function') {
    return options.sshRunner(target, command, options);
  }

  const bin = options.sshBin || process.env.OPENCLAW_INVENTORY_SSH_BIN || 'ssh';
  const timeout = Number(
    options.remoteCommandTimeoutMs
      || options.commandTimeoutMs
      || process.env.OPENCLAW_INVENTORY_TIMEOUT_MS
  ) || DEFAULT_COMMAND_TIMEOUT_MS;

  const { stdout } = await execFileAsync(bin, buildSshArgs(target, command, options), {
    timeout,
    maxBuffer: DEFAULT_MAX_BUFFER * 3,
    windowsHide: true,
  });
  return stdout;
}

async function runSshJson(target, command, options = {}) {
  const raw = await runSshCommand(target, command, options);
  return JSON.parse(String(raw || '').trim() || 'null');
}

function remotePromptFilesCommand(openclawHome, includeContent) {
  const include = includeContent ? 'true' : 'false';
  return `OPENCLAW_HOME=${shellSingleQuote(openclawHome)} INCLUDE_CONTENT=${include} python3 - <<'PY'
import hashlib, json, os, pathlib

root = pathlib.Path(os.environ.get("OPENCLAW_HOME", "/home/agentx/.openclaw"))
include_content = os.environ.get("INCLUDE_CONTENT") == "true"
names = ["IDENTITY.md", "SOUL.md", "AGENTS.md", "TOOLS.md", "USER.md", "MEMORY.md"]
records = []

for workspace in sorted(root.glob("workspace-*")):
    if not workspace.is_dir():
        continue
    for name in names:
        p = workspace / name
        if not p.exists():
            records.append({
                "workspace": str(workspace),
                "name": name,
                "path": str(p),
                "missing": True,
                "exists": False,
            })
            continue
        data = p.read_bytes()
        record = {
            "workspace": str(workspace),
            "name": name,
            "path": str(p),
            "exists": True,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
        if include_content:
            record["content"] = data.decode("utf-8", errors="replace")
        records.append(record)

print(json.dumps(records, ensure_ascii=False))
PY`;
}

function remoteCliEnvPrefix(options = {}) {
  const cliHome = firstNonEmpty(
    options.remoteCliOpenClawHome,
    process.env.OPENCLAW_INVENTORY_REMOTE_CLI_HOME
  );
  return cliHome ? `OPENCLAW_HOME=${shellSingleQuote(cliHome)} ` : '';
}

async function readPromptFile(filePath, fileName, options = {}) {
  try {
    const raw = await fsp.readFile(filePath);
    const text = raw.toString('utf8');
    const result = {
      path: filePath,
      exists: true,
      bytes: raw.length,
      sha256: sha256(raw),
    };

    if (options.includeContent) {
      const sanitized = sanitizeContent(text, options);
      result.contentMode = 'bounded_redacted';
      result.contentPrivate = isSensitivePromptFile(fileName);
      result.content = sanitized.content;
      result.truncated = sanitized.truncated;
      result.originalChars = sanitized.originalChars;
    } else {
      result.contentMode = 'metadata_only';
    }

    return result;
  } catch (err) {
    return {
      path: filePath,
      exists: false,
      missing: true,
      error: err.code || err.message,
    };
  }
}

async function readWorkspacePromptFiles(workspacePath, options = {}) {
  const files = {};
  for (const fileName of PROMPT_FILE_NAMES) {
    files[fileName] = await readPromptFile(path.join(workspacePath, fileName), fileName, options);
  }
  return files;
}

function promptRecordMap(records = []) {
  const byWorkspace = new Map();
  for (const record of safeArray(records)) {
    const workspace = record.workspace || (record.path ? path.dirname(record.path) : null);
    const name = record.name || record.file || (record.path ? path.basename(record.path) : null);
    if (!workspace || !name) continue;
    if (!byWorkspace.has(workspace)) byWorkspace.set(workspace, {});

    const clean = {
      path: record.path || path.join(workspace, name),
      exists: record.exists !== false && !record.missing,
      bytes: record.bytes ?? null,
      sha256: record.sha256 || null,
      contentMode: record.content ? 'bounded_redacted' : 'metadata_only',
    };
    if (record.missing) {
      clean.exists = false;
      clean.missing = true;
    }
    if (record.content != null) {
      const sanitized = sanitizeContent(record.content, record);
      clean.contentMode = 'bounded_redacted';
      clean.contentPrivate = isSensitivePromptFile(name);
      clean.content = sanitized.content;
      clean.truncated = sanitized.truncated;
      clean.originalChars = sanitized.originalChars;
    }
    byWorkspace.get(workspace)[name] = clean;
  }
  return byWorkspace;
}

async function getPromptFilesForWorkspace(workspacePath, options = {}) {
  const records = options.promptRecordMap && options.promptRecordMap.get(workspacePath);
  if (records) {
    const merged = {};
    for (const fileName of PROMPT_FILE_NAMES) {
      merged[fileName] = records[fileName] || {
        path: path.posix.join(workspacePath, fileName),
        exists: false,
        missing: true,
        contentMode: 'metadata_only',
      };
    }
    return merged;
  }
  return readWorkspacePromptFiles(workspacePath, options);
}

async function listWorkspaceDirs(openclawHome, knownWorkspaces = [], options = {}) {
  const dirs = new Set(knownWorkspaces.filter(Boolean));
  for (const record of safeArray(options.promptFileRecords)) {
    if (record.workspace) dirs.add(record.workspace);
  }

  if (await pathExists(openclawHome)) {
    try {
      const entries = await fsp.readdir(openclawHome, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('workspace-')) {
          dirs.add(path.join(openclawHome, entry.name));
        }
      }
    } catch {
      // Degrade gracefully; known workspaces are enough for a partial inventory.
    }
  }

  return Array.from(dirs).sort();
}

function summarizeMemoryStatus(memoryStatusRaw) {
  const statuses = Array.isArray(memoryStatusRaw)
    ? memoryStatusRaw
    : memoryStatusRaw && memoryStatusRaw.agentId
      ? [memoryStatusRaw]
      : [];

  const byId = new Map();
  for (const item of statuses) {
    const agentId = normalizeAgentId(item.agentId || item.status?.agentId);
    if (agentId) byId.set(agentId, item);
  }
  return byId;
}

function normalizeMemory(agentId, memoryStatusById, promptFiles, options = {}) {
  const item = memoryStatusById.get(agentId);
  const status = item?.status || item || {};
  const custom = status.custom || {};
  const indexIdentity = custom.indexIdentity || {};
  const scanIssues = safeArray(item?.scan?.issues);
  const sourceIssues = safeArray(item?.scan?.sources).flatMap(source => safeArray(source.issues));
  const issues = Array.from(new Set([...scanIssues, ...sourceIssues]));
  const memoryFile = promptFiles && promptFiles['MEMORY.md'];

  if (memoryFile && memoryFile.missing) {
    issues.push('MEMORY.md missing from workspace root');
  }

  const indexStatus = options.memoryStatusSource === 'skipped' && !item
    ? 'unknown'
    : indexIdentity.status || (status.dirty ? 'dirty' : status.dbPath ? 'unknown' : 'unavailable');

  return {
    dbPath: status.dbPath || null,
    provider: status.provider || null,
    model: status.model || null,
    searchMode: custom.searchMode || null,
    indexStatus,
    dirty: Boolean(status.dirty),
    files: status.files ?? null,
    chunks: status.chunks ?? null,
    sources: safeArray(status.sources),
    cacheEntries: status.cache?.entries ?? null,
    ftsEnabled: status.fts?.enabled ?? null,
    vectorEnabled: status.vector?.enabled ?? null,
    vectorDims: status.vector?.dims ?? null,
    skipped: options.memoryStatusSource === 'skipped' && !item,
    issues,
  };
}

function normalizeModel(agentConfig = {}, observedAgent = {}, defaults = {}) {
  const configured = agentConfig.model || {};
  const defaultModel = defaults.model || {};
  const primary = configured.primary || observedAgent.model || defaultModel.primary || null;
  const fallbacks = safeArray(configured.fallbacks || defaultModel.fallbacks);
  const localFallbacks = fallbacks.filter(isLocalModel);
  return {
    primary,
    fallbacks,
    cloudPrimary: primary ? !isLocalModel(primary) : false,
    localFallbacks,
    hasLocalFallback: localFallbacks.length > 0,
  };
}

function normalizeTools(agentConfig = {}) {
  const tools = agentConfig.tools || {};
  const result = {
    profile: tools.profile || null,
    alsoAllow: safeArray(tools.alsoAllow),
  };
  if (tools.exec) {
    result.exec = {
      host: tools.exec.host || null,
      security: tools.exec.security || null,
      ask: tools.exec.ask || null,
      timeoutSeconds: tools.exec.timeoutSec ?? tools.exec.timeoutSeconds ?? null,
    };
  }
  if (tools.no_exec || tools.noExec) result.noExec = true;
  return result;
}

function normalizeBootstrap(agentConfig = {}) {
  const bootstrap = {};
  if (agentConfig.thinkingDefault != null) bootstrap.thinkingDefault = agentConfig.thinkingDefault;
  if (agentConfig.bootstrapMaxChars != null) bootstrap.bootstrapMaxChars = agentConfig.bootstrapMaxChars;
  if (agentConfig.bootstrapTotalMaxChars != null) bootstrap.bootstrapTotalMaxChars = agentConfig.bootstrapTotalMaxChars;
  if (Array.isArray(agentConfig.skills)) bootstrap.skills = agentConfig.skills;
  return bootstrap;
}

function normalizeMemoryStrategy(defaults = {}) {
  const memorySearch = defaults.memorySearch || {};
  const hybrid = memorySearch.query?.hybrid || {};
  return {
    enabled: memorySearch.enabled ?? null,
    provider: memorySearch.provider || null,
    model: memorySearch.model || null,
    fallback: memorySearch.fallback || null,
    sources: memorySearch.sources || ['memory'],
    searchMode: hybrid.enabled ? 'hybrid' : null,
    hybridWeights: hybrid.enabled ? {
      vector: hybrid.vectorWeight ?? null,
      text: hybrid.textWeight ?? null,
    } : null,
  };
}

function addGap(gaps, id, severity, detail, extra = {}) {
  gaps.push({ id, severity, detail, ...extra });
}

function appendAgentGaps(gaps, agent) {
  if (agent.model.cloudPrimary && !agent.model.hasLocalFallback) {
    addGap(
      gaps,
      `${agent.id}-missing-local-fallback`,
      'high',
      `Cloud-primary agent ${agent.id} has no local fallback.`,
      { agentId: agent.id }
    );
  }
  if (agent.memory.dirty || !['valid', 'unknown'].includes(agent.memory.indexStatus)) {
    addGap(
      gaps,
      `${agent.id}-memory-index-${agent.memory.indexStatus || 'unknown'}`,
      'medium',
      `Memory index for ${agent.id} is ${agent.memory.indexStatus || 'unknown'}.`,
      { agentId: agent.id }
    );
  }
  if (agent.promptFiles?.['MEMORY.md']?.missing) {
    addGap(
      gaps,
      `${agent.id}-missing-memory-md`,
      'medium',
      `${agent.id} has no root MEMORY.md file.`,
      { agentId: agent.id }
    );
  }
}

async function buildInventoryFromState(state = {}, options = {}) {
  const openclawHome = state.openclawHome || options.openclawHome || getDefaultOpenClawHome();
  const configPath = state.configPath || options.configPath || getDefaultConfigPath(openclawHome);
  const config = state.config || {};
  const agentsSection = getAgentsSection(config);
  const defaults = agentsSection.defaults || {};
  const configuredAgents = safeArray(agentsSection.list);
  const observedAgents = safeArray(state.agentList);
  const observedById = toById(observedAgents);
  const memoryStatusById = summarizeMemoryStatus(state.memoryStatus);
  const memoryStatusSource = state.memoryStatusSource
    || (options.includeMemoryStatus === false ? 'skipped' : null)
    || (state.memoryStatus ? 'provided' : 'unavailable');
  const promptFilesSource = state.promptFilesSource
    || (options.includePromptFiles === false ? 'skipped' : null)
    || (Array.isArray(state.promptFileRecords) ? 'provided' : 'filesystem');
  const promptFilesEnabled = promptFilesSource !== 'skipped' && promptFilesSource !== 'unavailable';
  const promptRecordsOnly = promptFilesSource.startsWith('ssh ');
  const recordMap = promptFilesEnabled ? promptRecordMap(state.promptFileRecords) : new Map();

  const activeIds = new Set([
    ...configuredAgents.map(agent => normalizeAgentId(agent.id)).filter(Boolean),
    ...observedAgents.map(agent => normalizeAgentId(agent.id)).filter(Boolean),
  ]);

  const knownWorkspaces = [
    defaults.workspace,
    ...configuredAgents.map(agent => agent.workspace),
    ...observedAgents.map(agent => agent.workspace || agent.workspaceDir),
  ].filter(Boolean);

  const workspaceDirs = await listWorkspaceDirs(openclawHome, knownWorkspaces, {
    ...options,
    promptFileRecords: state.promptFileRecords,
  });

  const gaps = [];
  const agentEntries = [];
  const getWorkspacePromptFiles = async (workspace) => {
    if (!workspace || !promptFilesEnabled) return {};
    if (promptRecordsOnly && !recordMap.has(workspace)) return {};
    return getPromptFilesForWorkspace(workspace, { ...options, promptRecordMap: recordMap });
  };

  for (const agentConfig of configuredAgents) {
    const id = normalizeAgentId(agentConfig.id);
    if (!id) continue;
    const observed = observedById.get(id) || {};
    const workspace = agentConfig.workspace || observed.workspace || observed.workspaceDir || defaults.workspace || null;
    const promptFiles = await getWorkspacePromptFiles(workspace);

    const entry = {
      id,
      active: true,
      default: Boolean(agentConfig.default || observed.isDefault),
      name: agentConfig.name || observed.name || id,
      identity: {
        name: observed.identityName || agentConfig.identity?.name || null,
        emoji: observed.identityEmoji || agentConfig.identity?.emoji || null,
        source: observed.identitySource || null,
      },
      workspace,
      agentDir: observed.agentDir || null,
      bindings: observed.bindings ?? null,
      routes: observed.routes || [],
      model: normalizeModel(agentConfig, observed, defaults),
      tools: normalizeTools(agentConfig),
      subagents: agentConfig.subagents || null,
      bootstrap: normalizeBootstrap(agentConfig),
      promptFiles,
      memory: normalizeMemory(id, memoryStatusById, promptFiles, { memoryStatusSource }),
    };
    appendAgentGaps(gaps, entry);
    agentEntries.push(entry);
  }

  const configuredById = toById(configuredAgents);
  for (const observed of observedAgents) {
    const id = normalizeAgentId(observed.id);
    if (!id || configuredById.has(id)) continue;
    const workspace = observed.workspace || observed.workspaceDir || null;
    const promptFiles = await getWorkspacePromptFiles(workspace);
    const entry = {
      id,
      active: true,
      default: Boolean(observed.isDefault),
      name: observed.name || id,
      identity: {
        name: observed.identityName || null,
        emoji: observed.identityEmoji || null,
        source: observed.identitySource || null,
      },
      workspace,
      agentDir: observed.agentDir || null,
      bindings: observed.bindings ?? null,
      routes: observed.routes || [],
      model: normalizeModel({}, observed, defaults),
      tools: normalizeTools({}),
      subagents: null,
      bootstrap: {},
      promptFiles,
      memory: normalizeMemory(id, memoryStatusById, promptFiles, { memoryStatusSource }),
      source: 'observed_only',
    };
    appendAgentGaps(gaps, entry);
    agentEntries.push(entry);
  }

  const inactiveWorkspaces = [];
  for (const workspace of workspaceDirs) {
    const workspaceId = workspaceIdFromPath(workspace);
    if (!workspaceId || activeIds.has(workspaceId)) continue;
    const promptFiles = await getWorkspacePromptFiles(workspace);
    inactiveWorkspaces.push({
      id: workspaceId,
      active: false,
      workspace,
      reason: 'Workspace exists but no active configured/observed OpenClaw agent matched it.',
      promptFiles,
    });
    addGap(
      gaps,
      `${workspaceId}-inactive-workspace`,
      'low',
      `Workspace ${workspaceId} exists but is not listed as an active OpenClaw agent.`,
      { workspace }
    );
  }

  const statusAll = state.statusAll || null;
  return {
    schema_version: 2,
    generated_at: stableNow(options),
    generated_by: 'agentx-core/openclawAgentInventoryService',
    content_mode: options.includeContent ? 'bounded_redacted' : 'metadata_only',
    source: {
      openclawHome,
      configPath,
      configLoaded: Boolean(state.configLoaded ?? Object.keys(config).length),
      configSource: state.configSource
        || (state.configLoaded ? 'filesystem' : (Object.keys(config).length ? 'provided' : 'unavailable')),
      agentListSource: state.agentListSource || (observedAgents.length ? 'provided' : 'config_fallback'),
      memoryStatusSource,
      statusSource: statusAll ? (state.statusSource || 'provided') : 'unavailable',
      promptFilesSource,
      degraded: Boolean(state.degraded),
      issues: safeArray(state.issues),
    },
    defaults: {
      model: defaults.model || null,
      workspace: defaults.workspace || null,
      timeoutSeconds: defaults.timeoutSeconds ?? null,
      maxConcurrent: defaults.maxConcurrent ?? null,
      subagents: defaults.subagents || null,
      compaction: defaults.compaction || null,
    },
    memory_strategy: normalizeMemoryStrategy(defaults),
    runtime: statusAll ? {
      version: statusAll.runtimeVersion || null,
      gateway: statusAll.gateway || null,
      gatewayService: statusAll.gatewayService || null,
    } : null,
    agents: agentEntries.sort((a, b) => a.id.localeCompare(b.id)),
    inactiveWorkspaces: inactiveWorkspaces.sort((a, b) => a.id.localeCompare(b.id)),
    known_gaps: gaps.sort((a, b) => `${a.severity}:${a.id}`.localeCompare(`${b.severity}:${b.id}`)),
  };
}

async function runOpenClawJson(args, options = {}) {
  const bin = options.openclawBin || process.env.OPENCLAW_BIN || 'openclaw';
  const timeout = options.commandTimeoutMs || DEFAULT_COMMAND_TIMEOUT_MS;
  const env = { ...process.env };
  if (options.openclawHome) env.OPENCLAW_HOME = options.openclawHome;
  if (options.configPath) env.OPENCLAW_CONFIG_PATH = options.configPath;

  const commandArgs = args.includes('--json') ? args : [...args, '--json'];
  try {
    const { stdout } = await execFileAsync(bin, commandArgs, {
      timeout,
      maxBuffer: DEFAULT_MAX_BUFFER,
      env,
      windowsHide: true,
    });
    return JSON.parse(stdout.trim());
  } catch (err) {
    if (process.platform === 'win32' && bin === 'openclaw') {
      const { stdout } = await execFileAsync('openclaw.cmd', commandArgs, {
        timeout,
        maxBuffer: DEFAULT_MAX_BUFFER,
        env,
        windowsHide: true,
      });
      return JSON.parse(stdout.trim());
    }
    throw err;
  }
}

async function collectLocalOpenClawState(options = {}) {
  const openclawHome = options.openclawHome || getDefaultOpenClawHome();
  const configPath = options.configPath || getDefaultConfigPath(openclawHome);
  const issues = [];
  let config = {};
  let configLoaded = false;

  try {
    config = await readJsonFile(configPath);
    configLoaded = true;
  } catch (err) {
    issues.push(`Could not read OpenClaw config at ${configPath}: ${err.message}`);
  }

  let agentList = null;
  let agentListSource = 'config_fallback';
  if (options.useCli !== false && options.includeAgentBindings !== false) {
    try {
      agentList = await runOpenClawJson(['agents', 'list', '--bindings'], options);
      agentListSource = 'openclaw agents list --json --bindings';
    } catch (err) {
      issues.push(`OpenClaw agents CLI unavailable: ${err.message}`);
    }
  }

  let memoryStatus = null;
  let memoryStatusSource = options.includeMemoryStatus === false ? 'skipped' : 'unavailable';
  if (options.useCli !== false && options.includeMemoryStatus !== false) {
    try {
      memoryStatus = await runOpenClawJson(['memory', 'status'], options);
      memoryStatusSource = 'openclaw memory status --json';
    } catch (err) {
      issues.push(`OpenClaw memory status CLI unavailable: ${err.message}`);
    }
  }

  let statusAll = null;
  let statusSource = 'unavailable';
  if (options.useCli !== false && options.includeRuntimeStatus) {
    try {
      statusAll = await runOpenClawJson(['status', '--all'], options);
      statusSource = 'openclaw status --json --all';
    } catch (err) {
      issues.push(`OpenClaw status CLI unavailable: ${err.message}`);
    }
  }

  if (!agentList) {
    const agentsSection = getAgentsSection(config);
    const defaults = agentsSection.defaults || {};
    agentList = safeArray(agentsSection.list).map(agent => ({
      id: agent.id,
      name: agent.name || agent.id,
      workspace: agent.workspace || defaults.workspace || null,
      model: agent.model?.primary || defaults.model?.primary || null,
      isDefault: Boolean(agent.default),
    }));
  }

  return {
    openclawHome,
    configPath,
    config,
    configLoaded,
    configSource: configLoaded ? 'filesystem' : 'unavailable',
    agentList,
    agentListSource,
    memoryStatus,
    memoryStatusSource,
    statusAll,
    statusSource,
    degraded: issues.length > 0,
    issues,
  };
}

async function collectRemoteOpenClawState(options = {}) {
  const target = options.sshTarget || process.env.OPENCLAW_INVENTORY_SSH_TARGET;
  const openclawHome = options.remoteOpenClawHome
    || process.env.OPENCLAW_INVENTORY_REMOTE_HOME
    || DEFAULT_REMOTE_OPENCLAW_HOME;
  const configPath = path.posix.join(openclawHome, 'openclaw.json');
  const issues = [];
  let config = {};
  let configLoaded = false;
  let agentList = null;
  let memoryStatus = null;
  let statusAll = null;
  let memoryStatusSource = options.includeMemoryStatus === false
    ? 'skipped'
    : 'unavailable';
  let promptFileRecords = null;
  let promptFilesSource = options.includePromptFiles === false ? 'skipped' : 'unavailable';
  let configSource = 'unavailable';
  let agentListSource = options.includeAgentBindings === false
    ? 'config_fallback'
    : 'ssh openclaw agents list --json --bindings';
  const cliPrefix = remoteCliEnvPrefix(options);

  const [configResult, agentListResult, memoryStatusResult] = await Promise.allSettled([
    loadRemoteAgentsConfig({
      target,
      openclawHome,
      cliPrefix,
      options,
      runJson: runSshJson,
    }),
    options.includeAgentBindings === false
      ? Promise.resolve(null)
      : runSshJson(target, `${cliPrefix}openclaw agents list --json --bindings`, options),
    options.includeMemoryStatus === false
      ? Promise.resolve(null)
      : runSshJson(target, `${cliPrefix}openclaw memory status --json`, options),
  ]);

  if (configResult.status === 'fulfilled') {
    config = configResult.value.config || {};
    configSource = configResult.value.source;
    configLoaded = Boolean(config);
    if (options.includeAgentBindings === false) agentListSource = configSource;
  } else {
    issues.push(`Remote OpenClaw config unavailable: ${configResult.reason.message}`);
  }

  if (agentListResult.status === 'fulfilled') {
    agentList = agentListResult.value;
  } else {
    issues.push(`Remote OpenClaw agents list unavailable: ${agentListResult.reason.message}`);
  }

  if (memoryStatusResult.status === 'fulfilled') {
    memoryStatus = memoryStatusResult.value;
    if (memoryStatus) memoryStatusSource = 'ssh openclaw memory status --json';
  } else {
    issues.push(`Remote OpenClaw memory status unavailable: ${memoryStatusResult.reason.message}`);
  }

  if (options.includeRuntimeStatus) {
    try {
      statusAll = await runSshJson(target, `${cliPrefix}openclaw status --json --all`, options);
    } catch (err) {
      issues.push(`Remote OpenClaw status unavailable: ${err.message}`);
    }
  }

  if (options.includePromptFiles !== false) {
    try {
      promptFileRecords = await runSshJson(
        target,
        remotePromptFilesCommand(openclawHome, options.includeContent),
        options
      );
      promptFilesSource = 'ssh prompt file metadata';
    } catch (err) {
      issues.push(`Remote OpenClaw prompt file metadata unavailable: ${err.message}`);
    }
  }

  if (!agentList) {
    const agentsSection = getAgentsSection(config);
    const defaults = agentsSection.defaults || {};
    agentList = safeArray(agentsSection.list).map(agent => ({
      id: agent.id,
      name: agent.name || agent.id,
      workspace: agent.workspace || defaults.workspace || null,
      model: agent.model?.primary || defaults.model?.primary || null,
      isDefault: Boolean(agent.default),
    }));
  }

  return {
    openclawHome,
    configPath,
    config,
    configLoaded,
    configSource,
    agentList,
    agentListSource,
    memoryStatus,
    memoryStatusSource,
    statusAll,
    statusSource: statusAll ? 'ssh openclaw status --json --all' : 'unavailable',
    promptFileRecords,
    promptFilesSource,
    degraded: issues.length > 0,
    issues,
  };
}

async function buildOpenClawAgentInventory(options = {}) {
  const sshTarget = options.sshTarget || process.env.OPENCLAW_INVENTORY_SSH_TARGET;
  const state = options.state || (sshTarget
    ? await collectRemoteOpenClawState({ ...options, sshTarget })
    : await collectLocalOpenClawState(options));
  return buildInventoryFromState(state, options);
}

module.exports = {
  PROMPT_FILE_NAMES,
  buildInventoryFromState,
  buildOpenClawAgentInventory,
  collectLocalOpenClawState,
  collectRemoteOpenClawState,
  getDefaultOpenClawHome,
  redactSensitiveText,
  remoteCliEnvPrefix,
  runOpenClawJson,
  runSshJson,
  sanitizeContent,
  isLocalModel,
};
