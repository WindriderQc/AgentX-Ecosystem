const logger = require('../../config/logger');
const PerformanceSnapshot = require('../../models/PerformanceSnapshot');

/**
 * Performance Tracking Middleware
 *
 * Tracks HTTP request metrics and aggregates them hourly into PerformanceSnapshot.
 * Operates with in-memory buffering to avoid blocking request processing.
 *
 * Features:
 * - Non-blocking async processing
 * - Hourly aggregation with automatic flushing
 * - Per-endpoint tracking
 * - Status code distribution
 * - Percentile calculation (p50, p95, p99)
 *
 * @see /models/PerformanceSnapshot.js - Database schema
 * @see /routes/performance.js - Dashboard queries
 */

// In-memory buffer for request data (flushed every 60 seconds)
const requestBuffer = [];

// Paths to skip tracking (static files, health checks)
const SKIP_PATHS = [
  '/static',
  '/public',
  '/health',
  '/favicon.ico',
  '/assets',
  '/css',
  '/js',
  '/images'
];

/**
 * Track individual HTTP request
 *
 * Middleware function that measures request latency and buffers metrics.
 * Does NOT block request processing - uses event listener on response finish.
 *
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Next middleware
 */
/**
 * Collapse high-cardinality path segments so `by_endpoint` stays bounded.
 * A Mongo ObjectId, UUID, or bare number in a path is an argument, not a route.
 */
function normalizePath(pathname) {
  return pathname
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (/^[0-9a-f]{24}$/i.test(seg)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id';
      if (/^\d+$/.test(seg)) return ':id';
      return seg;
    })
    .join('/');
}

function trackRequest(req, res, next) {
  // Skip static files and health checks
  if (SKIP_PATHS.some(path => req.path.startsWith(path))) {
    return next();
  }

  // Capture the FULL path now, before routing mutates it.
  //
  // This used to read req.path inside the finish handler. Express strips the
  // mount prefix from req.url while inside a mounted router, so by the time
  // 'finish' fired the recorded path was router-relative: every router root
  // collapsed into a single "/" bucket, and /api/widgets/report was stored
  // as "/report". The endpoint table was unusable for diagnosis -- "/" was the
  // busiest "endpoint" on the platform while naming nothing at all, and two
  // unrelated handlers could share one row.
  //
  // req.originalUrl is set once at request entry and never rewritten.
  const trackedPath = normalizePath((req.originalUrl || req.url || '/').split('?')[0]);

  const start = Date.now();

  // Hook into response finish event (non-blocking)
  res.on('finish', () => {
    try {
      const latency = Date.now() - start;

      requestBuffer.push({
        path: trackedPath,
        method: req.method,
        status: res.statusCode,
        latency,
        timestamp: new Date()
      });

      // Log slow requests (> 2 seconds)
      if (latency > 2000) {
        logger.warn('Slow request detected', {
          path: trackedPath,
          method: req.method,
          latency,
          status: res.statusCode
        });
      }
    } catch (err) {
      // Don't let tracking errors break requests
      logger.error('Performance tracking error', { error: err.message });
    }
  });

  next();
}

/**
 * Flush buffered requests to database
 *
 * Aggregates buffered request data by hour and upserts to PerformanceSnapshot.
 * Runs asynchronously every 60 seconds via setInterval.
 *
 * Aggregations:
 * - Total, successful, failed request counts
 * - Latency statistics (min, max, avg, p95, p99)
 * - Per-endpoint breakdown
 * - Status code distribution
 */
async function flushToDatabase() {
  if (requestBuffer.length === 0) {
    return;
  }

  let requests = [];
  try {
    // Create copy and clear buffer atomically
    requests = requestBuffer.splice(0, requestBuffer.length);

    const hour = new Date();
    hour.setMinutes(0, 0, 0); // Truncate to hour

    // Calculate aggregated metrics
    const summary = {
      hour,
      requests_total: requests.length,
      requests_successful: requests.filter(r => r.status >= 200 && r.status < 400).length,
      requests_failed: requests.filter(r => r.status >= 400).length,
      latency: calculateLatencyStats(requests),
      by_endpoint: groupByEndpoint(requests),
      by_status_code: groupByStatusCode(requests)
    };

    // ATOMIC OPERATION: Use updateOne with atomic operators to prevent race conditions
    // In PM2 cluster or multi-server setups, multiple workers can flush simultaneously

    // Build atomic increment operations for status codes
    const statusCodeIncs = {};
    Object.entries(summary.by_status_code).forEach(([code, count]) => {
      statusCodeIncs[`by_status_code.${code}`] = count;
    });

    // Step 1: Atomically update counters and min/max latency
    // Note: $setOnInsert cannot include latency fields as it conflicts with $min/$max operators
    await PerformanceSnapshot.updateOne(
      { hour },
      {
        $inc: {
          requests_total: summary.requests_total,
          requests_successful: summary.requests_successful,
          requests_failed: summary.requests_failed,
          ...statusCodeIncs
        },
        $min: { 'latency.min': summary.latency.min || 999999 },
        $max: { 'latency.max': summary.latency.max || 0 },
        $setOnInsert: {
          hour,
          by_endpoint: []
          // latency fields initialized in Step 2 to avoid conflicts
        }
      },
      { upsert: true }
    );

    // Step 2: Update complex aggregations (avg, percentiles, endpoints) using findOneAndUpdate
    // This reduces race window compared to find-then-save, though not fully atomic
    const snapshot = await PerformanceSnapshot.findOneAndUpdate(
      { hour },
      {},
      { new: true }
    );

    if (snapshot) {
      // Recalculate weighted average latency
      const totalRequests = snapshot.requests_total;
      const newRequestCount = requests.length;
      const previousRequestCount = totalRequests - newRequestCount;
      const previousAvg = snapshot.latency.avg || 0;
      const newAvg = summary.latency.avg || 0;

      snapshot.latency.avg = previousRequestCount > 0
        ? Math.round((previousAvg * previousRequestCount + newAvg * newRequestCount) / totalRequests)
        : newAvg;

      // Update percentiles (approximate - computed from running average)
      // Note: True percentiles require all samples; this is an approximation for clustered environments
      const allLatencies = [
        ...Array(Math.min(previousRequestCount, 1000)).fill(previousAvg),
        ...requests.map(r => r.latency)
      ];
      const approxStats = calculateLatencyStats(allLatencies.map(latency => ({ latency })));
      snapshot.latency.p95 = approxStats.p95;
      snapshot.latency.p99 = approxStats.p99;

      // Merge endpoint data
      summary.by_endpoint.forEach(newEndpoint => {
        const existing = snapshot.by_endpoint.find(
          e => e.path === newEndpoint.path && e.method === newEndpoint.method
        );

        if (existing) {
          const previousCount = existing.count;
          const previousAvg = existing.avg_latency || 0;
          existing.count += newEndpoint.count;
          existing.error_count += newEndpoint.error_count;
          // Weighted average for endpoint latency
          existing.avg_latency = Math.round(
            (previousAvg * previousCount + newEndpoint.avg_latency * newEndpoint.count) /
            (previousCount + newEndpoint.count)
          );
        } else {
          snapshot.by_endpoint.push(newEndpoint);
        }
      });

      await snapshot.save();
    }

    logger.debug('Performance snapshot updated', {
      hour: hour.toISOString(),
      requests: summary.requests_total,
      avg_latency: summary.latency.avg
    });
  } catch (err) {
    if (requestBuffer.length === 0 && requests.length > 0) {
      requestBuffer.unshift(...requests);
    }
    logger.error('Performance snapshot flush failed', {
      error: err.message,
      buffer_size: requestBuffer.length
    });
  }
}

/**
 * Calculate latency statistics
 *
 * @param {Array} requests - Array of request objects with latency field
 * @returns {Object} Stats object with min, max, avg, p95, p99
 */
function calculateLatencyStats(requests) {
  if (!requests || requests.length === 0) {
    return { min: 0, max: 0, avg: 0, p95: 0, p99: 0 };
  }

  const latencies = requests.map(r => r.latency).sort((a, b) => a - b);

  const getPercentile = (p) => {
    const index = Math.ceil((p / 100) * latencies.length) - 1;
    return latencies[Math.max(0, index)];
  };

  const sum = latencies.reduce((acc, val) => acc + val, 0);

  return {
    min: latencies[0],
    max: latencies[latencies.length - 1],
    avg: Math.round(sum / latencies.length),
    p95: getPercentile(95),
    p99: getPercentile(99)
  };
}

/**
 * Group requests by endpoint (path + method)
 *
 * @param {Array} requests - Array of request objects
 * @returns {Array} Endpoint breakdown with count, avg_latency, error_count
 */
function groupByEndpoint(requests) {
  const endpoints = {};

  requests.forEach(req => {
    const key = `${req.method}:${req.path}`;

    if (!endpoints[key]) {
      endpoints[key] = {
        path: req.path,
        method: req.method,
        count: 0,
        latency_sum: 0,
        error_count: 0
      };
    }

    endpoints[key].count++;
    endpoints[key].latency_sum += req.latency;

    if (req.status >= 400) {
      endpoints[key].error_count++;
    }
  });

  // Convert to array and calculate averages
  return Object.values(endpoints).map(e => ({
    path: e.path,
    method: e.method,
    count: e.count,
    avg_latency: Math.round(e.latency_sum / e.count),
    error_count: e.error_count
  }));
}

/**
 * Group requests by HTTP status code
 *
 * @param {Array} requests - Array of request objects
 * @returns {Object} Status code counts (e.g., { "200": 1234, "500": 5 })
 */
function groupByStatusCode(requests) {
  const codes = {};

  requests.forEach(req => {
    const code = req.status.toString();
    codes[code] = (codes[code] || 0) + 1;
  });

  return codes;
}

/**
 * Get current buffer status (for debugging)
 *
 * @returns {Object} Buffer stats
 */
/**
 * Shallow copy of the pending buffer. Diagnostics and tests only — callers must
 * not mutate it, and it is not exposed over HTTP.
 */
function peekBuffer() {
  return requestBuffer.slice();
}

function getBufferStatus() {
  return {
    size: requestBuffer.length,
    oldest: requestBuffer.length > 0 ? requestBuffer[0].timestamp : null,
    newest: requestBuffer.length > 0 ? requestBuffer[requestBuffer.length - 1].timestamp : null
  };
}

// Start periodic flushing (every 60 seconds)
// In tests, avoid starting background intervals (open handles + DB writes).
let flushInterval;
if (process.env.NODE_ENV !== 'test') {
  flushInterval = setInterval(flushToDatabase, 60000);

  // Graceful shutdown: flush on process exit
  process.on('SIGTERM', async () => {
    clearInterval(flushInterval);
    await flushToDatabase();
    logger.info('Performance tracker shutdown complete');
  });

  process.on('SIGINT', async () => {
    clearInterval(flushInterval);
    await flushToDatabase();
    logger.info('Performance tracker shutdown complete');
  });
}

module.exports = {
  trackRequest,
  flushToDatabase,
  getBufferStatus,
  normalizePath,
  peekBuffer
};
