'use strict';

const THINKING_TAG_REGEX = /<think>([\s\S]*?)(?:<\/think>|$)/gi;

/** Separate visible output from explicit <think> blocks without guessing from a model name. */
function extractThinkingBlocks(content, existingThinking = null) {
  if (!content) return { content: content || '', thinking: existingThinking || null };

  const thinkingParts = [];
  THINKING_TAG_REGEX.lastIndex = 0;
  let match;
  while ((match = THINKING_TAG_REGEX.exec(content)) !== null) {
    const thinking = match[1].trim();
    if (thinking) thinkingParts.push(thinking);
  }

  const cleanedContent = content.replace(THINKING_TAG_REGEX, '').trim();
  const extracted = thinkingParts.length ? thinkingParts.join('\n\n') : null;
  return {
    content: cleanedContent,
    thinking: extracted && existingThinking
      ? `${extracted}\n\n${existingThinking}`
      : (extracted || existingThinking || null)
  };
}

function buildOllamaPayload({ model, messages, options = {}, streamEnabled = false, tools = [], think }) {
  const parsedNumPredict = Number(options.num_predict);
  const numPredict = Number.isFinite(parsedNumPredict) && parsedNumPredict > 0 ? parsedNumPredict : -1;
  const { keep_alive, ...ollamaOptions } = options;
  const payload = {
    model,
    messages,
    stream: streamEnabled,
    options: { ...ollamaOptions, num_predict: numPredict }
  };
  if (keep_alive !== undefined && keep_alive !== '') payload.keep_alive = keep_alive;
  if (think !== undefined) payload.think = think;
  if (tools.length > 0) payload.tools = tools;
  return payload;
}

module.exports = { extractThinkingBlocks, buildOllamaPayload };
