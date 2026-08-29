/**
 * Pure evidence projections for Cluster Schedule headline state.
 *
 * Host reachability and model-inventory counts must come from the same
 * ecosystem snapshot used by other canonical product surfaces. The separate
 * Cluster Schedule live poll may enrich cards with loaded-model/VRAM details,
 * but it is never allowed to determine these headline counts.
 */
(function initClusterScheduleHeadline(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.ClusterScheduleHeadline = api;
}(typeof window !== 'undefined' ? window : globalThis, () => {
  const SNAPSHOT_SCHEMA_VERSION = 2;
  const SNAPSHOT_AUTHORITY = 'agentx-product';

  function required(condition, message) {
    if (!condition) throw new Error(message);
  }

  function nonNegativeInteger(value, label) {
    required(Number.isInteger(value) && value >= 0, `${label} must be a non-negative integer`);
    return value;
  }

  function observedAt(snapshot) {
    const value = snapshot?.evidence?.snapshotObservedAt || snapshot?.generatedAt;
    required(typeof value === 'string' && !Number.isNaN(Date.parse(value)), 'ecosystem observation time is invalid');
    return new Date(value).toISOString();
  }

  function projectEcosystemHeadline(snapshot) {
    required(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot), 'ecosystem snapshot is unavailable');
    required(snapshot.schemaVersion === SNAPSHOT_SCHEMA_VERSION, 'ecosystem snapshot schema is unsupported');
    required(snapshot.authority === SNAPSHOT_AUTHORITY, 'ecosystem snapshot authority is invalid');
    required(snapshot.readOnly === true, 'ecosystem snapshot is not marked read-only');

    const health = snapshot.health;
    required(health && typeof health === 'object' && !Array.isArray(health), 'ecosystem cluster health is unavailable');
    const configuredHosts = nonNegativeInteger(health.configuredHosts, 'configured host count');
    const onlineHosts = nonNegativeInteger(health.onlineHosts, 'online host count');
    const offlineHosts = nonNegativeInteger(health.offlineHosts, 'offline host count');
    const observedModels = nonNegativeInteger(health.observedModels, 'observed model count');
    required(onlineHosts + offlineHosts === configuredHosts, 'ecosystem host counts are inconsistent');

    return Object.freeze({
      authority: SNAPSHOT_AUTHORITY,
      scope: 'ecosystem-host-and-model-inventory',
      observedAt: observedAt(snapshot),
      status: health.status === 'ok' ? 'ok' : 'degraded',
      configuredHosts,
      onlineHosts,
      offlineHosts,
      observedModels
    });
  }

  function projectLiveDetailEvidence(liveData) {
    const evidence = liveData?.evidence;
    required(evidence && typeof evidence === 'object' && !Array.isArray(evidence), 'live-detail evidence contract is unavailable');
    required(evidence.authority === 'agentx.cluster-schedule-live-detail', 'live-detail authority is invalid');
    required(evidence.scope === 'loaded-model-and-vram-detail', 'live-detail scope is invalid');
    required(evidence.headlineAuthority === false, 'live-detail evidence cannot own headline counts');
    const value = evidence.observedAt;
    required(typeof value === 'string' && !Number.isNaN(Date.parse(value)), 'live-detail observation time is invalid');
    return Object.freeze({
      authority: evidence.authority,
      scope: evidence.scope,
      observedAt: new Date(value).toISOString(),
      headlineAuthority: false
    });
  }

  return Object.freeze({
    projectEcosystemHeadline,
    projectLiveDetailEvidence
  });
}));
