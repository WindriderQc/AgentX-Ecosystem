/**
 * Data Toolbox operating-state strip.
 *
 * DataCommons prepends /api/data and Core's data proxy prepends upstream
 * /api/v1. Paths in this module therefore start at the Data API resource and
 * must never include another /v1 segment.
 */
(function (root, factory) {
  const page = factory();
  if (typeof module === 'object' && module.exports) module.exports = page;
  if (root && root.document) {
    root.DataToolboxOps = page;
    const commons = typeof DataCommons !== 'undefined' ? DataCommons : null;
    if (commons?.apiFetch) page.init({ documentRef: root.document, commons, timers: root });
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const ENDPOINTS = Object.freeze({
    service: '/system/resources',
    storage: '/storage/summary',
    network: '/network/devices',
    feeds: '/livedata/feeds'
  });

  const FAILURES = Object.freeze({
    service: Object.freeze({ state: 'error', value: 'Offline', detail: 'agentx-data is not reachable' }),
    storage: Object.freeze({ state: 'warning', value: 'Unavailable', detail: 'Storage summary not available' }),
    network: Object.freeze({ state: 'warning', value: 'Unavailable', detail: 'Network discovery not available' }),
    feeds: Object.freeze({ state: 'warning', value: 'Unavailable', detail: 'Live data not available' })
  });

  // Unwrap the Data service response envelope ({ ok, data, ... } or raw).
  function unwrap(response) {
    if (response == null || Array.isArray(response)) return response;
    return response.data !== undefined ? response.data : response;
  }

  function servicePresentation(response) {
    const ok = !!(
      response
      && (
        response.ok === true
        || response.status === 'ok'
        || response.status === 'success'
        || response.service
      )
    );
    const version = response?.version || response?.data?.version || null;
    return {
      state: ok ? 'ok' : 'warning',
      value: ok ? 'Online' : 'Degraded',
      detail: version ? `agentx-data v${version}` : 'agentx-data'
    };
  }

  function scanTimestamp(summary) {
    const scan = summary.lastScan ?? summary.last_scan ?? null;
    if (scan && typeof scan === 'object') {
      return scan.finished_at ?? scan.finishedAt ?? scan.started_at ?? scan.startedAt ?? null;
    }
    return summary.lastScanAt
      ?? summary.last_scan_at
      ?? scan
      ?? summary.updatedAt
      ?? summary.updated_at
      ?? null;
  }

  function storagePresentation(response, { formatBytes, timeAgo }) {
    const summary = unwrap(response) || {};
    const files = summary.totalFiles ?? summary.total_files ?? summary.files ?? null;
    const size = summary.totalSize ?? summary.total_size ?? summary.bytes ?? null;
    const last = scanTimestamp(summary);
    if (files == null && size == null) {
      return { state: 'warning', value: 'No scans yet', detail: 'Run a storage scan to populate' };
    }
    const headline = files != null ? `${Number(files).toLocaleString()} files` : formatBytes(size);
    const details = [];
    if (size != null && files != null) details.push(formatBytes(size));
    if (last) details.push(timeAgo(last));
    return { state: 'ok', value: headline, detail: details.join(' - ') || 'Indexed file metadata' };
  }

  function networkPresentation(response) {
    const value = unwrap(response);
    const devices = Array.isArray(value) ? value : (Array.isArray(value?.devices) ? value.devices : []);
    const count = devices.length;
    return {
      state: count > 0 ? 'ok' : 'warning',
      value: count > 0 ? `${count} device${count === 1 ? '' : 's'}` : 'No devices',
      detail: count > 0 ? 'Discovered on the LAN' : 'Run a network scan to discover hosts'
    };
  }

  function feedsPresentation(response) {
    const value = unwrap(response);
    const feeds = Array.isArray(value) ? value : (Array.isArray(value?.feeds) ? value.feeds : []);
    const total = feeds.length;
    if (!total) return { state: 'warning', value: 'No feeds', detail: 'No live-data feeds configured' };
    const active = feeds.filter(feed => (
      feed && (feed.enabled || feed.active || feed.status === 'active' || feed.running)
    )).length;
    return {
      state: 'ok',
      value: `${active || total} active`,
      detail: `${total} feed${total === 1 ? '' : 's'} configured`
    };
  }

  function createLoaders({ apiFetch, setTile, formatBytes, timeAgo }) {
    async function load({ endpoint, tile, present, failure }) {
      try {
        const response = await apiFetch(endpoint);
        setTile(tile, present(response));
      } catch (_) {
        setTile(tile, failure);
      }
    }

    const loaders = {
      loadService: () => load({
        endpoint: ENDPOINTS.service,
        tile: 'dops-service',
        present: servicePresentation,
        failure: FAILURES.service
      }),
      loadStorage: () => load({
        endpoint: ENDPOINTS.storage,
        tile: 'dops-storage',
        present: response => storagePresentation(response, { formatBytes, timeAgo }),
        failure: FAILURES.storage
      }),
      loadNetwork: () => load({
        endpoint: ENDPOINTS.network,
        tile: 'dops-network',
        present: networkPresentation,
        failure: FAILURES.network
      }),
      loadFeeds: () => load({
        endpoint: ENDPOINTS.feeds,
        tile: 'dops-feeds',
        present: feedsPresentation,
        failure: FAILURES.feeds
      })
    };
    loaders.refresh = () => Promise.allSettled([
      loaders.loadService(),
      loaders.loadStorage(),
      loaders.loadNetwork(),
      loaders.loadFeeds()
    ]);
    return loaders;
  }

  function init({ documentRef, commons, timers }) {
    function setTile(id, presentation) {
      const element = documentRef.getElementById(id);
      if (!element) return;
      element.classList.remove('is-loading', 'is-ok', 'is-warning', 'is-error');
      element.classList.add(`is-${presentation.state}`);
      const value = element.querySelector('.data-ops-value');
      const detail = element.querySelector('.data-ops-detail');
      if (value) value.textContent = presentation.value;
      if (detail) detail.textContent = presentation.detail;
    }

    const loaders = createLoaders({
      apiFetch: commons.apiFetch,
      setTile,
      formatBytes: commons.formatBytes,
      timeAgo: commons.timeAgo
    });
    const refresh = () => loaders.refresh();
    if (documentRef.readyState === 'loading') {
      documentRef.addEventListener('DOMContentLoaded', refresh);
    } else {
      refresh();
    }

    // Light auto-refresh; pause while hidden to avoid idle churn.
    let timer = timers.setInterval(refresh, 30000);
    documentRef.addEventListener('visibilitychange', () => {
      if (documentRef.hidden) {
        timers.clearInterval(timer);
        timer = null;
      } else if (!timer) {
        refresh();
        timer = timers.setInterval(refresh, 30000);
      }
    });
    return { refresh, loaders };
  }

  return {
    ENDPOINTS,
    FAILURES,
    unwrap,
    servicePresentation,
    scanTimestamp,
    storagePresentation,
    networkPresentation,
    feedsPresentation,
    createLoaders,
    init
  };
});
