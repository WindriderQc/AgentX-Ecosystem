'use strict';

/**
 * Return the capability-free HostPreference shape that may cross a public or
 * operator read boundary. Coordination generations, admission identities,
 * finalizer tokens, exact runtime snapshots, and prior release receipts are
 * bearer evidence and must only be returned by authenticated coordination
 * endpoints.
 */
function projectHostPreferenceForRead(pref) {
  if (!pref) return pref;
  const source = typeof pref.toObject === 'function' ? pref.toObject() : pref;
  const {
    lastBenchmarkReleaseReceipt: _releaseReceipt,
    ...safePref
  } = source;
  if (!safePref.benchmarkClaim) return safePref;
  const claim = safePref.benchmarkClaim;
  return {
    ...safePref,
    benchmarkClaim: {
      batchId: claim.batchId || null,
      prevStatus: claim.prevStatus || null,
      claimedAt: claim.claimedAt || null,
      estimatedDurationMs: claim.estimatedDurationMs || null,
      source: claim.source || null,
      owner: claim.owner || null,
      note: claim.note || null,
      heartbeatAt: claim.heartbeatAt || null,
      heartbeatTtlMs: claim.heartbeatTtlMs || null,
      snapshotExact: claim.preClaimRuntime?.exact === true,
      snapshotResidentCount: Array.isArray(claim.preClaimRuntime?.residents)
        ? claim.preClaimRuntime.residents.length
        : null,
      finalizing: Boolean(claim.finalizeToken)
    }
  };
}

function projectHostPreferencesForRead(preferences) {
  return Array.isArray(preferences)
    ? preferences.map(projectHostPreferenceForRead)
    : [];
}

module.exports = {
  projectHostPreferenceForRead,
  projectHostPreferencesForRead
};
