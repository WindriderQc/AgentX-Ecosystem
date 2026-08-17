const systemHealth = require('../systemHealth');
const fetch = require('node-fetch');
const { getRagServiceClient } = require('./ragServiceClient');
const { createTaskInMongo } = require('./pipelineTaskService');
const { saveMemory } = require('./nestorMemoryService');
const { lookupExact: lookupFrenchWord } = require('./kidxLexiconService');
const {
  addPersonalTask,
  listPersonalTasks,
  completePersonalTask,
} = require('./secretaryService');

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'agentx-core-skill-bus', title: 'AgentX Core Skill Bus', version: '0.1.0' };
const PERSONAL_TASK_NOTE_MAX_CHARS = 240;
const BUDGET_GATE_TIMEOUT_MS = 5000;

class McpToolError extends Error {
  constructor(message, { code = 'MCP_TOOL_ERROR', status = 400 } = {}) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
    this.status = status;
  }
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const TOOLS = [
  {
    name: 'rag_search',
    title: 'RAG Search',
    description: 'Search AgentX RAG explicitly for relevant chunks. This is separate from the automatic RAG reflex.',
    inputSchema: objectSchema({
      query: { type: 'string', minLength: 1, maxLength: 10000 },
      topK: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
      minScore: { type: 'number', minimum: 0, maximum: 1, default: 0 },
      filters: { type: 'object', additionalProperties: true },
      expand: { type: 'boolean', default: false },
      hybrid: { type: 'boolean', default: false },
      rerank: { type: 'boolean', default: false },
      compress: { type: 'boolean', default: false },
    }, ['query']),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'check_health',
    title: 'Check AgentX Health',
    description: 'Return a compact status summary for Core and key AgentX dependencies.',
    inputSchema: objectSchema({
      includeDetails: { type: 'boolean', default: false },
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_escalation_recommendation',
    title: 'Get Cloud Escalation Recommendation',
    description: 'Read the live AgentX billable-cloud budget gate immediately before any Answer-Heavy delegation. If this tool is unavailable or returns an error, fail closed and do not delegate to a cloud specialist.',
    inputSchema: objectSchema({
      hours: { type: 'integer', minimum: 1, maximum: 720, default: 24 },
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'lookup_french_word',
    title: 'Look Up French Word',
    description: 'Look up one exact French word in the compact, local, attributed KidX lexicon. Returns sourced glosses without model inference or Internet access.',
    inputSchema: objectSchema({
      word: { type: 'string', minLength: 1, maxLength: 80 },
    }, ['word']),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'create_todo',
    title: 'Create TODO',
    description: 'Create a deterministic task in the Mongo pipeline (the source of truth). Does not dispatch or execute the task.',
    inputSchema: objectSchema({
      title: { type: 'string', maxLength: 120 },
      objective: { type: 'string', minLength: 1, maxLength: 3000 },
      service: { type: 'string', minLength: 1, maxLength: 120 },
      short_name: { type: 'string', minLength: 1, maxLength: 80 },
      source_files: { type: 'array', items: { type: 'string' }, minItems: 1 },
      steps: { type: 'array', items: { type: 'string' }, minItems: 1 },
      constraints: { type: 'array', items: { type: 'string' }, minItems: 1 },
      acceptance_criteria: { type: 'array', items: { type: 'string' }, minItems: 1 },
      related_tasks: { type: 'array', items: { type: 'string' } },
      why_now: { type: 'string', maxLength: 1000 },
    }, ['objective', 'service', 'short_name', 'source_files', 'steps', 'constraints', 'acceptance_criteria']),
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'save_memory',
    title: 'Save Nestor Memory',
    description: 'Save an explicit durable fact or summary into RAG under source nestor-memory. Secret-like text is refused.',
    inputSchema: objectSchema({
      text: { type: 'string', minLength: 1, maxLength: 4000 },
      type: { type: 'string', enum: ['fact', 'summary'], default: 'fact' },
      agent: { type: 'string', default: 'nestor' },
      topic: { type: 'string', default: 'general' },
      tags: { type: 'array', items: { type: 'string' } },
      id: { type: 'string' },
    }, ['text']),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'add_personal_task',
    title: 'Add Personal Task',
    description: "Add an errand/reminder to Example User's personal lane (the secretary list). Use for real-life tasks, not code work — code work uses create_todo. Only a title is required. Resolve relative dates like \"Friday\" to an ISO date yourself before calling.",
    inputSchema: objectSchema({
      title: { type: 'string', minLength: 1, maxLength: 200 },
      note: { type: 'string', maxLength: 2000 },
      dueAt: { type: 'string', maxLength: 40 },
      priority: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
    }, ['title']),
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'list_personal_tasks',
    title: 'List Personal Tasks',
    description: "List Example User's open personal tasks, most urgent first, with overdue/dueToday counts. Use this before answering any question about what is on his list, what is due, or what he should do next. Notes are omitted by default; request includeNotes only when their text is needed, and expect long notes to be summarized.",
    inputSchema: objectSchema({
      includeDone: { type: 'boolean', default: false },
      includeNotes: { type: 'boolean', default: false },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'complete_personal_task',
    title: 'Complete Personal Task',
    description: "Mark a personal task done. `ref` accepts the 4-digit id or a distinctive phrase from the title (e.g. \"Spotify\"). If the phrase matches several tasks the call fails with the candidates listed — ask which one rather than guessing.",
    inputSchema: objectSchema({
      ref: { type: 'string', minLength: 1, maxLength: 200 },
      note: { type: 'string', maxLength: 2000 },
      by: { type: 'string', maxLength: 120 },
    }, ['ref']),
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  },
];

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function ensurePlainObject(value, field = 'arguments') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new McpToolError(`${field} must be an object`, { code: 'INVALID_ARGUMENTS' });
  }
  return value;
}

function clampInteger(value, { min, max, fallback }) {
  const n = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback;
  return Math.max(min, Math.min(max, n));
}

function clampNumber(value, { min, max, fallback }) {
  const n = Number.isFinite(Number(value)) ? Number(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

function textResult(structuredContent) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError: false,
  };
}

function toolErrorResult(err) {
  const structuredContent = {
    error: err.code || 'TOOL_ERROR',
    message: err.message,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError: true,
  };
}

async function ragSearch(args, deps) {
  const input = ensurePlainObject(args);
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query) throw new McpToolError('query is required', { code: 'INVALID_ARGUMENTS' });
  if (query.length > 10000) throw new McpToolError('query exceeds 10000 characters', { code: 'INVALID_ARGUMENTS' });
  const filters = input.filters === undefined ? undefined : ensurePlainObject(input.filters, 'filters');
  const ragClient = deps.ragClient || getRagServiceClient();
  const results = await ragClient.searchSimilarChunks(query, {
    topK: clampInteger(input.topK, { min: 1, max: 20, fallback: 5 }),
    minScore: clampNumber(input.minScore, { min: 0, max: 1, fallback: 0 }),
    filters,
    expand: input.expand === true,
    hybrid: input.hybrid === true,
    rerank: input.rerank === true,
    compress: input.compress === true,
  });
  return { query, count: results.length, results };
}

async function defaultHealth() {
  const ragClient = getRagServiceClient();
  let rag = { ok: false };
  try {
    const status = await ragClient.getStatus();
    rag = { ok: status?.healthy !== false, status };
  } catch (err) {
    rag = { ok: false, error: err.message };
  }
  return {
    ok: systemHealth.mongodb.status === 'connected' && rag.ok,
    core: {
      mongodb: systemHealth.mongodb.status,
      ollama: systemHealth.ollama.status,
    },
    rag,
  };
}

async function checkHealth(args, deps) {
  const input = args && typeof args === 'object' ? args : {};
  const provider = deps.healthProvider || defaultHealth;
  const result = await provider({ includeDetails: input.includeDetails === true });
  return result;
}

async function defaultEscalationRecommendation({ hours }) {
  const baseUrl = `http://127.0.0.1:${process.env.PORT || 3080}`;
  const url = new URL('/api/budget/escalation-recommendation', baseUrl);
  url.searchParams.set('hours', String(hours));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUDGET_GATE_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`AgentX budget gate returned HTTP ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getEscalationRecommendation(args, deps) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const hours = clampInteger(input.hours, { min: 1, max: 720, fallback: 24 });
  const provider = deps.escalationProvider || defaultEscalationRecommendation;
  let result;
  try {
    result = await provider({ hours });
  } catch (err) {
    throw new McpToolError(`cloud escalation gate unavailable: ${err.message}`, {
      code: 'BUDGET_GATE_UNAVAILABLE',
      status: 503,
    });
  }
  const recommendation = result?.escalation?.recommendation;
  const gateBasis = result?.escalation?.gate_basis;
  const cloudAllowed = result?.escalation?.cloud_allowed;
  const verdictIsConsistent = recommendation === 'deny'
    ? cloudAllowed === false
    : cloudAllowed === true;
  if (!['allow', 'limited', 'deny'].includes(recommendation)
      || gateBasis !== 'cloud_spend'
      || !verdictIsConsistent) {
    throw new McpToolError('cloud escalation gate returned no valid recommendation', {
      code: 'BUDGET_GATE_UNAVAILABLE',
      status: 503,
    });
  }
  return {
    period: result.period,
    cloud_health: result.cloud_health,
    cloud_requests: result.cloud_requests,
    cloud_tokens: result.cloud_tokens,
    cloud_daily_limit: result.cloud_daily_limit,
    cloud_usage_ratio: result.cloud_usage_ratio,
    cloud_spend_observability: result.cloud_spend_observability,
    escalation: result.escalation,
  };
}

async function lookupFrenchWordTool(args, deps) {
  const input = ensurePlainObject(args);
  const word = typeof input.word === 'string' ? input.word.trim() : '';
  if (!word || word.length > 80) {
    throw new McpToolError('word is required and must not exceed 80 characters', {
      code: 'INVALID_ARGUMENTS'
    });
  }
  const lookup = deps.lexiconLookup || lookupFrenchWord;
  return lookup(word);
}

async function createTodoTool(args, deps) {
  const writer = deps.todoWriter || createTaskInMongo;
  return writer(ensurePlainObject(args));
}

async function saveMemoryTool(args, deps) {
  const writer = deps.memoryWriter || saveMemory;
  return writer(ensurePlainObject(args));
}

async function addPersonalTaskTool(args, deps) {
  const writer = deps.secretaryAdd || addPersonalTask;
  return writer(ensurePlainObject(args));
}

async function listPersonalTasksTool(args, deps) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const reader = deps.secretaryList || listPersonalTasks;
  const result = await reader({
    includeDone: input.includeDone === true,
    limit: clampInteger(input.limit, { min: 1, max: 100, fallback: 25 }),
  });
  const includeNotes = input.includeNotes === true;
  const tasks = Array.isArray(result?.tasks) ? result.tasks.map((task) => {
    const { note, ...summary } = task;
    if (!includeNotes) return summary;
    const rawNote = typeof note === 'string' ? note : '';
    return {
      ...summary,
      note: rawNote.slice(0, PERSONAL_TASK_NOTE_MAX_CHARS),
      noteTruncated: rawNote.length > PERSONAL_TASK_NOTE_MAX_CHARS,
    };
  }) : [];
  return { ...result, tasks };
}

async function completePersonalTaskTool(args, deps) {
  const closer = deps.secretaryComplete || completePersonalTask;
  return closer(ensurePlainObject(args));
}

const TOOL_HANDLERS = {
  rag_search: ragSearch,
  check_health: checkHealth,
  get_escalation_recommendation: getEscalationRecommendation,
  lookup_french_word: lookupFrenchWordTool,
  create_todo: createTodoTool,
  save_memory: saveMemoryTool,
  add_personal_task: addPersonalTaskTool,
  list_personal_tasks: listPersonalTasksTool,
  complete_personal_task: completePersonalTaskTool,
};

async function callTool(params, deps = {}) {
  const name = params?.name;
  if (typeof name !== 'string' || !TOOL_HANDLERS[name]) {
    throw new McpToolError(`unknown tool: ${name || ''}`, { code: 'UNKNOWN_TOOL' });
  }
  try {
    const structured = await TOOL_HANDLERS[name](params.arguments || {}, deps);
    return textResult(structured);
  } catch (err) {
    return toolErrorResult(err);
  }
}

async function handleMcpMessage(message, deps = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
    return jsonRpcError(null, -32600, 'Invalid Request');
  }
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return isNotification ? null : jsonRpcResult(id, {});
  if (method === 'initialize') {
    if (isNotification) return null;
    return jsonRpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: 'AgentX exposes a narrow skill bus for product health, RAG, model-routing recommendations, vocabulary lookup, tasks, and memory.',
    });
  }
  if (method === 'tools/list') {
    if (isNotification) return null;
    return jsonRpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    if (isNotification) return null;
    return jsonRpcResult(id, await callTool(params || {}, deps));
  }

  return isNotification ? null : jsonRpcError(id, -32601, `Method not found: ${method || ''}`);
}

module.exports = {
  PROTOCOL_VERSION,
  SERVER_INFO,
  TOOLS,
  McpToolError,
  handleMcpMessage,
  callTool,
};
