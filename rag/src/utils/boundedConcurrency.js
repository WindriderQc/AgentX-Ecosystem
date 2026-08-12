'use strict';

/**
 * Run an async task for each item, capping how many run concurrently.
 *
 * Order-preserving: results[i] corresponds to items[i], regardless of
 * completion order. On task rejection the returned promise rejects (matching
 * Promise.all semantics); catch inside the task body if you want per-item
 * error tolerance (reranker and ragCompression both do).
 *
 * Used to prevent RAG fan-out from overwhelming Ollama hosts — unbounded
 * Promise.all on 50-chunk reranking could fire 50 concurrent LLM calls at a
 * single host, evicting its KV cache mid-batch and cascading reloads.
 *
 * @template T, U
 * @param {Array<T>} items
 * @param {(item: T, index: number) => Promise<U>} task
 * @param {number} limit max in-flight tasks
 * @returns {Promise<Array<U>>}
 */
async function boundedConcurrency(items, task, limit) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const n = items.length;
  const cap = Math.max(1, Math.min(Number(limit) | 0 || 1, n));
  const results = new Array(n);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= n) return;
      results[i] = await task(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
  return results;
}

module.exports = { boundedConcurrency };
