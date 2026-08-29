'use strict';

const { validateHostUrl } = require('../helpers/ollamaHostConfig');
const lanePolicy = require('./inferenceLanePolicy');
const routerConfig = require('./modelRouterConfig');
const { CONSUMER_CONTRACT } = require('./nestorConsumerAttribution');
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
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new NestorConsumerError('request body must be an object', 400, 'INVALID_INFERENCE_REQUEST');
  }
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

  if (input.stream !== undefined && typeof input.stream !== 'boolean') {
    throw new NestorConsumerError('stream must be boolean when supplied', 400, 'INFERENCE_STREAM_INVALID');
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
    stream: input.stream === true,
    callerDetail: `nestor/${surface}/${operation}`,
  };
}

function provenanceFromResult(request, result) {
  const metadata = result?.metadata || {};
  return {
    requested: request.requested,
    resolved: {
      model: metadata.model || '',
      host: metadata.hostUrl || '',
      hostKey: metadata.hostKey || '',
    },
    lane: lanePolicy.resolveLane(request.callerDetail).name,
    routingSource: metadata.routingSource || '',
    taskType: metadata.taskType || request.taskType,
    responseMode: request.stream ? 'raw-stream' : 'normalized',
  };
}

function inferenceIdentity(request, result) {
  return {
    operation: request.operation,
    taskType: request.taskType,
    callerDetail: request.callerDetail,
    sessionId: request.context.sessionId,
    provenance: provenanceFromResult(request, result),
  };
}

function toNestorRuntimeError(error) {
  if (error instanceof NestorConsumerError) return error;
  return new NestorConsumerError(
    error?.message || 'AgentX inference failed',
    Number(error?.statusCode) || 502,
    error?.code || 'INFERENCE_UPSTREAM_ERROR',
    error?.details || null
  );
}

async function executeInference(input, { runtimeServices, signal } = {}) {
  const request = normalizeRequest(input);
  if (!runtimeServices?.inference?.execute) {
    throw new NestorConsumerError('AgentX inference runtime is unavailable', 503, 'INFERENCE_UNAVAILABLE');
  }

  let result;
  try {
    result = await runtimeServices.inference.execute({
      mode: 'chat',
      taskType: request.taskType,
      ...(request.requested.model ? { model: request.requested.model } : {}),
      messages: request.messages,
      options: request.options,
      stream: request.stream,
      think: false,
      timeoutMs: LIMITS.inferenceTimeoutMs,
      callerDetail: request.callerDetail,
    }, {
      signal,
      consumerContract: CONSUMER_CONTRACT,
      ...(request.requested.host ? { hostUrl: request.requested.host } : {}),
    });
  } catch (error) {
    throw toNestorRuntimeError(error);
  }

  if (!result?.ok) {
    const data = result?.body || {};
    throw new NestorConsumerError(
      data.message || data.error || `AgentX inference failed with HTTP ${result?.status || 502}`,
      Number(result?.status) || 502,
      data.code || 'INFERENCE_FAILED',
      data.data || null
    );
  }

  const identity = inferenceIdentity(request, result);
  if (request.stream) {
    if (!result.stream) {
      throw new NestorConsumerError(
        'AgentX inference did not return a stream',
        502,
        'INFERENCE_STREAM_UNAVAILABLE'
      );
    }
    return {
      ...identity,
      stream: result.stream,
    };
  }

  const data = result.body || {};
  const reply = String(data.message?.content || data.response || '').trim();
  return {
    ...identity,
    reply,
    message: { role: 'assistant', content: reply },
    usage: {
      promptTokens: Number(data.prompt_eval_count ?? data.usage?.prompt_tokens) || 0,
      completionTokens: Number(data.eval_count ?? data.usage?.completion_tokens) || 0,
    },
    warning: data.warning || null,
  };
}

const ABSOLUTE_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

function publicMessage(value) {
  if (value == null) return null;
  return String(value).replace(ABSOLUTE_URL_PATTERN, '[redacted-endpoint]').slice(0, 500);
}

function publicConfiguredRoute(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    model: value.model || null,
    host: value.host || null,
  };
}

function publicReadiness(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    stage: value.stage || null,
    profiledAt: value.profiledAt || null,
    profileDepth: value.profileDepth || null,
    benchmarkQualified: value.benchmarkQualified === true,
    benchmarkedAt: value.benchmarkedAt || null,
    stale: value.stale === true,
    hostId: value.hostId || null,
    scope: value.scope || null,
    isReady: value.isReady === true,
  };
}

async function getRouterSnapshot(options = {}) {
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
      const resolvedHostUrl = recommendation.url || routerConfig.HOSTS[configured.effective?.host] || null;
      const available = Boolean(recommendation.model && resolvedHostUrl);
      routes[operation] = {
        taskType,
        default: publicConfiguredRoute(configured.default),
        override: publicConfiguredRoute(configured.override),
        effective: publicConfiguredRoute(configured.effective),
        provenance: configured.isOverride ? 'operator-override' : 'router-default',
        model: recommendation.model || configured.effective?.model || null,
        hostKey: recommendation.host || configured.effective?.host || null,
        readiness: publicReadiness(recommendation.readiness),
        lane: lanePolicy.resolveLane(`nestor/desktop/${operation}`).name,
        routingSource: recommendation.source || null,
        reason: publicMessage(recommendation.reason)
          || (available ? null : 'Routing target is unavailable.'),
        available,
      };
    } catch (error) {
      routes[operation] = {
        taskType,
        default: publicConfiguredRoute(configured.default),
        override: publicConfiguredRoute(configured.override),
        effective: publicConfiguredRoute(configured.effective),
        provenance: configured.isOverride ? 'operator-override' : 'router-default',
        model: configured.effective?.model || null,
        hostKey: configured.effective?.host || null,
        readiness: null,
        lane: lanePolicy.resolveLane(`nestor/desktop/${operation}`).name,
        routingSource: null,
        reason: publicMessage(error.message),
        available: false,
      };
    }
  }

  const observedAt = typeof options.now === 'function' ? options.now() : new Date();
  const generatedAt = observedAt instanceof Date
    ? observedAt.toISOString()
    : new Date(observedAt).toISOString();

  return {
    generatedAt,
    available: Object.values(routes).some((route) => route.available),
    readOnly: true,
    topology: 'opaque',
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
  publicConfiguredRoute,
  publicMessage,
  publicReadiness,
};
