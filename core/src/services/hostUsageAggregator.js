/**
 * Host Usage Aggregator
 *
 * Reads InferenceLog records and writes/updates HostUsageLedger hourly buckets.
 * Designed to be called by:
 *   - SpecialX task type 'telemetry_aggregate'
 *   - A self-healing rule on an hourly schedule
 *
 * Processes only hours that have not yet been aggregated (or were partially aggregated).
 * Safe to run multiple times — upserts replace previous values.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const logger = require('../../config/logger');
const InferenceLog = require('../../models/InferenceLog');
const HostUsageLedger = require('../../models/HostUsageLedger');
const { getConfiguredHosts, hostUrlKey } = require('../helpers/ollamaHostConfig');
const { describeHost } = require('./hostIdentityService');

const WALL_CLOCK_HOUR_MS = 3600 * 1000;
const DEFAULT_PLATFORM_MAP_PATH = path.resolve(__dirname, '..', '..', '..', 'config', 'platform-map.yml');
const COMPOSE_WORKSPACE_PLATFORM_MAP_PATH = '/workspace/agentx/config/platform-map.yml';
let cachedHostLabelLookup = null;

function normalizeLookupKey(value) {
  return String(value || '').trim().toLowerCase();
}

function getRegistryLabel(hostId, hostConfig) {
  return hostConfig.display_name || hostConfig.os_hostname || hostId;
}

function buildHostLabelLookup(platformMap) {
  const lookup = new Map();
  const hosts = platformMap && platformMap.hosts && typeof platformMap.hosts === 'object'
    ? platformMap.hosts
    : {};

  for (const [hostId, hostConfigRaw] of Object.entries(hosts)) {
    const hostConfig = hostConfigRaw || {};
    const label = getRegistryLabel(hostId, hostConfig);
    const aliases = Array.isArray(hostConfig.aliases) ? hostConfig.aliases : [];
    const keys = [
      hostId,
      hostConfig.address,
      hostConfig.os_hostname,
      ...aliases
    ];

    for (const key of keys) {
      const normalized = normalizeLookupKey(key);
      if (normalized) lookup.set(normalized, label);
    }
  }

  return lookup;
}

function loadHostLabelLookup() {
  if (cachedHostLabelLookup) return cachedHostLabelLookup;

  const platformMapPaths = process.env.AGENTX_PLATFORM_MAP_PATH
    ? [process.env.AGENTX_PLATFORM_MAP_PATH]
    : [DEFAULT_PLATFORM_MAP_PATH, COMPOSE_WORKSPACE_PLATFORM_MAP_PATH];
  const errors = [];

  for (const platformMapPath of platformMapPaths) {
    try {
      const parsed = yaml.load(fs.readFileSync(platformMapPath, 'utf8')) || {};
      cachedHostLabelLookup = buildHostLabelLookup(parsed);
      return cachedHostLabelLookup;
    } catch (err) {
      errors.push({ path: platformMapPath, error: err.message });
    }
  }

  logger.warn('[HostUsageAggregator] Failed to load platform host registry', { attempts: errors });
  cachedHostLabelLookup = new Map();
  return cachedHostLabelLookup;
}

function extractHostName(hostUrl) {
  try {
    return new URL(hostUrl).hostname;
  } catch {
    return hostUrl;
  }
}

function hostLabel(hostUrl) {
  if (!hostUrl) return 'unknown';

  const lookup = loadHostLabelLookup();
  const hostname = extractHostName(hostUrl);
  const label = lookup.get(normalizeLookupKey(hostUrl))
    || lookup.get(normalizeLookupKey(hostname));

  return label || hostname || hostUrl;
}

/**
 * Truncate a Date to the top of its UTC hour.
 */
function truncateToHour(date) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/**
 * Aggregate all un-aggregated hours up to (but not including) the current hour.
 * @returns {Promise<{hoursProcessed: number, recordsWritten: number}>}
 */
async function aggregateHour() {
  const now = new Date();
  const currentHour = truncateToHour(now);

  // Find earliest un-aggregated InferenceLog
  const earliest = await InferenceLog.findOne({}).sort({ timestamp: 1 }).select('timestamp').lean();
  if (!earliest) {
    logger.info('[HostUsageAggregator] No inference logs to aggregate');
    return { hoursProcessed: 0, recordsWritten: 0 };
  }

  // Find which hours already have a recent aggregation (within the last 2h)
  const startHour = truncateToHour(earliest.timestamp);
  const hours = [];
  let cursor = new Date(startHour);
  while (cursor < currentHour) {
    hours.push(new Date(cursor));
    cursor = new Date(cursor.getTime() + WALL_CLOCK_HOUR_MS);
  }

  if (!hours.length) {
    return { hoursProcessed: 0, recordsWritten: 0 };
  }

  logger.info('[HostUsageAggregator] Aggregating hours', { count: hours.length });

  let recordsWritten = 0;

  for (const hour of hours) {
    const nextHour = new Date(hour.getTime() + WALL_CLOCK_HOUR_MS);

    const agg = await InferenceLog.aggregate([
      { $match: { timestamp: { $gte: hour, $lt: nextHour } } },
      {
        $group: {
          _id: { host: '$host', hostKey: '$hostKey' },
          totalCalls: { $sum: 1 },
          successCalls: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
          errorCalls: { $sum: { $cond: [{ $ne: ['$status', 'success'] }, 1, 0] } },
          fallbackCalls: { $sum: { $cond: ['$fallbackUsed', 1, 0] } },
          totalTokensIn: { $sum: '$tokensIn' },
          totalTokensOut: { $sum: '$tokensOut' },
          totalDurationMs: { $sum: '$durationMs' },
          avgDurationMs: { $avg: '$durationMs' },
          maxDurationMs: { $max: '$durationMs' },
          uniqueModels: { $addToSet: '$model' },
          callersList: { $push: '$caller' }
        }
      }
    ]);

    for (const row of agg) {
      const callerBreakdown = {};
      for (const c of (row.callersList || [])) {
        callerBreakdown[c] = (callerBreakdown[c] || 0) + 1;
      }

      const utilizationPct = Math.min(100, Math.round((row.totalDurationMs / WALL_CLOCK_HOUR_MS) * 100));
      const label = hostLabel(row._id.host);

      await HostUsageLedger.findOneAndUpdate(
        { host: row._id.host, hour },
        {
          $set: {
            host: row._id.host,
            hostKey: row._id.hostKey,
            hostLabel: label,
            hour,
            totalCalls: row.totalCalls,
            successCalls: row.successCalls,
            errorCalls: row.errorCalls,
            fallbackCalls: row.fallbackCalls,
            totalTokensIn: row.totalTokensIn,
            totalTokensOut: row.totalTokensOut,
            totalDurationMs: row.totalDurationMs,
            avgDurationMs: Math.round(row.avgDurationMs || 0),
            maxDurationMs: row.maxDurationMs || 0,
            utilizationPct,
            uniqueModels: row.uniqueModels,
            callerBreakdown,
            aggregatedAt: new Date()
          }
        },
        { upsert: true, new: true }
      );
      recordsWritten++;
    }
  }

  logger.info('[HostUsageAggregator] Done', { hoursProcessed: hours.length, recordsWritten });
  return { hoursProcessed: hours.length, recordsWritten };
}

/**
 * Get utilization heatmap data for the past N days.
 * Returns: { hosts: string[], days: string[], grid: { [host]: number[][] } }
 * grid[host] is a days × 24 matrix of utilizationPct values.
 */
async function getUtilizationHeatmap(days = 7) {
  const since = new Date(Date.now() - days * 86400 * 1000);
  const records = await HostUsageLedger.find({ hour: { $gte: since } })
    .sort({ hour: 1 }).lean();

  return buildUtilizationHeatmap(records, days, new Date(), getConfiguredHosts());
}

function buildUtilizationHeatmap(records, days = 7, now = new Date(), configuredHosts = []) {
  const since = new Date(now.getTime() - days * 86400 * 1000);
  const identities = new Map();
  for (const host of configuredHosts) {
    const identity = describeHost(host.url, host.id, configuredHosts);
    identities.set(identity.key, identity);
  }
  for (const record of records || []) {
    const identity = describeHost(record.host, record.hostKey, configuredHosts);
    const key = identity.key || hostUrlKey(record.host) || record.hostLabel || record.host;
    if (!identities.has(key)) identities.set(key, { ...identity, key });
  }

  const dayKeys = [];
  const cursor = truncateToHour(since);
  cursor.setUTCHours(0);
  const end = truncateToHour(now);
  end.setUTCHours(0);
  let d = new Date(cursor);
  while (d <= end) {
    dayKeys.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400 * 1000);
  }

  const grid = {};
  for (const identity of identities.values()) {
    grid[identity.key] = dayKeys.map(() => new Array(24).fill(null));
  }

  for (const r of records || []) {
    const identity = describeHost(r.host, r.hostKey, configuredHosts);
    const key = identity.key || hostUrlKey(r.host) || r.hostLabel || r.host;
    const dayKey = r.hour.toISOString().slice(0, 10);
    const hourIdx = r.hour.getUTCHours();
    const dayIdx = dayKeys.indexOf(dayKey);
    if (dayIdx >= 0 && grid[key]) {
      grid[key][dayIdx][hourIdx] = r.utilizationPct;
    }
  }

  return { hosts: [...identities.values()], days: dayKeys, grid };
}

module.exports = {
  aggregateHour,
  getUtilizationHeatmap,
  buildUtilizationHeatmap,
  truncateToHour,
  hostLabel,
  buildHostLabelLookup
};
