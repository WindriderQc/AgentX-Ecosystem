/**
 * Ollama Response Handler
 * Utilities for extracting and processing Ollama API responses
 */

const logger = require('../../config/logger');

// Regex patterns for cleaning leaked Llama 3 template tags
// These patterns are defined as constants to avoid repeated regex compilation
// Regex for Llama 3 style tags: <|start_header_id|>role<|end_header_id|>
// Strictly requires <| and |> to avoid false positives with pipes in content
const LLAMA3_HEADER_REGEX = /<\|start_header_id\|>.*?<\|end_header_id\|>/g;

// Other special tokens: <|eot_id|>, <|begin_of_text|>, etc.
const LLAMA3_SPECIAL_TOKENS_REGEX = /<\|(eot_id|begin_of_text|end_of_text|fin)\|>/g;

// Regex for extracting <think> blocks from reasoning models (e.g., DeepSeek-R1)
// Handles both properly closed tags and unclosed tags (captures until end of string)
const THINKING_TAG_REGEX = /<think>([\s\S]*?)(?:<\/think>|$)/gi;

const REASONING_FIELD_NAMES = [
  'thinking',
  'reasoning',
  'reasoning_content',
  'reasoningContent'
];


/**
 * Clean up content by removing known leaked template tags (e.g. Llama 3 headers)
 * @param {string} content
 * @returns {string}
 */
function cleanContent(content) {
  if (!content) return content;

  return content
    .replace(LLAMA3_HEADER_REGEX, '')
    .replace(LLAMA3_SPECIAL_TOKENS_REGEX, '')
    .trim();
}

/**
 * Extract and strip <think> blocks from model responses
 * Used for reasoning models like DeepSeek-R1 that emit internal reasoning in <think> tags
 *
 * @param {string} content - The raw response content
 * @param {string|null} existingThinking - Any existing thinking content (e.g., from message.thinking)
 * @returns {Object} { content: string, thinking: string|null }
 */
function extractThinkingBlocks(content, existingThinking = null) {
  if (!content) {
    return { content: content || '', thinking: existingThinking || null };
  }

  const thinkingParts = [];
  let cleanedContent = content;

  // Extract all <think> blocks
  let match;
  // Reset regex lastIndex for global regex
  THINKING_TAG_REGEX.lastIndex = 0;

  while ((match = THINKING_TAG_REGEX.exec(content)) !== null) {
    const thinkingContent = match[1].trim();
    if (thinkingContent) {
      thinkingParts.push(thinkingContent);
    }
  }

  // Remove all <think>...</think> blocks from content
  cleanedContent = content.replace(THINKING_TAG_REGEX, '').trim();

  // Combine extracted thinking with any existing thinking
  let combinedThinking = null;
  if (thinkingParts.length > 0) {
    const extractedThinking = thinkingParts.join('\n\n');
    if (existingThinking) {
      // Prepend newly extracted thinking to existing
      combinedThinking = extractedThinking + '\n\n' + existingThinking;
    } else {
      combinedThinking = extractedThinking;
    }
  } else if (existingThinking) {
    combinedThinking = existingThinking;
  }

  return {
    content: cleanedContent,
    thinking: combinedThinking
  };
}

function toNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function hasFinalContent(content) {
  return typeof content === 'string' && content.trim().length > 0;
}

/**
 * Build usage/performance stats from an Ollama final response.
 *
 * Ollama can report eval_count/eval_duration even when the application-visible
 * assistant content is empty. In that case throughput is not meaningful, so
 * tokensPerSecond stays null while raw usage and duration fields are preserved.
 */
function buildOllamaStats(data, assistantContent) {
  if (!data?.done) return null;

  const promptEvalCount = toNonNegativeNumber(data.prompt_eval_count);
  const evalCount = toNonNegativeNumber(data.eval_count);

  if (!promptEvalCount && !evalCount) return null;

  const totalDuration = toNonNegativeNumber(data.total_duration);
  const loadDuration = toNonNegativeNumber(data.load_duration);
  const evalDuration = toNonNegativeNumber(data.eval_duration);
  const contentForRate = arguments.length >= 2
    ? assistantContent
    : (data.message?.content || data.response || '');

  const canCalculateRate = hasFinalContent(contentForRate) && evalCount > 0 && evalDuration > 0;
  const tokensPerSecond = canCalculateRate
    ? Number((evalCount / (evalDuration / 1e9)).toFixed(2))
    : null;

  return {
    usage: {
      promptTokens: promptEvalCount,
      completionTokens: evalCount,
      totalTokens: promptEvalCount + evalCount
    },
    completion: {
      reason: data.done_reason || data.stop_reason || data.finish_reason || null
    },
    performance: {
      totalDuration,
      loadDuration,
      evalDuration,
      tokensPerSecond
    }
  };
}

/**
 * Extract assistant response from Ollama API response
 * Handles various response formats and thinking model outputs
 *
 * @param {Object} data - Ollama API response
 * @param {string} model - Model name for context
 * @returns {Object} { content: string, thinking: string|null, warning: string|null, stats: Object|null }
 */
function extractResponse(data, model, options = {}) {
  const {
    allowThinkingFallback = true,
    thinkingSupported
  } = options;
  const result = {
    content: '',
    thinking: null,
    warning: null,
    stats: null
  };

  // Check various response fields
  const hasMessageContent = data.message?.content && data.message.content.trim() !== '';
  const hasThinking = data.message?.thinking && data.message.thinking.trim() !== '';
  const hasResponse = data.response && data.response.trim() !== '';

  // Log response structure for debugging
  logger.debug('Ollama response structure', {
    model,
    hasMessageContent,
    messageContentLength: data.message?.content?.length || 0,
    hasThinking,
    thinkingLength: data.message?.thinking?.length || 0,
    hasResponse,
    responseLength: data.response?.length || 0,
    done: data.done
  });

  const hasVisibleThinkingTags = typeof (data.message?.content || data.response) === 'string'
    && /<think\b/i.test(data.message?.content || data.response);
  const preserveThinking = thinkingSupported === true
    || (thinkingSupported === undefined && (hasThinking || hasVisibleThinkingTags));

  // Preserve thinking only when the resolved capability contract allows it.
  // Direct response evidence remains the backward-compatible fallback when a
  // caller has not supplied a contract.
  if (preserveThinking && hasThinking) {
    result.thinking = data.message.thinking.trim();
  }

  // Priority order for response content:
  // 1. message.content (new chat API format)
  // 2. response (legacy generate API format)
  // 3. message.thinking (fallback for thinking-only responses)

  let rawContent = '';
  if (hasMessageContent) {
    rawContent = data.message.content;
  } else if (hasResponse) {
    rawContent = data.response;
  } else if (hasThinking && allowThinkingFallback) {
    // Use thinking as content if no other response available
    rawContent = data.message.thinking;
    result.warning = 'Used thinking output as response (no content field)';
    logger.warn('Using thinking as response', { model, reason: 'No content field' });
  }

  // Clean the content
  const cleanedContent = cleanContent(rawContent);
  const thinkingExtraction = extractThinkingBlocks(cleanedContent, result.thinking);

  // If originally non-empty content became empty after cleaning (e.g. only tags),
  // log for debugging purposes. This helps identify if we are aggressively stripping too much
  // or if the model output was indeed just "internal noise".
  if (rawContent && String(rawContent).trim() && !cleanedContent) {
    logger.warn('Content became empty after cleaning', {
      model,
      originalLength: String(rawContent).length
    });
  }

  result.content = thinkingExtraction.content;
  result.thinking = preserveThinking ? thinkingExtraction.thinking : null;
  result.stats = buildOllamaStats(data, result.content);

  // Check for incomplete responses
  if (data.done === false) {
    result.warning = 'Incomplete response - model may require streaming';
    logger.warn('Incomplete response received', { model, done: data.done });
  }

  // Validate we got something
  if (!result.content) {
    result.warning = 'Empty response from Ollama';
    logger.error('Empty response from Ollama', {
      model,
      responseKeys: Object.keys(data),
      hasMessage: !!data.message,
      messageKeys: data.message ? Object.keys(data.message) : []
    });
  }

  return result;
}

function cloneJson(value) {
  if (!value || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function readStructuredThinking(data) {
  const parts = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) parts.push(value.trim());
  };

  for (const field of REASONING_FIELD_NAMES) push(data?.[field]);
  for (const field of REASONING_FIELD_NAMES) push(data?.message?.[field]);

  if (Array.isArray(data?.choices)) {
    for (const choice of data.choices) {
      for (const field of REASONING_FIELD_NAMES) {
        push(choice?.message?.[field]);
        push(choice?.delta?.[field]);
      }
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

function stripReasoningFieldsFromObject(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const field of REASONING_FIELD_NAMES) {
    delete obj[field];
  }
}

function stripReasoningFields(data) {
  stripReasoningFieldsFromObject(data);
  stripReasoningFieldsFromObject(data?.message);

  if (Array.isArray(data?.choices)) {
    for (const choice of data.choices) {
      stripReasoningFieldsFromObject(choice?.message);
      stripReasoningFieldsFromObject(choice?.delta);
    }
  }
}

/**
 * Normalize an Ollama response for AgentX application callers.
 *
 * The dedicated OpenClaw/Hermes proxy routes preserve raw upstream payloads.
 * This helper is for `/api/inference/generate`, Buddy, RAG, Data, and other
 * internal callers that need a stable final-answer contract instead of raw
 * Ollama reasoning fields.
 */
function normalizeOllamaResponse(data, model, options = {}) {
  const {
    suppressThinking = true,
    includeThinking = false,
    thinkingSupported
  } = options;

  const normalized = cloneJson(data) || {};
  const structuredThinking = readStructuredThinking(data);
  const extracted = extractResponse(data || {}, model, {
    allowThinkingFallback: false,
    thinkingSupported
  });
  const thinking = extracted.thinking || structuredThinking || null;
  const content = extracted.content || '';

  normalized.response = content;
  if (normalized.message && typeof normalized.message === 'object') {
    normalized.message.content = content;
  } else if (data?.message && typeof data.message === 'object') {
    normalized.message = { content };
  }

  if (suppressThinking) {
    stripReasoningFields(normalized);
  } else if (includeThinking && thinking) {
    normalized.thinking = thinking;
    stripReasoningFieldsFromObject(normalized.message);
  }

  if (extracted.warning && !normalized.warning) {
    normalized.warning = extracted.warning;
  }

  normalized.agentx_normalized = true;

  return normalized;
}

/**
 * Build Ollama API payload with optimized settings
 * @param {Object} params - Request parameters
 * @returns {Object} Ollama API payload
 */
function buildOllamaPayload(params) {
  const {
    model,
    messages,
    options = {},
    streamEnabled = false,
    tools = [],
    think
  } = params;

  const parsedNumPredict = Number(options.num_predict);
  const streamNumPredict = Number.isFinite(parsedNumPredict) && parsedNumPredict > 0
    ? parsedNumPredict
    : -1;

  // Hoist keep_alive to payload root — Ollama expects it as a top-level field,
  // not nested under options (where it gets silently ignored).
  const { keep_alive, ...ollamaOptions } = options;

  const payload = {
    model,
    messages,
    stream: streamEnabled,
    options: {
      ...ollamaOptions,
      // Blank, zero, or negative values mean "don't cap the response".
      // Positive caller caps apply to both streaming and non-streaming calls.
      num_predict: streamNumPredict
    }
  };

  if (keep_alive !== undefined && keep_alive !== '') {
    payload.keep_alive = keep_alive;
  }

  // think: true/false is a top-level Ollama field, not nested in options
  if (think !== undefined) {
    payload.think = think;
  }

  // Add tools if provided (for function calling)
  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  return payload;
}

module.exports = {
  extractResponse,
  normalizeOllamaResponse,
  buildOllamaPayload,
  buildOllamaStats,
  cleanContent, // Export for testing
  extractThinkingBlocks // Export for benchmark thinking extraction
};
