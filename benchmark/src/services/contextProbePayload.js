/**
 * Context Probe Payload Generator
 *
 * Generates deterministic fill prompts that consume a target number of tokens.
 * Used by the host test service to fill context windows during performance probes.
 */

// ~100 tokens of repeatable prose (measured against Ollama tokenizers)
const FILL_BLOCK = [
  'The quick brown fox jumps over the lazy dog near the riverbank.',
  'Mountains rise above the valley where ancient forests grow tall.',
  'Scientists discovered a new species of butterfly in the rainforest.',
  'The old clocktower chimed twelve times as the crowd gathered below.',
  'Waves crashed against the rocky shoreline under a gray autumn sky.',
  'A small village at the edge of the desert thrived on trade routes.',
  'Engineers designed a bridge that could withstand powerful earthquakes.',
  'The library contained thousands of manuscripts from the medieval era.'
].join(' ');

// Approximate tokens in FILL_BLOCK (conservative: 1 token ≈ 4 chars)
const BLOCK_TOKENS = Math.ceil(FILL_BLOCK.length / 4);

/**
 * Generate a prompt that fills approximately `targetTokens` tokens.
 * Leaves room for a deterministic completion instruction.
 *
 * @param {number} targetTokens - Desired prompt token count
 * @param {object} [opts]
 * @param {number} [opts.decodeIntegers=64] - How many integers the footer asks
 *   the model to output. Callers measuring sustained decode (e.g. the fixed
 *   prefill/decode matrix) request more integers than fit in num_predict so
 *   generation runs to the cap instead of stopping at a natural end.
 * @returns {{ prompt: string, estimatedTokens: number }}
 */
function generateFillPrompt(targetTokens, opts = {}) {
  const decodeIntegers = Number.isFinite(Number(opts.decodeIntegers)) && Number(opts.decodeIntegers) > 0
    ? Math.round(Number(opts.decodeIntegers))
    : 64;
  if (!targetTokens || targetTokens < 100) {
    return { prompt: FILL_BLOCK, estimatedTokens: BLOCK_TOKENS };
  }

  // Reserve enough room for a completion instruction that produces a real
  // decode sample. A one-word footer makes eval_count tiny and turns tok/s
  // into noise, especially in context probes.
  const footerTokens = 60;
  const fillTarget = targetTokens - footerTokens;
  const repetitions = Math.max(1, Math.ceil(fillTarget / BLOCK_TOKENS));

  const parts = [];
  for (let i = 0; i < repetitions; i++) {
    parts.push(FILL_BLOCK);
  }

  const footer = [
    '',
    '',
    `Ignore the text above. Output the integers 1 through ${decodeIntegers} separated by spaces.`,
    `Do not explain. Do not add punctuation. Stop after ${decodeIntegers}.`
  ].join('\n');
  const prompt = parts.join('\n') + footer;
  const estimatedTokens = Math.ceil(prompt.length / 4);

  return { prompt, estimatedTokens };
}

module.exports = { generateFillPrompt };
