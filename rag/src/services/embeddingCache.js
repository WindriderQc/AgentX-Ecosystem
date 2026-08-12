/**
 * LRU Embedding Cache — avoids redundant GPU calls for previously-seen text.
 * Keys are SHA-256 hashes of (model + text). In-memory only (PM2 restart clears it).
 */

const crypto = require('crypto');

const DEFAULT_MAX_SIZE = Number(process.env.EMBEDDING_CACHE_SIZE) || 1000;
const DEFAULT_TTL_MS = Number(process.env.EMBEDDING_CACHE_TTL_MS) || 86400000; // 24h

class EmbeddingCache {
  constructor({ maxSize = DEFAULT_MAX_SIZE, ttlMs = DEFAULT_TTL_MS } = {}) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    /** @type {Map<string, { embedding: number[], createdAt: number }>} */
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /**
   * Build a cache key from model name + input text.
   */
  _key(text, model) {
    return crypto.createHash('sha256').update(`${model}:${text}`).digest('hex');
  }

  /**
   * Get a cached embedding. Returns the embedding array or null.
   * Expired entries are evicted on access (lazy TTL).
   */
  get(text, model) {
    const key = this._key(text, model);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // TTL check
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      this.evictions++;
      this.misses++;
      return null;
    }

    // Move to end for LRU freshness (delete + re-insert)
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.hits++;
    return entry.embedding;
  }

  /**
   * Store an embedding in the cache. Evicts the oldest entry if at capacity.
   */
  set(text, model, embedding) {
    const key = this._key(text, model);

    // If key already exists, delete it first (refresh position)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest (first entry in Map) if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
      this.evictions++;
    }

    this.cache.set(key, { embedding, createdAt: Date.now() });
  }

  /**
   * Clear all entries and reset counters.
   */
  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /**
   * Return cache statistics.
   */
  getStats() {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: total > 0 ? +(this.hits / total).toFixed(4) : 0,
    };
  }
}

// Module-level singleton
let instance = null;

function getEmbeddingCache(opts) {
  if (!instance) {
    instance = new EmbeddingCache(opts);
  }
  return instance;
}

function resetEmbeddingCache() {
  instance = null;
}

module.exports = { EmbeddingCache, getEmbeddingCache, resetEmbeddingCache };
