import * as api from './api.js';

const MODULE_VERSION = 'host-telemetry-20260622b';
const state = { data: {} };

function normalizeModelName(name) {
  return String(name || '').replace(/:latest$/i, '').trim();
}

function getHighestStage(profile) {
  const readiness = profile?.readiness;
  if (!readiness) return 'available';
  const entries = readiness instanceof Map ? Array.from(readiness.values()) : Object.values(readiness);
  const stages = entries.map(v => (typeof v === 'string' ? v : v?.stage) || 'available');
  return ['benchmarked', 'profiled', 'available'].find(stage => stages.includes(stage)) || 'available';
}

async function buildLiveFunnel() {
  const [hosts, profiles, dashboard] = await Promise.all([
    api.getHosts().catch(() => []),
    api.getModels().catch(() => []),
    api.getDashboard().catch(() => ({})),
  ]);
  const benchmarkedModels = new Set(
    (dashboard.benchmarkedModels || []).map(normalizeModelName).filter(Boolean)
  );

  const hostList = Array.isArray(hosts) ? hosts : [];
  const liveProbes = await Promise.all(
    hostList.map((host) => api.getLiveProbeStatus(host.hostId).catch(() => null))
  );
  const isLiveOnline = (host, probe) => {
    if (probe?.status === 'ready') return true;
    if (probe?.ollama?.ok) return true;
    if (probe?.status === 'offline') return false;
    return host.status === 'online';
  };
  const onlineHosts = hostList.filter((host, index) => isLiveOnline(host, liveProbes[index]));
  const statuses = await Promise.all(
    onlineHosts.map((host) => api.getHostStatus(host.hostId).catch(() => null))
  );

  const liveModelNames = new Set();
  statuses.forEach((status) => {
    (status?.models || [])
      .map(normalizeModelName)
      .filter(Boolean)
      .forEach((name) => liveModelNames.add(name));
  });

  const profileMap = new Map(
    (Array.isArray(profiles) ? profiles : [])
      .filter((profile) => profile?.name)
      .map((profile) => [normalizeModelName(profile.name), profile])
  );

  const counts = { total: liveModelNames.size, available: 0, profiled: 0, benchmarked: 0 };
  liveModelNames.forEach((name) => {
    const stage = benchmarkedModels.has(name) ? 'benchmarked' : getHighestStage(profileMap.get(name));
    if (stage === 'available') counts.available += 1;
    if (stage === 'profiled' || stage === 'benchmarked') counts.profiled += 1;
    if (stage === 'benchmarked') counts.benchmarked += 1;
  });

  return { hosts, onlineCount: onlineHosts.length, funnel: counts };
}

async function init() {
  // Handle #hosts / #models hash links (from benchmark page toasts)
  const hash = window.location.hash.replace('#', '');
  if (hash) {
    const target = document.getElementById(`mp-${hash}-section`);
    if (target) setTimeout(() => target.scrollIntoView({ behavior: 'smooth' }), 300);
  }

  // Render summary bar
  const summaryEl = document.getElementById('mp-summary');
  if (summaryEl) renderSummary(summaryEl);
  const guideEl = document.getElementById('mp-guide');
  if (guideEl) renderGuide(guideEl);

  // Render all sections in parallel
  const hostsEl = document.getElementById('mp-hosts');
  const modelsEl = document.getElementById('mp-models');
  const [hostsModule, modelsModule] = await Promise.all([
    import(`./hosts.js?v=${MODULE_VERSION}`).catch(() => null),
    import(`./models.js?v=${MODULE_VERSION}`).catch(() => null),
  ]);

  if (hostsModule?.renderHosts && hostsEl) hostsModule.renderHosts(hostsEl, state, api);
  if (modelsModule?.renderModels && modelsEl) modelsModule.renderModels(modelsEl, state, api);

  window.addEventListener('mp:hosts-updated', () => {
    if (summaryEl) renderSummary(summaryEl);
    if (guideEl) renderGuide(guideEl);
  });

  window.addEventListener('mp:models-updated', async () => {
    if (modelsModule?.renderModels && modelsEl) {
      await modelsModule.renderModels(modelsEl, state, api);
    }
  });


  window.addEventListener('mp:host-selected', async (e) => {
    const hostId = e.detail?.hostId;
    if (hostId) {
      state._modelsHostId = hostId;
      if (modelsModule?.renderModels && modelsEl) {
        await modelsModule.renderModels(modelsEl, state, api);
        modelsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  });
}

async function renderSummary(container) {
  try {
    const data = await buildLiveFunnel();
    const funnel = data.funnel || {};
    const hosts = data.hosts || [];
    const onlineCount = data.onlineCount ?? hosts.filter(h => h.status === 'online').length;

    const stages = [
      { key: 'total', label: 'Models', color: '#8892b0', title: 'Live base models on online hosts' },
      { key: 'available', label: 'Need Profile', color: '#8892b0', title: 'Live base models with no profiler readiness yet' },
      { key: 'profiled', label: 'Profiled', color: '#4ecdc4', title: 'Models profiled or farther along' },
      { key: 'benchmarked', label: 'Benchmarked', color: '#2ecc71', title: 'Models with benchmark results' },
    ];

    const funnelHtml = stages.map(s =>
      `<span class="mp-sum-pill" title="${s.title}" style="border-color:${s.color}33;color:${s.color};">
        ${funnel[s.key] || 0} ${s.label}
      </span>`
    ).join('');

    container.innerHTML = `
      <div class="mp-sum-left">
        <span class="mp-sum-hosts">${onlineCount}/${hosts.length} hosts online</span>
        ${funnelHtml}
      </div>`;
  } catch (_) {
    container.innerHTML = '';
  }
}

async function renderGuide(container) {
  try {
    const data = await api.getDashboard();
    const hosts = data.hosts || [];
    const testedHosts = hosts.filter(h => h.baseline?.testedAt);
    const allTested = testedHosts.length === hosts.length && hosts.length > 0;

    // Don't show guide if all hosts are tested
    if (allTested) { container.innerHTML = ''; return; }

    const profiledCount = (data.funnel?.profiled || 0) + (data.funnel?.benchmarked || 0);

    container.innerHTML = `
      <details class="mp-guide-collapse"${testedHosts.length === 0 ? ' open' : ''}>
        <summary class="mp-guide-summary">
          <span>Getting Started</span>
          <span class="mp-guide-summary-stat">${testedHosts.length}/${hosts.length} hosts tested · ${profiledCount} models profiled</span>
        </summary>
        <div class="mp-guide-body">
          <strong>1.</strong> <em>Baseline</em> \u2014 click <em>Baseline Probe</em> on a host card to baseline the hardware.
          <strong>2.</strong> <em>Profile</em> \u2014 click a tested host, then profile models in <strong>Section \u2461</strong> below.
          <strong>3.</strong> <em>Verify</em> \u2014 confirm the profile is bound to the installed registry digest and current host runtime.
          <strong>4.</strong> <em>Benchmark</em> \u2014 once exact artifacts are qualified, <a href="/">open Benchmark</a> to run evaluations.
        </div>
      </details>`;
  } catch (_) {
    container.innerHTML = '';
  }
}

document.addEventListener('DOMContentLoaded', init);
