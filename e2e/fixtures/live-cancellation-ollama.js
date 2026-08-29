'use strict';

const http = require('http');

const DATA_HOST = '0.0.0.0';
const DATA_PORT = 11434;
const CONTROL_HOST = '127.0.0.1';
const CONTROL_PORT = 11435;
const FIXTURE = 'agentx-live-cancellation-ollama';
const EXECUTION_MODEL = 'agentx-cancel-fixture:1';
const JUDGE_MODEL = 'agentx-cancel-judge:1';
const EXECUTION_DIGEST = 'a'.repeat(64);
const JUDGE_DIGEST = 'b'.repeat(64);
const PROMPT_1_SENTINEL = 'AGENTX_LIVE_CANCEL_PROMPT_1';
const PROMPT_2_SENTINEL = 'AGENTX_LIVE_CANCEL_PROMPT_2';
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_EVENTS = 100;

let nextRequestId = 1;
let nextSocketId = 1;
let nextEventOrdinal = 1;
const socketIds = new WeakMap();
const dataSockets = new Set();
const pendingBySocket = new Map();
const active = new Map();
const events = [];
const counters = {
  prompt1Starts: 0,
  prompt2Starts: 0,
  otherGenerationStarts: 0,
};

function nowIso() {
  return new Date().toISOString();
}

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function eventFor(state, type) {
  events.push({
    ordinal: nextEventOrdinal++,
    type,
    requestId: state.requestId,
    socketId: state.socketId,
    sentinel: state.sentinel,
    at: nowIso(),
  });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

function requestText(body) {
  const messages = Array.isArray(body?.messages)
    ? body.messages.map((message) => String(message?.content || ''))
    : [];
  return [String(body?.prompt || ''), ...messages].join('\n');
}

function classifySentinel(body) {
  const lines = requestText(body).split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(PROMPT_1_SENTINEL)) return 'prompt-1';
  if (lines.includes(PROMPT_2_SENTINEL)) return 'prompt-2';
  return 'other';
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        const error = new Error('request body too large');
        error.statusCode = 413;
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        const error = new Error('request body must be JSON');
        error.statusCode = 400;
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function modelRecord(name, digest) {
  return {
    name,
    model: name,
    modified_at: '2026-01-01T00:00:00.000Z',
    size: 1,
    digest,
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'fixture',
      families: ['fixture'],
      parameter_size: '1B',
      quantization_level: 'Q4_0',
    },
  };
}

function normalGenerationPayload(endpoint, body) {
  const model = String(body?.model || EXECUTION_MODEL);
  const base = {
    model,
    created_at: '2026-01-01T00:00:00.000Z',
    done: true,
    done_reason: 'stop',
    total_duration: 1_000_000,
    load_duration: 1_000,
    prompt_eval_count: 1,
    prompt_eval_duration: 100_000,
    eval_count: 1,
    eval_duration: 100_000,
  };
  if (endpoint === '/api/chat') {
    const isJudgeSmokeTest = requestText(body).includes('Respond ONLY with JSON');
    return {
      ...base,
      message: {
        role: 'assistant',
        content: isJudgeSmokeTest ? '{"score":5,"reason":"fixture"}' : 'ok',
      },
    };
  }
  return { ...base, response: 'ok' };
}

function registerGeneration(request, response, endpoint, body) {
  const socketId = socketIds.get(request.socket);
  const state = {
    requestId: nextRequestId++,
    socketId,
    sentinel: classifySentinel(body),
    endpoint,
    headersSent: false,
    socketOpen: !request.socket.destroyed,
    finishedNormally: false,
  };

  if (state.sentinel === 'prompt-1') counters.prompt1Starts += 1;
  else if (state.sentinel === 'prompt-2') counters.prompt2Starts += 1;
  else counters.otherGenerationStarts += 1;

  active.set(state.requestId, state);
  let pending = pendingBySocket.get(socketId);
  if (!pending) {
    pending = new Map();
    pendingBySocket.set(socketId, pending);
  }
  pending.set(state.requestId, state);
  eventFor(state, 'request-start');

  response.once('finish', () => {
    state.finishedNormally = true;
    active.delete(state.requestId);
    pending.delete(state.requestId);
    if (pending.size === 0) pendingBySocket.delete(socketId);
  });
  response.once('close', () => {
    eventFor(state, 'response-close');
    active.delete(state.requestId);
  });
  return state;
}

function flushGenerationHeaders(response, state) {
  response.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'transfer-encoding': 'chunked',
  });
  response.flushHeaders();
  state.headersSent = true;
  eventFor(state, 'response-headers');
}

async function handleDataRequest(request, response) {
  const url = new URL(request.url, 'http://fixture.invalid');
  if (request.method === 'GET' && url.pathname === '/api/tags') {
    return writeJson(response, 200, {
      models: [
        modelRecord(EXECUTION_MODEL, EXECUTION_DIGEST),
        modelRecord(JUDGE_MODEL, JUDGE_DIGEST),
      ],
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/ps') {
    return writeJson(response, 200, { models: [] });
  }
  if (request.method === 'GET' && url.pathname === '/api/version') {
    return writeJson(response, 200, { version: '0.0.0-live-cancellation-fixture' });
  }
  if (request.method === 'POST' && url.pathname === '/api/show') {
    await readJson(request);
    return writeJson(response, 200, {
      license: 'fixture',
      modelfile: '',
      parameters: 'num_ctx 4096',
      template: '',
      details: { family: 'fixture', parameter_size: '1B', quantization_level: 'Q4_0' },
      model_info: { 'fixture.context_length': 4096 },
    });
  }
  if (request.method === 'POST' && (url.pathname === '/api/chat' || url.pathname === '/api/generate')) {
    const body = await readJson(request);
    const state = registerGeneration(request, response, url.pathname, body);
    if (state.sentinel === 'prompt-1') {
      flushGenerationHeaders(response, state);
      response.write('{"model":"agentx-cancel-fixture:1","message":');
      return;
    }
    flushGenerationHeaders(response, state);
    response.end(JSON.stringify(normalGenerationPayload(url.pathname, body)));
    return;
  }
  return writeJson(response, 404, { error: 'fixture endpoint not found' });
}

function controlState() {
  return {
    schemaVersion: 1,
    fixture: FIXTURE,
    counters: { ...counters },
    active: [...active.values()]
      .sort((left, right) => left.requestId - right.requestId)
      .map((state) => ({
        requestId: state.requestId,
        socketId: state.socketId,
        sentinel: state.sentinel,
        endpoint: state.endpoint,
        headersSent: state.headersSent,
        socketOpen: state.socketOpen,
      })),
    events: events.map((event) => ({ ...event })),
  };
}

function handleControlRequest(request, response) {
  const url = new URL(request.url, 'http://fixture-control.invalid');
  if (request.method === 'GET' && url.pathname === '/health') {
    return writeJson(response, 200, { schemaVersion: 1, ok: true, fixture: FIXTURE });
  }
  if (request.method === 'GET' && url.pathname === '/state') {
    return writeJson(response, 200, controlState());
  }
  return writeJson(response, 404, { error: 'fixture control endpoint not found' });
}

const dataServer = http.createServer((request, response) => {
  handleDataRequest(request, response).catch((error) => {
    if (!response.headersSent && !response.destroyed) {
      writeJson(response, error.statusCode || 500, { error: error.message || 'fixture request failed' });
    } else if (!response.destroyed) {
      response.destroy();
    }
  });
});

dataServer.on('connection', (socket) => {
  const socketId = nextSocketId++;
  socketIds.set(socket, socketId);
  dataSockets.add(socket);
  socket.once('close', () => {
    dataSockets.delete(socket);
    const pending = pendingBySocket.get(socketId);
    if (!pending) return;
    for (const state of pending.values()) {
      if (state.finishedNormally) continue;
      state.socketOpen = false;
      active.delete(state.requestId);
      eventFor(state, 'socket-close');
    }
    pendingBySocket.delete(socketId);
  });
});

dataServer.requestTimeout = 0;
dataServer.timeout = 0;

const controlServer = http.createServer(handleControlRequest);

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function shutdown() {
  for (const socket of dataSockets) socket.destroy();
  await Promise.allSettled([close(controlServer), close(dataServer)]);
  process.exit(0);
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

Promise.all([
  listen(dataServer, DATA_PORT, DATA_HOST),
  listen(controlServer, CONTROL_PORT, CONTROL_HOST),
]).then(() => {
  process.stdout.write('Live cancellation Ollama fixture ready\n');
}).catch((error) => {
  process.stderr.write(`Fixture startup failed: ${error.message}\n`);
  process.exit(1);
});
