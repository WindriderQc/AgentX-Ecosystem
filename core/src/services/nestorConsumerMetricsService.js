'use strict';

const InferenceLog = require('../../models/InferenceLog');
const { LIMITS, OPERATION_TASK_TYPES, NestorConsumerError } = require('./nestorConsumerContract');

const TASK_OPERATIONS = Object.freeze(
  Object.fromEntries(Object.entries(OPERATION_TASK_TYPES).map(([operation, taskType]) => [taskType, operation]))
);

function boundedHours(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 24;
  return Math.max(1, Math.min(Math.trunc(parsed), LIMITS.metricsHours));
}

function increment(map, key) {
  const normalized = String(key || 'unknown');
  map[normalized] = (map[normalized] || 0) + 1;
}

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

async function getNestorMetrics({ hours, taskType } = {}) {
  const windowHours = boundedHours(hours);
  const normalizedTaskType = String(taskType || '').trim();
  if (normalizedTaskType && !Object.values(OPERATION_TASK_TYPES).includes(normalizedTaskType)) {
    throw new NestorConsumerError(
      `Unknown Nestor task type: ${normalizedTaskType}`,
      400,
      'UNKNOWN_NESTOR_TASK_TYPE'
    );
  }
  const match = {
    timestamp: { $gte: new Date(Date.now() - windowHours * 3600000) },
    consumerContract: 'nestor-v1',
    callerDetail: /^nestor\//,
  };
  if (normalizedTaskType) match.taskType = normalizedTaskType;

  const rows = await InferenceLog.aggregate([
    { $match: match },
    { $sort: { timestamp: -1 } },
    { $limit: LIMITS.metricsRows },
    { $project: {
      _id: 0,
      status: 1,
      tokensIn: 1,
      tokensOut: 1,
      durationMs: 1,
      model: 1,
      host: 1,
      routedHost: 1,
      taskType: 1,
      fallbackUsed: 1,
      fallbackReason: 1,
      routingSource: '$routingTrace.selected.routingSource',
    } },
  ]);

  const latency = [];
  const modelDistribution = {};
  const hostDistribution = {};
  const taskDistribution = {};
  const operationDistribution = {};
  const routingSourceCounts = {};
  let successes = 0;
  let errors = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let fallbackCount = 0;

  for (const row of rows) {
    if (row.status === 'success') successes += 1;
    else errors += 1;
    tokensIn += Number(row.tokensIn) || 0;
    tokensOut += Number(row.tokensOut) || 0;
    const duration = Number(row.durationMs);
    if (Number.isFinite(duration) && duration >= 0) latency.push(duration);
    increment(modelDistribution, row.model);
    increment(hostDistribution, row.routedHost || row.host);
    increment(taskDistribution, row.taskType);
    increment(operationDistribution, TASK_OPERATIONS[row.taskType] || 'other');
    increment(routingSourceCounts, row.routingSource);
    if (row.fallbackUsed || row.fallbackReason) fallbackCount += 1;
  }

  latency.sort((left, right) => left - right);
  const calls = rows.length;
  return {
    window: {
      hours: windowHours,
      since: match.timestamp.$gte.toISOString(),
      rowLimit: LIMITS.metricsRows,
      truncated: rows.length === LIMITS.metricsRows,
    },
    filter: {
      consumerContract: 'nestor-v1',
      callerDetailPrefix: 'nestor/',
      taskType: match.taskType || null,
    },
    calls,
    successes,
    errors,
    errorRate: calls ? Number(((errors / calls) * 100).toFixed(2)) : 0,
    tokens: { in: tokensIn, out: tokensOut, total: tokensIn + tokensOut },
    latencyMs: {
      average: latency.length
        ? Math.round(latency.reduce((sum, value) => sum + value, 0) / latency.length)
        : 0,
      p50: percentile(latency, 0.5),
      p95: percentile(latency, 0.95),
    },
    distributions: {
      models: modelDistribution,
      hosts: hostDistribution,
      tasks: taskDistribution,
      operations: operationDistribution,
      routingSources: routingSourceCounts,
    },
    fallbacks: fallbackCount,
  };
}

module.exports = { getNestorMetrics, boundedHours, percentile };
