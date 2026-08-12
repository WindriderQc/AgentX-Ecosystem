/**
 * Artillery Load Test Helpers
 * Custom functions for request processing and metrics
 */

module.exports = {
  addTimestamp,
  recordSearchLatency,
  setAuthHeader
};

/**
 * Add timestamp to request for latency tracking
 */
function addTimestamp(requestParams, context, ee, next) {
  context.vars.requestStartTime = Date.now();
  return next();
}

/**
 * Record search latency metric
 */
function recordSearchLatency(requestParams, response, context, ee, next) {
  if (context.vars.requestStartTime) {
    const latency = Date.now() - context.vars.requestStartTime;
    ee.emit('counter', 'search_latency_ms', latency);

    // Emit latency buckets for percentile analysis
    if (latency < 100) {
      ee.emit('counter', 'search_fast', 1);
    } else if (latency < 500) {
      ee.emit('counter', 'search_medium', 1);
    } else {
      ee.emit('counter', 'search_slow', 1);
    }
  }
  return next();
}

/**
 * Set authentication header from login response
 */
function setAuthHeader(requestParams, response, context, ee, next) {
  if (response.body) {
    try {
      const data = JSON.parse(response.body);
      if (data.token) {
        context.vars.authToken = data.token;
      }
    } catch (err) {
      console.error('Failed to parse auth response:', err);
    }
  }
  return next();
}
