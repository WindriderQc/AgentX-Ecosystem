/**
 * Query Optimization Utilities
 *
 * A lean subset of the legacy utility set. Everything here has a clear
 * value proposition and covers a common real need:
 *
 *  - paginatedQuery  — parallel count+find with consistent shape
 *  - QueryCache      — process-local TTL cache for hot reads
 *  - findWithRetry   — retry on transient MongoNetworkError/MongoTimeoutError
 *  - monitorQuery    — slow-query logging decorator
 *
 * Skipped deliberately from the legacy version:
 *  - optimizeQuery   — thin wrapper; consumers can just chain .lean().limit() inline
 *  - batchQueries    — `Promise.all` with extra steps
 */

const logger = require('../../config/logger');

/**
 * Parallel count + find with a consistent return shape.
 *
 * @param {import('mongoose').Model} model
 * @param {object} filter       Mongoose query filter.
 * @param {object} [options]
 * @param {number} [options.page=1]
 * @param {number} [options.limit=20]
 * @param {object} [options.sort={ createdAt: -1 }]
 * @param {string|object} [options.select]   Mongoose select spec.
 * @param {string|object} [options.populate] Mongoose populate spec.
 * @returns {Promise<{ data: any[], total: number, page: number, pages: number, hasMore: boolean }>}
 */
async function paginatedQuery(model, filter = {}, options = {}) {
  const {
    page = 1,
    limit = 20,
    sort = { createdAt: -1 },
    select = null,
    populate = null
  } = options;

  const skip = (page - 1) * limit;

  const [total, data] = await Promise.all([
    model.countDocuments(filter),
    (async () => {
      let q = model.find(filter).sort(sort).skip(skip).limit(limit).lean();
      if (select) q = q.select(select);
      if (populate) q = q.populate(populate);
      return q.exec();
    })()
  ]);

  return {
    data,
    total,
    page,
    pages: Math.ceil(total / limit),
    hasMore: page * limit < total
  };
}

/**
 * Process-local TTL cache. Useful for hot reads that change infrequently
 * (active prompt config, feature flags, ownership tables).
 *
 * Beware: in PM2 fork mode each worker has its own cache. Do NOT use this
 * for anything that needs cross-process consistency — persist in Mongo.
 */
class QueryCache {
  constructor(ttlSeconds = 60) {
    this.cache = new Map();
    this.ttl = ttlSeconds * 1000;
  }

  async getOrFetch(key, fetchFn) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.ttl) {
      return cached.data;
    }
    const data = await fetchFn();
    this.cache.set(key, { data, timestamp: Date.now() });
    return data;
  }

  invalidate(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  getStats() {
    return { size: this.cache.size, ttlSeconds: this.ttl / 1000 };
  }
}

/**
 * Retry a find on transient MongoDB errors with exponential backoff.
 * Only retries `MongoNetworkError` and `MongoTimeoutError` — all other
 * errors propagate immediately.
 */
async function findWithRetry(model, filter, options = {}, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await model.find(filter, null, options).exec();
    } catch (err) {
      lastError = err;
      const transient = err.name === 'MongoNetworkError' || err.name === 'MongoTimeoutError';
      if (transient && attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt) * 100;
        logger.warn('Transient Mongo error, retrying', { attempt, backoffMs, error: err.message });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Decorator that logs slow queries (>1s) and failures with timing.
 * Wrap any async query-producing function to get observability.
 *
 *   const loadHotPrompts = monitorQuery('hotPrompts', async () => PromptConfig.find({ isActive: true }));
 */
function monitorQuery(queryName, queryFn) {
  return async function monitored(...args) {
    const startTime = Date.now();
    try {
      const result = await queryFn(...args);
      const duration = Date.now() - startTime;
      if (duration > 1000) logger.warn('Slow query detected', { queryName, duration });
      return result;
    } catch (err) {
      const duration = Date.now() - startTime;
      logger.error('Query failed', { queryName, duration, error: err.message });
      throw err;
    }
  };
}

module.exports = {
  paginatedQuery,
  QueryCache,
  findWithRetry,
  monitorQuery
};
