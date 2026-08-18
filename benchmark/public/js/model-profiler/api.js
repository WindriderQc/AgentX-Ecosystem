/**
 * Profiler API — all fetch calls for the Model Profiler UI
 */

import { apiFetch as _rawFetch } from '../utils/api.js';

const BASE = '/api/profiler';

/** Unwrap { status, data } envelope if present */
const fetchJson = async (...args) => {
  const res = await _rawFetch(...args);
  return res?.data !== undefined ? res.data : res;
};

// Dashboard
export const getDashboard = () => fetchJson(`${BASE}/dashboard`);

// Hosts
export const getHosts = () => fetchJson(`${BASE}/hosts`);
export const discoverHosts = () => fetchJson(`${BASE}/hosts/discover`, { method: 'POST' });
export const getHost = (hostId) => fetchJson(`${BASE}/hosts/${hostId}`);
export const getHostStatus = (hostId) => fetchJson(`${BASE}/hosts/${hostId}/status`);
export const upsertHost = (hostId, data) => fetchJson(`${BASE}/hosts/${hostId}`, { method: 'PUT', body: data });
export const syncHostModels = (hostId) => fetchJson(`${BASE}/hosts/${hostId}/sync`, { method: 'POST' });
export const getHostFitReport = (hostId) => fetchJson(`${BASE}/hosts/${encodeURIComponent(hostId)}/fit-report`);
export const releaseHostModel = (hostId) => fetchJson(`${BASE}/hosts/${hostId}/release`, { method: 'POST' });
// Host testing (under /api/profiler/hosts/test)
export const getHostTestConfig = () => fetchJson(`${BASE}/hosts/test/config`);
export const saveHostTestConfig = (data) => fetchJson(`${BASE}/hosts/test/config`, { method: 'PUT', body: data });
export const ensureHostBaseline = (hostId) => fetchJson(`${BASE}/hosts/test/ensure-baseline`, {
  method: 'POST',
  body: { hostId }
});
export const runSingleHostTest = (modelName, hostId) => fetchJson(`${BASE}/hosts/test/run`, {
  method: 'POST',
  body: { modelName, hostId }
});
export const startHostTest = (hostId) => fetchJson(`${BASE}/hosts/test/run-all`, {
  method: 'POST',
  body: { hostId }
});
export const getHostTestProgress = (testId) => fetchJson(`${BASE}/hosts/test/run-all/${encodeURIComponent(testId)}/progress`);
export const startFleetTest = ({ hostIds, includeOffline } = {}) => fetchJson(`${BASE}/hosts/test/run-fleet`, {
  method: 'POST',
  body: { hostIds, includeOffline: !!includeOffline }
});
export const getFleetTestProgress = (queueId) => fetchJson(`${BASE}/hosts/test/run-fleet/${encodeURIComponent(queueId)}/progress`);
export const cancelFleetTest = (queueId) => fetchJson(`${BASE}/hosts/test/run-fleet/${encodeURIComponent(queueId)}/cancel`, { method: 'POST' });
export const getActiveFleetQueues = () => fetchJson(`${BASE}/hosts/test/run-fleet/active`);
export const getHostsStatus = () => fetchJson(`${BASE}/hosts/test/hosts-status`);
export const detectOllamaHost = (data) => fetchJson(`${BASE}/hosts/test/detect-host`, { method: 'POST', body: data });
export const getLiveProbeStatus = (hostId) => fetchJson(
  hostId
    ? `${BASE}/hosts/test/live-probes/${encodeURIComponent(hostId)}/status`
    : `${BASE}/hosts/test/live-probes/status`
);
export const runContextProbe = (modelName, hostUrl, options = {}) => fetchJson(`${BASE}/hosts/test/context-probe/run`, {
  method: 'POST',
  body: { modelName, hostUrl, ...options, acknowledgeMaintenance: options.acknowledgeMaintenance === true }
});

// Models
export const getModels = (stage) => fetchJson(`${BASE}/models${stage ? `?stage=${stage}` : ''}`);
export const getModel = (name) => fetchJson(`${BASE}/models/${encodeURIComponent(name)}`);
export const getModelConfig = (name, hostId) => fetchJson(`${BASE}/models/${encodeURIComponent(name)}/config?host=${hostId}`);
export const upsertModel = (name, data) => fetchJson(`${BASE}/models/${encodeURIComponent(name)}`, { method: 'PUT', body: data });

// Exact-artifact performance evidence
export const getProfileEvidenceRoster = (filter = {}) => {
  const params = new URLSearchParams(filter);
  return fetchJson(`${BASE}/evidence/roster?${params}`);
};
export const getProfileEvidence = (modelName, hostId) => fetchJson(`${BASE}/evidence/${encodeURIComponent(modelName)}/${hostId}`);

// Pipeline
export const profileModel = (modelName, hostId, depth) => fetchJson(`${BASE}/pipeline/profile`, { method: 'POST', body: { modelName, hostId, depth } });
export const getProfileProgress = (profileId) => fetchJson(`${BASE}/pipeline/profile/${encodeURIComponent(profileId)}/progress`);
export const getActiveProfiles = () => fetchJson(`${BASE}/pipeline/profile/active`);
export const runFullPipeline = (modelName) => fetchJson(`${BASE}/pipeline/full`, { method: 'POST', body: { modelName } });
export const startHostProfileQueue = ({ hostId, depth, skipRecentDays, modelNames } = {}) =>
  fetchJson(`${BASE}/pipeline/profile-host`, { method: 'POST', body: { hostId, depth, skipRecentDays, modelNames } });
export const getHostProfileQueueProgress = (queueId) =>
  fetchJson(`${BASE}/pipeline/profile-host/${encodeURIComponent(queueId)}/progress`);
export const cancelHostProfileQueue = (queueId) =>
  fetchJson(`${BASE}/pipeline/profile-host/${encodeURIComponent(queueId)}/cancel`, { method: 'POST' });
export const getActiveHostProfileQueues = () =>
  fetchJson(`${BASE}/pipeline/profile-host/active`);
export const runPreflight = (config) => fetchJson(`${BASE}/pipeline/preflight`, { method: 'POST', body: config });

// Settings
export const getSettings = () => fetchJson(`${BASE}/settings`);
export const saveSettings = (data) => fetchJson(`${BASE}/settings`, { method: 'PUT', body: data });
