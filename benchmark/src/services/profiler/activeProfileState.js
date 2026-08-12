'use strict';

const activeProfiles = new Map();
const activeProfileQueues = new Map();

const PROFILE_TTL_MS = 90 * 60 * 1000; // 90 min: full profiles can exceed 45 min on cold hosts
const PROFILE_QUEUE_TTL_MS = 24 * 60 * 60 * 1000; // 24h: a full host sweep can run many hours

function normalizeHostUrl(hostUrl) {
  return String(hostUrl || '').trim().replace(/\/+$/, '').toLowerCase();
}

function cleanupStaleProfiles(now = Date.now()) {
  for (const [id, job] of activeProfiles) {
    if (now - Number(job.startedAt || 0) > PROFILE_TTL_MS) activeProfiles.delete(id);
  }
}

function cleanupStaleProfileQueues(now = Date.now()) {
  for (const [id, q] of activeProfileQueues) {
    if (now - Number(q.startedAt || 0) > PROFILE_QUEUE_TTL_MS) activeProfileQueues.delete(id);
  }
}

function serializeActiveProfile(id, job, now = Date.now()) {
  return {
    type: 'profile',
    profileId: id,
    modelName: job.modelName,
    hostId: job.hostId,
    hostUrl: job.hostUrl || null,
    depth: job.depth,
    currentStep: job.currentStep,
    stepsCompleted: job.stepsCompleted,
    stepsTotal: job.stepsTotal,
    startedAt: job.startedAt,
    elapsed: now - Number(job.startedAt || now)
  };
}

function serializeActiveQueue(id, q, now = Date.now()) {
  return {
    type: 'profile-host',
    queueId: id,
    hostId: q.hostId,
    hostUrl: q.hostUrl || null,
    hostName: q.hostName || null,
    depth: q.depth,
    currentIndex: q.currentIndex,
    total: q.total,
    startedAt: q.startedAt,
    elapsed: now - Number(q.startedAt || now),
    currentModel: q.models?.[q.currentIndex]?.name || null
  };
}

function listActiveProfiles() {
  cleanupStaleProfiles();
  const now = Date.now();
  const active = [];
  for (const [id, job] of activeProfiles) {
    if (job.status === 'running') active.push(serializeActiveProfile(id, job, now));
  }
  return active;
}

function listActiveProfileQueues() {
  cleanupStaleProfileQueues();
  const now = Date.now();
  const active = [];
  for (const [id, q] of activeProfileQueues) {
    if (q.status === 'running') active.push(serializeActiveQueue(id, q, now));
  }
  return active;
}

function hostMatches(record, { hostId, hostUrl }) {
  const wantedId = hostId ? String(hostId) : '';
  const wantedUrl = normalizeHostUrl(hostUrl);
  const recordId = record.hostId ? String(record.hostId) : '';
  const recordUrl = normalizeHostUrl(record.hostUrl);
  return !!(
    (wantedId && recordId && wantedId === recordId) ||
    (wantedUrl && recordUrl && wantedUrl === recordUrl)
  );
}

function findActiveProfilingForHost({ hostId, hostUrl } = {}) {
  const matches = [];
  for (const profile of listActiveProfiles()) {
    if (hostMatches(profile, { hostId, hostUrl })) matches.push(profile);
  }
  for (const queue of listActiveProfileQueues()) {
    if (hostMatches(queue, { hostId, hostUrl })) matches.push(queue);
  }
  return matches;
}

function clearActiveProfilingState() {
  activeProfiles.clear();
  activeProfileQueues.clear();
}

module.exports = {
  activeProfiles,
  activeProfileQueues,
  cleanupStaleProfiles,
  cleanupStaleProfileQueues,
  listActiveProfiles,
  listActiveProfileQueues,
  findActiveProfilingForHost,
  clearActiveProfilingState,
  normalizeHostUrl
};
