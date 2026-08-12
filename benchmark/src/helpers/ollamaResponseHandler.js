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

// Other special tokens (eot_id, etc)
const OTHER_TOKENS_REGEX = /<\|(?:eot_id|begin_of_text|end_of_text|fin)\|>/g;

// Regex for extracting <think> blocks from reasoning models (e.g., DeepSeek-R1)
// Handles both properly closed tags and unclosed tags (captures until end of string)
const THINKING_TAG_REGEX = /<think>([\s\S]*?)(?:<\/think>|$)/gi;


/**
 * Detect if model has thinking/reasoning capabilities
 * @param {string} model - Model name
 * @returns {boolean}
 */
function isThinkingModel(model) {
  if (!model) return false;
  const thinkingModels = [
    'qwen', 'deepseek-r1', 'deepthink', 'o1', 'o3', 'reasoning'
  ];
  return thinkingModels.some(pattern =>
    model.toLowerCase().includes(pattern)
  );
}

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
    .replace(OTHER_TOKENS_REGEX, '')
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

/**
 * Extract assistant response from Ollama API response
 * Handles various response formats and thinking model outputs
 *
 * @param {Object} data - Ollama API response
 * @param {string} model - Model name for context
 * @returns {Object} { content: string, thinking: string|null, warning: string|null, stats: Object|null }
 */
function extractResponse(data, model) {
  const result = {
    content: '',
    thinking: null,
    warning: null,
    stats: null
  };

  // V4: Extract detailed usage stats if available
  if (data.done && (data.eval_count || data.prompt_eval_count)) {
    const totalDuration = data.total_duration || 0;
    const loadDuration = data.load_duration || 0;
    const evalDuration = data.eval_duration || 0;
    const evalCount = data.eval_count || 0;

    // Calculate tokens per second (avoid division by zero)
    // eval_duration is in nanoseconds. 1e9 ns = 1s.
    const durationSeconds = evalDuration / 1e9;
    const tokensPerSecond = durationSeconds > 0 ? (evalCount / durationSeconds) : 0;

    result.stats = {
      usage: {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: evalCount,
        totalTokens: (data.prompt_eval_count || 0) + evalCount
      },
      performance: {
        totalDuration,
        loadDuration,
        evalDuration,
        tokensPerSecond: Number(tokensPerSecond.toFixed(2))
      }
    };
  }

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

  // For thinking models, preserve thinking process
  if (isThinkingModel(model) && hasThinking) {
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
  } else if (hasThinking) {
    // Use thinking as content if no other response available
    rawContent = data.message.thinking;
    result.warning = 'Used thinking output as response (no content field)';
    logger.warn('Using thinking as response', { model, reason: 'No content field' });
  }

  // Clean the content
  const cleanedContent = cleanContent(rawContent);

  // If originally non-empty content became empty after cleaning (e.g. only tags),
  // log for debugging purposes. This helps identify if we are aggressively stripping too much
  // or if the model output was indeed just "internal noise".
  if (rawContent && String(rawContent).trim() && !cleanedContent) {
    logger.warn('Content became empty after cleaning', {
      model,
      originalLength: String(rawContent).length
    });
  }

  result.content = cleanedContent;

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
    tools = [],  // AgentX: N8N tools as LLM function calls
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

  // think: true/false is a top-level Ollama field, not nested in options.
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
  isThinkingModel,
  extractResponse,
  buildOllamaPayload,
  cleanContent, // Export for testing
  extractThinkingBlocks // Export for benchmark thinking extraction
};
