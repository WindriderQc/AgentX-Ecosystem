'use strict';

const ops = require('../../public/js/data-toolbox-ops.js');

const formatBytes = value => `${value} bytes`;
const timeAgo = value => `ago:${value}`;

describe('Data Toolbox canonical operating-state probes', () => {
  it('uses Core data-proxy resource paths exactly once', () => {
    expect(ops.ENDPOINTS).toEqual({
      service: '/system/resources',
      storage: '/storage/summary',
      network: '/network/devices',
      feeds: '/livedata/feeds',
    });
    Object.values(ops.ENDPOINTS).forEach((endpoint) => {
      expect(endpoint).not.toContain('/v1/');
      expect(endpoint).not.toBe('/health');
    });
  });

  it('normalizes current production response envelopes into honest tile values', () => {
    expect(ops.servicePresentation({ ok: true, status: 'success', data: { process: {} } })).toEqual({
      state: 'ok',
      value: 'Online',
      detail: 'agentx-data',
    });
    expect(ops.storagePresentation({
      data: {
        totalFiles: 268567,
        totalSize: 2517160287176,
        lastScan: {
          started_at: 'scan-start',
          finished_at: 'scan-finish',
        },
      },
    }, { formatBytes, timeAgo })).toEqual({
      state: 'ok',
      value: `${Number(268567).toLocaleString()} files`,
      detail: '2517160287176 bytes - ago:scan-finish',
    });
    expect(ops.networkPresentation({ data: { devices: [{}, {}] } })).toEqual({
      state: 'ok',
      value: '2 devices',
      detail: 'Discovered on the LAN',
    });
    expect(ops.feedsPresentation({ data: [
      { enabled: true },
      { enabled: false },
    ] })).toEqual({
      state: 'ok',
      value: '1 active',
      detail: '2 feeds configured',
    });
  });

  it('normalizes scalar and nested scan timestamps before relative-time formatting', () => {
    expect(ops.scanTimestamp({ lastScanAt: 'direct-time' })).toBe('direct-time');
    expect(ops.scanTimestamp({ last_scan: { started_at: 'scan-start' } })).toBe('scan-start');
    expect(ops.scanTimestamp({ lastScan: { startedAt: 'start', finishedAt: 'finish' } })).toBe('finish');
    expect(ops.scanTimestamp({ lastScan: {} })).toBeNull();
  });

  it('keeps empty collections as warnings rather than false service failures', () => {
    expect(ops.networkPresentation({ data: { devices: [] } })).toMatchObject({
      state: 'warning',
      value: 'No devices',
    });
    expect(ops.feedsPresentation({ data: [] })).toEqual({
      state: 'warning',
      value: 'No feeds',
      detail: 'No live-data feeds configured',
    });
  });

  it('isolates a failed service probe from successful storage, network, and feed tiles', async () => {
    const responses = new Map([
      [ops.ENDPOINTS.storage, { data: { totalFiles: 10, totalSize: 20 } }],
      [ops.ENDPOINTS.network, { data: { devices: [{}] } }],
      [ops.ENDPOINTS.feeds, { data: [{ enabled: true }] }],
    ]);
    const seen = [];
    const setTile = jest.fn((tile, presentation) => seen.push({ tile, presentation }));
    const apiFetch = jest.fn(async (endpoint) => {
      if (endpoint === ops.ENDPOINTS.service) throw new Error('probe failed');
      return responses.get(endpoint);
    });
    const loaders = ops.createLoaders({ apiFetch, setTile, formatBytes, timeAgo });

    await loaders.refresh();

    expect(apiFetch.mock.calls.map(([endpoint]) => endpoint)).toEqual(Object.values(ops.ENDPOINTS));
    expect(seen).toEqual(expect.arrayContaining([
      { tile: 'dops-service', presentation: ops.FAILURES.service },
      { tile: 'dops-storage', presentation: expect.objectContaining({ state: 'ok', value: '10 files' }) },
      { tile: 'dops-network', presentation: expect.objectContaining({ state: 'ok', value: '1 device' }) },
      { tile: 'dops-feeds', presentation: expect.objectContaining({ state: 'ok', value: '1 active' }) },
    ]));
  });
});
