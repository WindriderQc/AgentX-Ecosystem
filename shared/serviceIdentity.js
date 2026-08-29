'use strict';

const { currentAgentXProfile } = require('./agentxRuntimeProfile');

const UNKNOWN_REVISION = 'unknown';
const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function normalizeRevision(value) {
  const revision = String(value || '').trim();
  return SAFE_REVISION.test(revision) ? revision : UNKNOWN_REVISION;
}

function createServiceIdentity({
  service,
  version,
  env = process.env,
  now = () => new Date(),
}) {
  const observedAt = now();
  const ts = observedAt instanceof Date
    ? observedAt.toISOString()
    : new Date(observedAt).toISOString();

  return Object.freeze({
    service: String(service || 'agentx-unknown'),
    version: String(version || '0.0.0'),
    profile: currentAgentXProfile(env),
    revision: normalizeRevision(env.AGENTX_BUILD_REVISION),
    ts,
  });
}

module.exports = {
  UNKNOWN_REVISION,
  normalizeRevision,
  createServiceIdentity,
};
