const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const PerformanceLoadTest = require('../models/PerformanceLoadTest');
const PerformanceBaseline = require('../models/PerformanceBaseline');
const PerformanceSnapshot = require('../models/PerformanceSnapshot');
const artilleryParser = require('../src/services/artilleryParser');
const { calculateSystemHealth, buildHistogram } = require('./performance-helpers');
const envelope = require('../src/helpers/responseEnvelope');
const {
  normalizeObservedPath,
  coalesceEndpointRows
} = require('../src/services/endpointPathPolicy');

/**
 * Performance Monitoring Routes
 *
 * Provides API endpoints for performance benchmarking dashboard.
 * Integrates Artillery load test results, baselines, and real-time snapshots.
 *
 * @see /models/PerformanceLoadTest.js - Load test schema
 * @see /models/PerformanceBaseline.js - Baseline schema
 * @see /models/PerformanceSnapshot.js - Real-time metrics schema
 * @see /src/services/artilleryParser.js - Artillery JSON parser
 */

/**
 * GET /api/performance/dashboard
 *
 * Dashboard overview with system health metrics
 *
 * Returns:
 * - System health status
 * - Average latency (24h)
 * - Throughput (requests per second)
 * - Error rate
 * - Uptime percentage
 *
 * @returns {Object} Dashboard metrics
 */
router.get('/dashboard', async (req, res) => {
  try {
    logger.info('Fetching performance dashboard metrics');

    const hours = parseInt(req.query.hours, 10) || 24;
    const startDate = new Date(Date.now() - hours * 60 * 60 * 1000);
    const now = new Date();

    // Fetch aggregated metrics from snapshots
    const metrics = await PerformanceSnapshot.getAggregatedMetrics(startDate, now);

    // Trend deltas compare COMPLETE hours only.
    //
    // Snapshots are hourly buckets that fill as the hour runs, so the newest
    // bucket is always partial. Comparing it against a finished window made the
    // deltas swing wildly with wall-clock position: ten minutes into an hour,
    // hours=1 reported a -87% throughput "drop" that was purely an artefact of
    // measuring 10 minutes against 60. Ending both windows at the top of the
    // current hour compares like with like.
    const completeHoursEnd = new Date(now);
    completeHoursEnd.setMinutes(0, 0, 0);
    const trendCurrentStart = new Date(completeHoursEnd.getTime() - hours * 60 * 60 * 1000);
    const trendPrevStart = new Date(trendCurrentStart.getTime() - hours * 60 * 60 * 1000);

    const [trendCurrentMetrics, prevMetrics] = await Promise.all([
      PerformanceSnapshot.getAggregatedMetrics(trendCurrentStart, completeHoursEnd),
      PerformanceSnapshot.getAggregatedMetrics(trendPrevStart, trendCurrentStart)
    ]);

    // Snapshot provenance (for UI transparency)
    const [snapshotsCount, lastSnapshot] = await Promise.all([
      PerformanceSnapshot.countDocuments({ hour: { $gte: startDate, $lte: now } }),
      PerformanceSnapshot.findOne({ hour: { $gte: startDate, $lte: now } })
        .sort({ hour: -1 })
        .select('hour requests_total')
        .lean()
    ]);

    // Endpoint-derived provenance (exact breakdown + semantic grouping)
    const endpointFacet = await PerformanceSnapshot.aggregate([
      {
        $match: {
          hour: { $gte: startDate, $lte: now }
        }
      },
      { $unwind: '$by_endpoint' },
      {
        $addFields: {
          endpoint_path: '$by_endpoint.path',
          endpoint_method: '$by_endpoint.method',
          endpoint_count: '$by_endpoint.count',
          endpoint_error_count: '$by_endpoint.error_count',
          endpoint_avg_latency: '$by_endpoint.avg_latency'
        }
      },
      {
        $addFields: {
          endpoint_is_api: {
            $regexMatch: {
              input: '$endpoint_path',
              regex: '^/api/'
            }
          }
        }
      },
      {
        $addFields: {
          endpoint_category: {
            $cond: [
              '$endpoint_is_api',
              {
                $switch: {
                  branches: [
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/api/(chat|chatkit)(/|$)' } }, then: 'chat' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/api/(conversation|conversations)(/|$)' } }, then: 'conversations' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/api/(history)(/|$)' } }, then: 'history' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/api/(rag|search)(/|$)' } }, then: 'rag' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/api/(workflow|workflows|batch|batches|job|jobs|task|tasks)(/|$)' } }, then: 'batch_workflows' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/api/(auth|login|logout|session|sessions)(/|$)' } }, then: 'auth' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/api/(alerts)(/|$)' } }, then: 'alerts' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/api/(metrics|performance)(/|$)' } }, then: 'metrics' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/api/(admin|config|settings)(/|$)' } }, then: 'admin' }
                  ],
                  default: 'other_api'
                }
              },
              {
                $switch: {
                  branches: [
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/batch(/|$)' } }, then: 'batch_ui' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/(dashboard|active-stats)(/|$)' } }, then: 'ui_pages' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/performance(/|$)' } }, then: 'ui_performance' }
                  ],
                  default: 'other_non_api'
                }
              }
            ]
          }
        }
      },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: '$endpoint_is_api',
                count: { $sum: '$endpoint_count' },
                error_count: { $sum: '$endpoint_error_count' }
              }
            }
          ],
          categories: [
            {
              $group: {
                _id: '$endpoint_category',
                count: { $sum: '$endpoint_count' },
                error_count: { $sum: '$endpoint_error_count' },
                latency_weighted_sum: {
                  $sum: {
                    $multiply: [
                      { $ifNull: ['$endpoint_avg_latency', 0] },
                      '$endpoint_count'
                    ]
                  }
                },
                latency_count_sum: { $sum: '$endpoint_count' }
              }
            },
            {
              $project: {
                _id: 0,
                category: '$_id',
                count: 1,
                error_count: 1,
                error_rate: {
                  $cond: [
                    { $gt: ['$count', 0] },
                    { $round: [{ $multiply: [{ $divide: ['$error_count', '$count'] }, 100] }, 2] },
                    0
                  ]
                },
                avg_latency: {
                  $cond: [
                    { $gt: ['$latency_count_sum', 0] },
                    { $round: [{ $divide: ['$latency_weighted_sum', '$latency_count_sum'] }, 0] },
                    0
                  ]
                }
              }
            },
            { $sort: { count: -1 } }
          ],
          top_endpoints: [
            {
              $group: {
                _id: { path: '$endpoint_path', method: '$endpoint_method' },
                count: { $sum: '$endpoint_count' },
                error_count: { $sum: '$endpoint_error_count' },
                latency_weighted_sum: {
                  $sum: {
                    $multiply: [
                      { $ifNull: ['$endpoint_avg_latency', 0] },
                      '$endpoint_count'
                    ]
                  }
                },
                latency_count_sum: { $sum: '$endpoint_count' }
              }
            },
            {
              $project: {
                _id: 0,
                path: '$_id.path',
                method: '$_id.method',
                count: 1,
                error_count: 1,
                error_rate: {
                  $cond: [
                    { $gt: ['$count', 0] },
                    { $round: [{ $multiply: [{ $divide: ['$error_count', '$count'] }, 100] }, 2] },
                    0
                  ]
                },
                avg_latency: {
                  $cond: [
                    { $gt: ['$latency_count_sum', 0] },
                    { $round: [{ $divide: ['$latency_weighted_sum', '$latency_count_sum'] }, 0] },
                    0
                  ]
                }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 5 }
          ],
          top_error_endpoints: [
            {
              $group: {
                _id: { path: '$endpoint_path', method: '$endpoint_method' },
                count: { $sum: '$endpoint_count' },
                error_count: { $sum: '$endpoint_error_count' },
                latency_weighted_sum: {
                  $sum: {
                    $multiply: [
                      { $ifNull: ['$endpoint_avg_latency', 0] },
                      '$endpoint_count'
                    ]
                  }
                },
                latency_count_sum: { $sum: '$endpoint_count' }
              }
            },
            { $match: { count: { $gte: 20 } } },
            {
              $project: {
                _id: 0,
                path: '$_id.path',
                method: '$_id.method',
                count: 1,
                error_count: 1,
                error_rate: {
                  $cond: [
                    { $gt: ['$count', 0] },
                    { $round: [{ $multiply: [{ $divide: ['$error_count', '$count'] }, 100] }, 2] },
                    0
                  ]
                },
                avg_latency: {
                  $cond: [
                    { $gt: ['$latency_count_sum', 0] },
                    { $round: [{ $divide: ['$latency_weighted_sum', '$latency_count_sum'] }, 0] },
                    0
                  ]
                }
              }
            },
            { $sort: { error_rate: -1, error_count: -1, count: -1 } },
            { $limit: 5 }
          ],
          top_slow_endpoints: [
            {
              $group: {
                _id: { path: '$endpoint_path', method: '$endpoint_method' },
                count: { $sum: '$endpoint_count' },
                error_count: { $sum: '$endpoint_error_count' },
                latency_weighted_sum: {
                  $sum: {
                    $multiply: [
                      { $ifNull: ['$endpoint_avg_latency', 0] },
                      '$endpoint_count'
                    ]
                  }
                },
                latency_count_sum: { $sum: '$endpoint_count' }
              }
            },
            { $match: { count: { $gte: 20 } } },
            {
              $project: {
                _id: 0,
                path: '$_id.path',
                method: '$_id.method',
                count: 1,
                error_count: 1,
                error_rate: {
                  $cond: [
                    { $gt: ['$count', 0] },
                    { $round: [{ $multiply: [{ $divide: ['$error_count', '$count'] }, 100] }, 2] },
                    0
                  ]
                },
                avg_latency: {
                  $cond: [
                    { $gt: ['$latency_count_sum', 0] },
                    { $round: [{ $divide: ['$latency_weighted_sum', '$latency_count_sum'] }, 0] },
                    0
                  ]
                }
              }
            },
            { $match: { avg_latency: { $gt: 0 } } },
            { $sort: { avg_latency: -1, count: -1 } },
            { $limit: 5 }
          ]
        }
      }
    ]);

    const facet = Array.isArray(endpointFacet) && endpointFacet.length ? endpointFacet[0] : {};
    const totals = Array.isArray(facet.totals) ? facet.totals : [];
    const categories = Array.isArray(facet.categories) ? facet.categories : [];
    const topEndpoints = coalesceEndpointRows(facet.top_endpoints)
      .sort((a, b) => b.count - a.count);

    const topErrorEndpoints = coalesceEndpointRows(facet.top_error_endpoints)
      .sort((a, b) => b.error_rate - a.error_rate || b.error_count - a.error_count || b.count - a.count);

    const topSlowEndpoints = coalesceEndpointRows(facet.top_slow_endpoints)
      .sort((a, b) => b.avg_latency - a.avg_latency || b.count - a.count);

    const breakdown = {
      api_requests: 0,
      non_api_requests: 0,
      total_endpoint_requests: 0,
      delta_vs_total_requests: 0
    };
    for (const t of totals) {
      const isApi = !!t?._id;
      const count = t?.count || 0;
      breakdown.total_endpoint_requests += count;
      if (isApi) breakdown.api_requests += count;
      else breakdown.non_api_requests += count;
    }

    const totalRequests = metrics?.total_requests || 0;
    breakdown.delta_vs_total_requests = breakdown.total_endpoint_requests - totalRequests;

    // Fetch latest load test result
    const latestLoadTest = await PerformanceLoadTest.getLatest();

    // Fetch active baseline for comparison
    const activeBaseline = await PerformanceBaseline.getActive();

    // Calculate system health
    const systemHealth = calculateSystemHealth(metrics, activeBaseline);

    // Get throughput trend
    const throughputTrend = await PerformanceSnapshot.getThroughputTrend(hours);
    const avgRps = throughputTrend.length > 0
      ? throughputTrend.reduce((sum, t) => sum + parseFloat(t.rps), 0) / throughputTrend.length
      : 0;

    // Calculate uptime (percentage of successful requests)
    const uptimePercent = metrics && metrics.total_requests > 0
      ? ((metrics.total_successful / metrics.total_requests) * 100).toFixed(2)
      : 100;

    // Percent change vs the previous window. null when there is no comparable history,
    // so the UI can hide the arrow instead of implying a flat trend.
    const pctChange = (current, previous) => {
      if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
      return parseFloat((((current - previous) / previous) * 100).toFixed(1));
    };

    // Both sides use the same totals-over-seconds basis so the ratio is honest.
    const windowSeconds = hours * 3600;
    const rpsOf = (m) => (m && windowSeconds > 0 ? m.total_requests / windowSeconds : null);

    const trends = {
      avg_latency_pct: pctChange(trendCurrentMetrics?.avg_latency, prevMetrics?.avg_latency),
      p95_latency_pct: pctChange(trendCurrentMetrics?.avg_p95, prevMetrics?.avg_p95),
      error_rate_pct: pctChange(trendCurrentMetrics?.error_rate, prevMetrics?.error_rate),
      throughput_pct: pctChange(rpsOf(trendCurrentMetrics), rpsOf(prevMetrics)),
      basis: 'complete-hours-only',
      current_window: {
        from: trendCurrentStart,
        to: completeHoursEnd,
        total_requests: trendCurrentMetrics?.total_requests || 0
      },
      previous_window: {
        from: trendPrevStart,
        to: trendCurrentStart,
        total_requests: prevMetrics?.total_requests || 0
      }
    };

    const dashboard = {
        system_health: systemHealth,
        trends,
        metrics_24h: {
          avg_latency: metrics?.avg_latency || 0,
          p95_latency: metrics?.avg_p95 || 0,
          p99_latency: metrics?.avg_p99 || 0,
          error_rate: metrics?.error_rate || 0,
          total_requests: metrics?.total_requests || 0,
          throughput_rps: parseFloat(avgRps.toFixed(2)),
          uptime_percent: parseFloat(uptimePercent)
        },
        latest_load_test: latestLoadTest ? {
          name: latestLoadTest.name,
          scenario: latestLoadTest.scenario,
          timestamp: latestLoadTest.timestamp,
          p95_latency: latestLoadTest.latency.p95,
          error_rate: latestLoadTest.summary.error_rate
        } : null,
        active_baseline: activeBaseline ? {
          name: activeBaseline.name,
          p95_latency: activeBaseline.metrics.p95_latency,
          error_rate: activeBaseline.metrics.error_rate
        } : null,
        sources: {
          production: {
            hours,
            snapshots: snapshotsCount,
            total_requests: metrics?.total_requests || 0,
            last_snapshot_hour: lastSnapshot?.hour || null,
            breakdown,
            category_breakdown: categories,
            top_endpoints: topEndpoints,
            top_error_endpoints: topErrorEndpoints,
            top_slow_endpoints: topSlowEndpoints
          },
          latest_load_test: latestLoadTest ? {
            name: latestLoadTest.name,
            scenario: latestLoadTest.scenario,
            timestamp: latestLoadTest.timestamp
          } : null,
          active_baseline: activeBaseline ? {
            name: activeBaseline.name
          } : null,
          tracking_scope: 'Non-static, non-health HTTP requests (middleware-based)'
        }
    };

    envelope.success(res, dashboard);
  } catch (err) {
    logger.error('Dashboard metrics fetch failed', { error: err.message });
    envelope.error(res, 500, err.message);
  }
});

// Load tests, baselines, and baseline-compare extracted to performance-data.js
router.use('/', require('./performance-data'));


/**
 * GET /api/performance/latency-trends
 *
 * Get latency trends over time
 *
 * Query params:
 * - hours: Lookback period (default: 24)
 * - endpoint: Filter by specific endpoint (optional)
 *
 * @returns {Array} Time-series latency data
 */
router.get('/latency-trends', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours, 10) || 24;
    const endpoint = req.query.endpoint;

    logger.info('Fetching latency trends', { hours, endpoint });

    const trends = await PerformanceSnapshot.getLatencyTrend(hours, endpoint);

    res.json({
      status: 'success',
      data: {
        trends,
        count: trends.length,
        hours,
        endpoint: endpoint || 'all'
      }
    });
  } catch (err) {
    logger.error('Latency trends fetch failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * GET /api/performance/throughput
 *
 * Get throughput trends (requests per second)
 *
 * Query params:
 * - hours: Lookback period (default: 24)
 *
 * @returns {Array} Time-series throughput data
 */
router.get('/throughput', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours, 10) || 24;

    logger.info('Fetching throughput trends', { hours });

    const throughput = await PerformanceSnapshot.getThroughputTrend(hours);

    res.json({
      status: 'success',
      data: {
        throughput,
        count: throughput.length,
        hours
      }
    });
  } catch (err) {
    logger.error('Throughput fetch failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * GET /api/performance/percentiles
 *
 * Get percentile breakdown for endpoint
 *
 * Query params:
 * - endpoint: Endpoint path (optional, default: system-wide)
 * - hours: Lookback period (default: 24)
 *
 * @returns {Object} Percentile breakdown with histogram data
 */
router.get('/percentiles', async (req, res) => {
  try {
    const endpoint = req.query.endpoint;
    const hours = parseInt(req.query.hours, 10) || 24;

    logger.info('Fetching percentile breakdown', { endpoint, hours });

    const trends = await PerformanceSnapshot.getLatencyTrend(hours, endpoint);

    // Extract all latency values for percentile calculation
    const latencies = trends
      .map(t => [t.p50, t.p95, t.p99])
      .flat()
      .filter(v => v > 0);

    const percentiles = PerformanceSnapshot.calculatePercentiles(latencies);

    // Build histogram buckets
    const histogram = buildHistogram(latencies);

    res.json({
      status: 'success',
      data: {
        percentiles,
        histogram,
        sample_size: latencies.length,
        endpoint: endpoint || 'all',
        hours
      }
    });
  } catch (err) {
    logger.error('Percentiles fetch failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * GET /api/performance/endpoints
 *
 * List known endpoint paths observed in performance snapshots.
 *
 * Query params:
 * - hours: Lookback window (default: 24)
 *
 * @returns {Array<String>} Endpoint paths
 */
router.get('/endpoints', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours, 10) || 24;
    const startDate = new Date(Date.now() - hours * 60 * 60 * 1000);

    logger.info('Fetching known endpoints', { hours });

    const endpoints = await PerformanceSnapshot.aggregate([
      {
        $match: {
          hour: { $gte: startDate }
        }
      },
      { $unwind: '$by_endpoint' },
      {
        $group: {
          _id: '$by_endpoint.path'
        }
      },
      { $sort: { _id: 1 } }
    ]);

    const paths = [...new Set(endpoints
      .map(e => e._id)
      .filter(p => typeof p === 'string' && p.length > 0)
      .map(normalizeObservedPath))]
      .sort();

    res.json({
      status: 'success',
      data: paths,
      count: paths.length,
      hours
    });
  } catch (err) {
    logger.error('Endpoints fetch failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

module.exports = router;
