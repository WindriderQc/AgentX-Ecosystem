/**
 * Shared data-page utilities — imported by all Data Toolbox tabs.
 * Eliminates per-page reimplementation of common helpers.
 */
const DataCommons = (() => {
  const DATA_PREFIX = '/api/data';

  /**
   * Fetch JSON from the data service API.
   * Prepends /api/data if path doesn't already include it.
   */
  async function apiFetch(path, opts = {}) {
    const url = path.startsWith('/api/data') ? path : `${DATA_PREFIX}${path}`;
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      ...opts
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`${res.status}: ${text}`);
    }
    return res.json();
  }

  /**
   * Format byte count to human-readable string.
   */
  function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes) || bytes < 0) return '--';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }

  /**
   * Relative time string (e.g. '5m ago', '2h ago').
   */
  function timeAgo(dateStr) {
    if (!dateStr) return '--';
    const diff = Date.now() - new Date(dateStr).getTime();
    if (diff < 0) return 'just now';
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  }

  return { apiFetch, formatBytes, timeAgo };
})();
