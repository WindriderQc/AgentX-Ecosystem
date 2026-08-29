'use strict';

// These are the exact strings produced by JavaScript interpolation of missing
// values. Keep the match case-sensitive so a semantic path segment is not
// reclassified merely because it resembles a placeholder.
const PLACEHOLDER_SEGMENT = /^(?:undefined|null|NaN)$/;

/**
 * Bound endpoint cardinality and prevent nullish client interpolation from
 * becoming a product-facing pseudo-ID. The invalid traffic stays visible as a
 * canonical aggregate so it can still be diagnosed.
 */
function normalizeObservedPath(pathname) {
  const path = typeof pathname === 'string' && pathname.length > 0 ? pathname : '/';
  return path
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      if (PLACEHOLDER_SEGMENT.test(segment)) return ':invalid-id';
      if (/^[0-9a-f]{24}$/i.test(segment)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ':id';
      if (/^\d+$/.test(segment)) return ':id';
      return segment;
    })
    .join('/');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve a canonical dashboard selection back to both new canonical rows and
 * legacy placeholder spellings. This keeps the `:invalid-id` aggregate
 * inspectable instead of offering a filter that returns an empty chart.
 */
function observedPathMatcher(pathname) {
  const normalized = normalizeObservedPath(pathname);
  if (!normalized.includes(':invalid-id')) return normalized;

  const pattern = escapeRegex(normalized)
    .replace(/:invalid-id/g, '(?:undefined|null|NaN|:invalid-id)');
  return new RegExp(`^${pattern}$`);
}

function coalesceEndpointRows(rows = []) {
  const grouped = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row?.path !== 'string' || row.path.length === 0) continue;
    const path = normalizeObservedPath(row.path);
    const method = typeof row.method === 'string' ? row.method : null;
    const key = `${method || ''}:${path}`;
    const count = Number(row.count) || 0;
    const errorCount = Number(row.error_count) || 0;
    const latency = Number(row.avg_latency) || 0;
    const current = grouped.get(key) || {
      path,
      method,
      count: 0,
      error_count: 0,
      latency_weighted_sum: 0
    };
    current.count += count;
    current.error_count += errorCount;
    current.latency_weighted_sum += latency * count;
    grouped.set(key, current);
  }

  return [...grouped.values()].map((row) => ({
    path: row.path,
    method: row.method,
    count: row.count,
    error_count: row.error_count,
    error_rate: row.count > 0
      ? Number(((row.error_count / row.count) * 100).toFixed(2))
      : 0,
    avg_latency: row.count > 0
      ? Math.round(row.latency_weighted_sum / row.count)
      : 0
  }));
}

module.exports = {
  PLACEHOLDER_SEGMENT,
  normalizeObservedPath,
  observedPathMatcher,
  coalesceEndpointRows
};
