'use strict';

const { validateHostUrl } = require('../helpers/ollamaHostConfig');
const lanePolicy = require('./inferenceLanePolicy');
const routerConfig = require('./modelRouterConfig');
const { internalNestorInferenceHeaders } = require('./nestorConsumerAttribution');
const {
  OPERATION_TASK_TYPES,
  LIMITS,
  NestorConsumerError,
} = require('./nestorConsumerContract');

const MESSAGE_ROLES = new Set(['system', 'user', 'assistant']);
const SURFACE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/:+-]{0,199}$/;

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new NestorConsumerError('messages must be a non-empty array', 400, 'MESSAGES_REQUIRED');
  }
  if (messages.length > LIMITS.messageCount) {
    throw new NestorConsumerError(
      `messages exceeds the ${LIMITS.messageCount} item limit`,
      413,
      'MESSAGES_TOO_LARGE'
    );
  }

  let totalCharacters = 0;
  const normalized = messages.map((message, index) => {
    if (!message || typeof message !== 'object' || !MESSAGE_ROLES.has(message.role)) {
      throw new NestorConsumerError(
        `messages[${index}].role must be system, user, or assistant`,
        400,
        'INVALID_MESSAGE_ROLE'
      );
    }
    if (typeof message.content !== 'string' || !message.content.trim()) {
      throw new NestorConsumerError(
        `messages[${index}].content must be a non-empty string`,
        400,
        'INVALID_MESSAGE_CONTENT'
      );
    }
    if (message.content.length > LIMITS.messageCharacters) {
      throw new NestorConsumerError(
        `messages[${index}].content exceeds ${LIMITS.messageCharacters} characters`,
        413,
        'MESSAGE_TOO_LARGE'
      );
    }
    totalCharacters += message.content.length;
    return { role: message.role, content: message.content };
  });

  if (totalCharacters > LIMITS.totalMessageCharacters) {
    throw new NestorConsumerError(
      `message content exceeds ${LIMITS.totalMessageCharacters} total characters`,
      413,
      'MESSAGES_TOO_LARGE'
    );
  }
  return normalized;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}

function normalizeOptions(options = {}) {
  return {
    num_predict: Math.round(boundedNumber(options.num_predict, 400, 1, 2048)),
    temperature: boundedNumber(options.temperature, 0.8, 0, 2),
    ...(options.top_p == null ? {} : { top_p: boundedNumber(options.top_p, 0.9, 0, 1) }),
  };
}

function normalizeRequest(input = {}) {
  const operation = String(input.operation || '').trim().toLowerCase();
  const taskType = OPERATION_TASK_TYPES[operation];
  if (!taskType) {
    throw new NestorConsumerError(
      `operation must be one of: ${Object.keys(OPERATION_TASK_TYPES).join(', ')}`,
      400,
      'UNKNOWN_INFERENCE_OPERATION'
    );
  }

  const surface = String(input.context?.surface || 'desktop').trim().toLowerCase();
  if (!SURFACE_PATTERN.test(surface)) {
    throw new NestorConsumerError('context.surface must be a short lowercase identifier', 400, 'INVALID_SURFACE');
  }

  const requestedModel = String(input.requested?.model || '').trim();
  if (requestedModel && !MODEL_PATTERN.test(requestedModel)) {
    throw new NestorConsumerError('requested.model contains unsupported characters', 400, 'INVALID_MODEL');
  }

  const requestedHost = String(input.requested?.host || '').trim();
  let allowlistedHost = '';
  if (requestedHost) {
    const hostCheck = validateHostUrl(requestedHost);
    if (!hostCheck.valid) {
      throw new NestorConsumerError(hostCheck.message, 400, 'INVALID_HOST');
    }
    allowlistedHost = hostCheck.host;
  }

  return {
    operation,
    taskType,
    messages: normalizeMessages(input.messages),
    requested: { host: allowlistedHost, model: requestedModel },
    options: normalizeOptions(input.options),
    context: {
      surface,
      sessionId: String(input.context?.sessionId || '').trim().slice(0, 200) || null,
    },
    callerDetail: `nestor/${surface}/${operation}`,
  };
}

function responseHeader(response, name) {
  return response?.headers?.get?.(name) || response?.headers?.get?.(name.toLowerCase()) || '';
}

async function parseResponse(response) {
  const raw = await response.text();
  try { return raw ? JSON.parse(raw) : {}; } catch (_) { return { response: raw }; }
}

async function executeInference(input, { fetchImpl = global.fetch, port = process.env.PORT || 3080 } = {}) {
  const request = normalizeRequest(input);
  if (typeof fetchImpl !== 'function') {
    throw new NestorConsumerError('AgentX inference transport is unavailable', 503, 'INFERENCE_UNAVAILABLE');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 125000);
  let response;
  let data;
  try {
    response = await fetchImpl(`http://127.0.0.1:${port}/api/inference/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...internalNestorInferenceHeaders(),
      },
      body: JSON.stringify({
        taskType: request.taskType,
        ...(request.requested.host ? { host: request.requested.host } : {}),
        ...(request.requested.model ? { model: request.requested.model } : {}),
        messages: request.messages,
        options: request.options,
        stream: false,
        responseMode: 'normalized',
        suppressThinking: true,
        callerDetail: request.callerDetail,
      }),
      signal: controller.signal,
    });
    data = await parseResponse(response);
  } catch (error) {
    const timedOut = error.name === 'AbortError';
    throw new NestorConsumerError(
      timedOut ? 'AgentX inference timed out' : error.message,
      timedOut ? 504 : 502,
      timedOut ? 'INFERENCE_TIMEOUT' : 'INFERENCE_UPSTREAM_ERROR'
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok || data.status === 'error') {
    throw new NestorConsumerError(
      data.message || data.error || `AgentX inference failed with HTTP ${response.status}`,
      response.status || 502,
      data.code || 'INFERENCE_FAILED',
      data.data || null
    );
  }

  const reply = String(data.message?.content || data.response || '').trim();
  return {
    operation: request.operation,
    taskType: request.taskType,
    callerDetail: request.callerDetail,
    sessionId: request.context.sessionId,
    reply,
    message: { role: 'assistant', content: reply },
    usage: {
      promptTokens: Number(data.prompt_eval_count) || 0,
      completionTokens: Number(data.eval_count) || 0,
    },
    provenance: {
      requested: request.requested,
      resolved: {
        model: responseHeader(response, 'x-resolved-model') || data.model || '',
        host: responseHeader(response, 'x-routed-host'),
        hostKey: responseHeader(response, 'x-routed-host-key'),
      },
      lane: responseHeader(response, 'x-inference-lane'),
      routingSource: responseHeader(response, 'x-routing-source'),
      taskType: responseHeader(response, 'x-routing-task-type') || request.taskType,
      responseMode: responseHeader(response, 'x-agentx-response-mode') || 'normalized',
    },
    warning: data.warning || null,
  };
}

async function getRouterSnapshot() {
  await routerConfig.ensureTaskModelOverridesLoaded();
  const state = routerConfig.getTaskModelConfigState();
  const routes = {};

  for (const [operation, taskType] of Object.entries(OPERATION_TASK_TYPES)) {
    const configured = state[taskType] || {};
    try {
      const recommendation = await routerConfig.getAdvisoryModelForTask(taskType, {
        caller: `nestor/router/${operation}`,
        durationMs: 30000,
        createSoftClaim: false,
      });
      routes[operation] = {
        taskType,
        default: configured.default || null,
        override: configured.override || null,
        effective: configured.effective || null,
        provenance: configured.isOverride ? 'operator-override' : 'router-default',
        model: recommendation.model || configured.effective?.model || null,
        hostKey: recommendation.host || configured.effective?.host || null,
        hostUrl: recommendation.url || routerConfig.HOSTS[configured.effective?.host] || null,
        readiness: recommendation.readiness || null,
        lane: lanePolicy.resolveLane(`nestor/desktop/${operation}`).name,
        routingSource: recommendation.source || null,
        reason: recommendation.reason || null,
        available: Boolean(recommendation.model && recommendation.url),
      };
    } catch (error) {
      routes[operation] = {
        taskType,
        default: configured.default || null,
        override: configured.override || null,
        effective: configured.effective || null,
        provenance: configured.isOverride ? 'operator-override' : 'router-default',
        model: configured.effective?.model || null,
        hostKey: configured.effective?.host || null,
        hostUrl: routerConfig.HOSTS[configured.effective?.host] || null,
        readiness: null,
        lane: lanePolicy.resolveLane(`nestor/desktop/${operation}`).name,
        routingSource: null,
        reason: error.message,
        available: false,
      };
    }
  }

  return {
    available: Object.values(routes).some((route) => route.available),
    readOnly: true,
    modelCatalog: '/api/models/all',
    modelCatalogMode: 'embedded-in-routes',
    effectiveRoute: '/api/consumers/nestor/v1/router',
    routes,
  };
}

module.exports = {
  normalizeMessages,
  normalizeRequest,
  executeInference,
  getRouterSnapshot,
};
