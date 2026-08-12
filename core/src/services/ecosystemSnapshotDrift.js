'use strict';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function positiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function normalizeModelName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z0-9_-]+\//, '')
    .replace(/^ax\//, '');
}

function modelsSame(left, right) {
  const a = normalizeModelName(left);
  const b = normalizeModelName(right);
  return Boolean(a && b && a === b);
}

function urlsSame(left, right) {
  return String(left || '').replace(/\/+$/, '') === String(right || '').replace(/\/+$/, '');
}

function openclawMemoryPolicies(fastlane) {
  return asArray(fastlane.controls?.openclawRuntime?.memoryPolicies)
    .concat(asArray(fastlane.controls?.openclawRuntime?.memory_policies));
}

function memoryPolicyFor(agentId, policies) {
  return policies.find((policy) => (policy?.agentId || policy?.agent || policy?.id) === agentId) || null;
}

function memoryGapAgentId(gap, agents = []) {
  if (gap?.agentId || gap?.agent) return gap.agentId || gap.agent;
  const id = String(gap?.id || '');
  return asArray(agents)
    .map((agent) => agent?.id)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .find((agentId) => id === agentId || id.startsWith(`${agentId}-`)) || null;
}

function addDrift(records, drift) {
  records.push({
    severity: 'medium',
    owner: null,
    ...drift
  });
}

function detectDrift(results) {
  const records = [];
  const runtime = results.runtime.data || {};
  const fastlane = results.fastlane.data || {};
  const hostPrefs = results.hostPreferences.data?.preferences || [];
  const hostCapacity = results.hostCapacity.data?.reports || [];
  const alerts = results.alerts.data?.active || [];
  const openclaw = results.openclaw.data || {};

  const expectedHermesBase = runtime.hermes?.proxyBaseUrl;
  const registryHermesBase = fastlane.controls?.hermesRuntime?.baseUrl;
  if (expectedHermesBase && registryHermesBase && !urlsSame(expectedHermesBase, registryHermesBase)) {
    addDrift(records, {
      id: 'hermes-authority-base-url-mismatch',
      severity: 'high',
      owner: '0330',
      title: 'Hermes registry policy and AgentX runtime export disagree on base URL.',
      current: registryHermesBase,
      expected: expectedHermesBase
    });
  }

  const expectedHermesModel = runtime.hermes?.authority?.expectedModel || runtime.hermes?.defaultModelConfig?.default;
  const registryHermesModel = fastlane.controls?.hermesRuntime?.primaryModel;
  if (expectedHermesModel && registryHermesModel && !modelsSame(expectedHermesModel, registryHermesModel)) {
    addDrift(records, {
      id: 'hermes-authority-model-mismatch',
      severity: 'high',
      owner: '0330',
      title: 'Hermes registry policy and AgentX runtime export disagree on model authority.',
      current: registryHermesModel,
      expected: expectedHermesModel
    });
  }

  const expectedHermesContext = positiveInteger(runtime.hermes?.authority?.expectedContext || runtime.hermes?.defaultModelConfig?.context_length);
  const registryHermesContext = positiveInteger(fastlane.controls?.hermesRuntime?.context);
  if (expectedHermesContext && registryHermesContext && expectedHermesContext !== registryHermesContext) {
    addDrift(records, {
      id: 'hermes-authority-context-mismatch',
      severity: 'medium',
      owner: '0330',
      title: 'Hermes registry policy and AgentX runtime export disagree on context authority.',
      current: registryHermesContext,
      expected: expectedHermesContext
    });
  }

  const hermesLiveConfig = results.hermes.data?.liveConfig;
  if (runtime.hermes?.authority && hermesLiveConfig?.available === false) {
    addDrift(records, {
      id: 'hermes-live-config-protected',
      severity: 'medium',
      owner: '0330',
      title: 'Hermes live runtime config is protected and not validated against AgentX authority.',
      current: hermesLiveConfig.status || 'not_checked',
      expected: 'validated_or_documented_override',
      details: {
        dashboard: results.hermes.data?.dashboardUrl || null,
        reason: hermesLiveConfig.error || null
      }
    });
  }

  for (const pref of hostPrefs) {
    if (pref.hostIdentityDrift || (pref.persistedHostKey && pref.hostKey && pref.persistedHostKey !== pref.hostKey)) {
      addDrift(records, {
        id: `host-identity-${pref.displayName || pref.hostUrl || pref.hostKey}`,
        severity: 'medium',
        owner: '0328',
        title: 'Host preference persisted identity differs from active configured identity.',
        current: pref.persistedHostKey || pref.hostIdentityDrift?.persisted || null,
        expected: pref.hostKey || pref.configuredHostKey || null,
        details: pref.hostIdentityDrift || {}
      });
    }
  }

  const activeCapacityAlerts = alerts.filter((alert) =>
    alert.ruleId === 'capacity-host-critical' || alert.metric === 'capacity_host_critical'
  );
  for (const alert of activeCapacityAlerts) {
    const host = hostCapacity.find((report) =>
      report.hostId === alert.component ||
      report.configId === alert.component ||
      report.hostname === alert.component
    );
    addDrift(records, {
      id: `host-capacity-active-alert-${alert.component || alert.id}`,
      severity: host?.ollamaReachable ? 'high' : 'medium',
      owner: '0327',
      title: host?.ollamaReachable
        ? 'Active host-capacity critical alert remains for a reachable host.'
        : 'Active host-capacity critical alert remains.',
      current: alert.status,
      expected: host?.ollamaReachable ? 'resolved' : 'investigate',
      details: { alertId: alert.id, host: alert.component || null }
    });
  }

  for (const gap of asArray(openclaw.known_gaps)) {
    if (!/memory|index/i.test(`${gap.id} ${gap.detail || ''}`)) continue;
    const policy = memoryPolicyFor(memoryGapAgentId(gap, openclaw.agents), openclawMemoryPolicies(fastlane));
    if (policy?.classification || policy?.status || policy?.reason) continue;
    addDrift(records, {
      id: `openclaw-${gap.id}`,
      severity: gap.severity || 'medium',
      owner: '0332',
      title: gap.detail || 'OpenClaw memory/index gap detected.',
      current: 'gap',
      expected: 'classified'
    });
  }

  for (const job of asArray(openclaw.cron?.jobs)) {
    const status = job.lastRunStatus || job.lastStatus;
    const errors = Number(job.consecutiveErrors || 0);
    if (job.enabled && (errors > 0 || (status && status !== 'ok'))) {
      addDrift(records, {
        id: `openclaw-cron-${job.name || job.id}`,
        severity: 'high',
        owner: '0329',
        title: 'OpenClaw cron job is failing.',
        current: status || `${errors} consecutive errors`,
        expected: 'ok',
        details: { id: job.id, name: job.name, consecutiveErrors: errors, lastError: job.lastError }
      });
    }
  }

  return records.sort((left, right) => {
    const order = { high: 0, medium: 1, low: 2 };
    return (order[left.severity] ?? 9) - (order[right.severity] ?? 9) || left.id.localeCompare(right.id);
  });
}

function buildRecommendations(drift) {
  const owners = [...new Set(asArray(drift).map((record) => record.owner).filter(Boolean))];
  return owners.map((owner) => ({
    owner,
    action: `Resolve or intentionally classify drift owned by ${owner}.`,
    driftCount: drift.filter((record) => record.owner === owner).length
  }));
}

module.exports = {
  detectDrift,
  buildRecommendations
};
