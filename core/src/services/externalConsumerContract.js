'use strict';

const CONTRACT_NAME = 'agentx.external-consumer';
const CONTRACT_VERSION = '1.0.0';
const CONTRACT_BASE_PATH = '/api/consumers/v1';
const CONSUMER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const TASK_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/:+-]{0,199}$/;
const MODES = new Set(['chat', 'generate']);
const MESSAGE_ROLES = new Set(['system', 'user', 'assistant']);
const GENERATION_OPTION_RULES = Object.freeze({
  num_predict: { minimum: 1, maximum: 8192, integer: true },
  temperature: { minimum: 0, maximum: 2 },
  top_p: { minimum: 0, maximum: 1 },
  top_k: { minimum: 0, maximum: 1000, integer: true },
  min_p: { minimum: 0, maximum: 1 },
  seed: { minimum: -2147483648, maximum: 2147483647, integer: true },
  repeat_penalty: { minimum: 0, maximum: 4 },
  presence_penalty: { minimum: -2, maximum: 2 },
  frequency_penalty: { minimum: -2, maximum: 2 },
});

const LIMITS = Object.freeze({
  messageCount: 100,
  messageCharacters: 16_000,
  totalMessageCharacters: 64_000,
  promptCharacters: 64_000,
});

class ExternalConsumerError extends Error {
  constructor(message, statusCode = 400, code = 'EXTERNAL_CONSUMER_INVALID_REQUEST', details = null) {
    super(message);
    this.name = 'ExternalConsumerError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function boundedText(value, name, maximum, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (!required) return undefined;
    throw new ExternalConsumerError(`${name} is required`, 400, 'INFERENCE_INPUT_REQUIRED');
  }
  if (typeof value !== 'string' || (required && !value.trim())) {
    throw new ExternalConsumerError(`${name} must be a${required ? ' non-empty' : ''} string`, 400, 'INVALID_INFERENCE_INPUT');
  }
  if (value.length > maximum) {
    throw new ExternalConsumerError(`${name} exceeds ${maximum} characters`, 413, 'INFERENCE_INPUT_TOO_LARGE');
  }
  return value;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ExternalConsumerError('messages must be a non-empty array', 400, 'MESSAGES_REQUIRED');
  }
  if (messages.length > LIMITS.messageCount) {
    throw new ExternalConsumerError(
      `messages exceeds the ${LIMITS.messageCount} item limit`,
      413,
      'MESSAGES_TOO_LARGE'
    );
  }

  let totalCharacters = 0;
  const normalized = messages.map((message, index) => {
    if (!message || typeof message !== 'object' || !MESSAGE_ROLES.has(message.role)) {
      throw new ExternalConsumerError(
        `messages[${index}].role must be system, user, or assistant`,
        400,
        'INVALID_MESSAGE_ROLE'
      );
    }
    const content = boundedText(
      message.content,
      `messages[${index}].content`,
      LIMITS.messageCharacters,
      { required: true }
    );
    totalCharacters += content.length;
    return { role: message.role, content };
  });

  if (totalCharacters > LIMITS.totalMessageCharacters) {
    throw new ExternalConsumerError(
      `message content exceeds ${LIMITS.totalMessageCharacters} total characters`,
      413,
      'MESSAGES_TOO_LARGE'
    );
  }
  return normalized;
}

function normalizeStop(value) {
  const values = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(values)
    || values.length === 0
    || values.length > 16
    || values.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 256)) {
    throw new ExternalConsumerError(
      'options.stop must be a non-empty string or at most 16 bounded strings',
      400,
      'INFERENCE_OPTION_INVALID'
    );
  }
  return typeof value === 'string' ? value : [...values];
}

function normalizeGenerationOptions(options) {
  if (options === undefined) return {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new ExternalConsumerError('options must be an object when supplied', 400, 'INFERENCE_OPTIONS_INVALID');
  }

  const normalized = {};
  for (const [key, value] of Object.entries(options)) {
    if (key === 'stop') {
      normalized.stop = normalizeStop(value);
      continue;
    }
    const rule = GENERATION_OPTION_RULES[key];
    if (!rule) {
      throw new ExternalConsumerError(
        `Unsupported external inference option: ${key}`,
        400,
        'INFERENCE_OPTION_UNSUPPORTED'
      );
    }
    const number = Number(value);
    if (!Number.isFinite(number)
      || number < rule.minimum
      || number > rule.maximum
      || (rule.integer && !Number.isInteger(number))) {
      throw new ExternalConsumerError(
        `options.${key} is outside the supported range`,
        400,
        'INFERENCE_OPTION_INVALID'
      );
    }
    normalized[key] = number;
  }
  return normalized;
}

function normalizeInferenceRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ExternalConsumerError('request body must be an object');
  }

  const consumer = typeof input.consumer === 'string' ? input.consumer.trim().toLowerCase() : '';
  if (!CONSUMER_PATTERN.test(consumer)) {
    throw new ExternalConsumerError(
      'consumer must be a lowercase application identifier',
      400,
      'INVALID_CONSUMER_ID'
    );
  }

  const mode = typeof input.mode === 'string' ? input.mode.trim().toLowerCase() : '';
  if (!MODES.has(mode)) {
    throw new ExternalConsumerError('mode must be chat or generate', 400, 'INVALID_INFERENCE_MODE');
  }
  if (input.persist !== undefined && input.persist !== false) {
    throw new ExternalConsumerError(
      'The external consumer contract is stateless; persist must be false when supplied.',
      400,
      'PERSISTENCE_NOT_SUPPORTED'
    );
  }

  const taskType = typeof input.taskType === 'string' ? input.taskType.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!taskType && !model) {
    throw new ExternalConsumerError('taskType or model is required', 400, 'INFERENCE_ROUTE_REQUIRED');
  }
  if (taskType && !TASK_TYPE_PATTERN.test(taskType)) {
    throw new ExternalConsumerError('taskType must be a bounded lowercase identifier', 400, 'INVALID_TASK_TYPE');
  }
  if (model && !MODEL_PATTERN.test(model)) {
    throw new ExternalConsumerError('model contains unsupported characters', 400, 'INVALID_MODEL');
  }

  if (input.stream !== undefined && typeof input.stream !== 'boolean') {
    throw new ExternalConsumerError('stream must be boolean when supplied', 400, 'INFERENCE_STREAM_INVALID');
  }

  if (input.think !== undefined && typeof input.think !== 'boolean') {
    throw new ExternalConsumerError('think must be boolean when supplied', 400, 'INFERENCE_THINK_INVALID');
  }
  const options = normalizeGenerationOptions(input.options);

  const normalized = {
    consumer,
    runtimeRequest: {
      mode,
      ...(taskType && { taskType }),
      ...(model && { model }),
      options: { ...options },
      stream: input.stream === true,
      callerDetail: `external/${consumer}`,
      ...(input.think !== undefined && { think: input.think }),
    },
  };

  if (mode === 'chat') normalized.runtimeRequest.messages = normalizeMessages(input.messages);
  if (mode === 'generate') {
    normalized.runtimeRequest.prompt = boundedText(
      input.prompt,
      'prompt',
      LIMITS.promptCharacters,
      { required: true }
    );
    const system = boundedText(input.system, 'system', LIMITS.messageCharacters);
    if (system !== undefined) normalized.runtimeRequest.system = system;
  }

  return normalized;
}

function inferenceContractSummary(contract) {
  if (!contract || typeof contract !== 'object') return null;
  return {
    version: contract.version ?? null,
    contextWindowTokens: Number(contract.contextBudget?.windowTokens) || null,
    contextSource: contract.contextBudget?.source || null,
    qualification: {
      state: contract.qualification?.state || null,
      qualified: contract.qualification?.qualified === true,
    },
  };
}

function publicRouteMetadata(metadata = {}) {
  return {
    requestedModel: metadata.requestedModel || null,
    taskType: metadata.taskType || null,
    model: metadata.model || null,
    hostKey: metadata.hostKey || null,
    routingSource: metadata.routingSource || null,
    inferenceContract: inferenceContractSummary(metadata.inferenceContract),
  };
}

function normalizeNonStreamingResult(result) {
  const body = result?.body || {};
  const content = typeof body.message?.content === 'string'
    ? body.message.content
    : (typeof body.response === 'string' ? body.response : '');
  return {
    message: { role: 'assistant', content },
    text: content,
    usage: {
      promptTokens: Number(body.prompt_eval_count || body.usage?.prompt_tokens) || 0,
      completionTokens: Number(body.eval_count || body.usage?.completion_tokens) || 0,
    },
    done: body.done !== false,
    route: publicRouteMetadata(result?.metadata),
    persistence: { persisted: false },
  };
}

function sanitizeRoutingSnapshot(snapshot = {}) {
  const tasks = Object.fromEntries(Object.entries(snapshot.tasks || {}).map(([taskType, route]) => {
    const contextWindowTokens = Number(
      route?.inferenceContract?.contextBudget?.windowTokens || route?.contextSize
    ) || null;
    return [taskType, {
      taskType,
      model: route?.model || null,
      hostKey: route?.hostKey || null,
      available: Boolean(route?.model && route?.hostKey && route?.hostUrl && !route?.resolutionError),
      host: {
        key: route?.hostKey || null,
        status: route?.hostPreference?.status || null,
        benchmarkClaimed: route?.hostPreference?.benchmarkClaimed === true,
      },
      context: {
        windowTokens: contextWindowTokens,
        source: route?.inferenceContract?.contextBudget?.source || route?.contextSource || null,
      },
      qualification: {
        state: route?.inferenceContract?.qualification?.state || null,
        qualified: route?.inferenceContract?.qualification?.qualified === true,
      },
    }];
  }));

  return {
    schemaVersion: 1,
    generatedAt: snapshot.generatedAt || new Date().toISOString(),
    readOnly: true,
    topology: 'opaque',
    tasks,
    warnings: Array.isArray(snapshot.warnings) ? snapshot.warnings.map(() => 'Some routing evidence is unavailable.') : [],
  };
}

module.exports = {
  CONTRACT_NAME,
  CONTRACT_VERSION,
  CONTRACT_BASE_PATH,
  LIMITS,
  GENERATION_OPTION_RULES,
  ExternalConsumerError,
  normalizeInferenceRequest,
  normalizeGenerationOptions,
  normalizeMessages,
  normalizeNonStreamingResult,
  publicRouteMetadata,
  sanitizeRoutingSnapshot,
};
