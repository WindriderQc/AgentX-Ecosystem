/** Guided preparation shell for the exact-artifact profiler. */
(function () {
  'use strict';

  var cockpit;
  var surface;
  var status;
  var statusLabel;
  var statusDetail;
  var primary;
  var primaryLabel;
  var primaryDetail;
  var modelsDetail;
  var runtimeAvailable = false;

  function setStatus(state, label, detail, icon) {
    status.className = 'profiler-experience-status is-' + state;
    status.querySelector('.profiler-experience-icon i').className = 'fas ' + icon;
    statusLabel.textContent = label;
    statusDetail.textContent = detail;
  }

  function setPrimary(label, detail) {
    primaryLabel.textContent = label;
    primaryDetail.textContent = detail;
  }

  async function fetchJson(url) {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 12000);
    try {
      var response = await fetch(url, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Request failed (' + response.status + ')');
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  function modelStage(model) {
    var readiness = model?.readiness || model?.hostReadiness || {};
    var stages = Object.values(readiness).map(function (value) {
      return (typeof value === 'string' ? value : value?.stage) || 'available';
    });
    if (stages.includes('benchmarked')) return 'benchmarked';
    if (stages.includes('profiled')) return 'profiled';
    return model?.stage || 'available';
  }

  async function refreshExperience() {
    setStatus('unknown', 'Checking preparation…', 'Reading hosts, baselines and exact model profiles', 'fa-circle-notch fa-spin');
    var responses = await Promise.allSettled([
      fetchJson('/api/ollama-hosts'),
      fetchJson('/api/profiler/hosts'),
      fetchJson('/api/profiler/models')
    ]);

    if (responses[0].status !== 'fulfilled') {
      runtimeAvailable = false;
      setStatus('unknown', 'Runtime status is unknown', 'The live check did not finish. Refresh or inspect connection setup.', 'fa-circle-question');
      setPrimary('Open connection setup', 'Verify the runtime without guessing its state');
      return;
    }

    var runtimes = responses[0].value.hosts || [];
    var hostPayload = responses[1].status === 'fulfilled' ? responses[1].value : {};
    var modelPayload = responses[2].status === 'fulfilled' ? responses[2].value : {};
    var hosts = hostPayload.data || hostPayload || [];
    var profiles = modelPayload.data || modelPayload || [];
    var modelCount = runtimes.reduce(function (count, host) {
      return count + (host.available && Array.isArray(host.models) ? host.models.length : 0);
    }, 0);
    var onlineHosts = runtimes.filter(function (host) { return host.available; }).length;
    var baselineHosts = Array.isArray(hosts) ? hosts.filter(function (host) { return host.baseline?.testedAt; }).length : 0;
    var profiled = Array.isArray(profiles) ? profiles.filter(function (model) {
      return ['profiled', 'benchmarked'].includes(modelStage(model));
    }).length : 0;

    runtimeAvailable = modelCount > 0;
    modelsDetail.textContent = modelCount + ' exact model' + (modelCount === 1 ? '' : 's') + ' available · ' + profiled + ' profiled';

    if (!runtimeAvailable) {
      setStatus('blocked', 'No model runtime available', 'Connect a runtime and install a model before profiling.', 'fa-circle-exclamation');
      setPrimary('Open connection setup', 'Connect and verify an Ollama runtime');
      return;
    }
    if (baselineHosts === 0) {
      setStatus('attention', 'A host baseline is required', onlineHosts + ' host' + (onlineHosts === 1 ? '' : 's') + ' online · ' + modelCount + ' models available', 'fa-circle-info');
      setPrimary('Prepare the host', 'Review the target and run one measured baseline');
      return;
    }
    if (profiled === 0) {
      setStatus('attention', 'Profile the contenders', baselineHosts + ' host baseline' + (baselineHosts === 1 ? '' : 's') + ' ready · no exact model profiles yet', 'fa-circle-info');
      setPrimary('Review host baseline', 'Then profile only the models you want to compare');
      return;
    }
    setStatus('ready', 'Prepared for comparison', profiled + ' exact model profile' + (profiled === 1 ? '' : 's') + ' on ' + baselineHosts + ' prepared host' + (baselineHosts === 1 ? '' : 's'), 'fa-circle-check');
    setPrimary('Review prepared hosts', 'Inspect evidence or update a baseline');
  }

  function syncCockpitAccessibility() {
    surface.inert = !cockpit.open;
    if (cockpit.open) surface.removeAttribute('aria-hidden');
    else surface.setAttribute('aria-hidden', 'true');
  }

  function openTo(targetId) {
    if (!runtimeAvailable && targetId === 'mp-hosts-section') {
      window.location.href = '/setup';
      return;
    }
    cockpit.open = true;
    syncCockpitAccessibility();
    requestAnimationFrame(function () {
      var target = document.getElementById(targetId);
      if (!target) return;
      target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      target.focus({ preventScroll: true });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    cockpit = document.getElementById('profiler-cockpit');
    surface = cockpit.querySelector('.profiler-cockpit-surface');
    status = document.getElementById('profiler-experience-status');
    statusLabel = document.getElementById('profiler-experience-status-label');
    statusDetail = document.getElementById('profiler-experience-status-detail');
    primary = document.getElementById('profiler-primary-action');
    primaryLabel = document.getElementById('profiler-primary-label');
    primaryDetail = document.getElementById('profiler-primary-detail');
    modelsDetail = document.getElementById('profiler-models-detail');

    cockpit.addEventListener('toggle', syncCockpitAccessibility);
    document.querySelectorAll('[data-profiler-target]').forEach(function (button) {
      button.addEventListener('click', function () { openTo(button.dataset.profilerTarget); });
    });
    document.getElementById('profiler-experience-refresh').addEventListener('click', refreshExperience);
    syncCockpitAccessibility();
    refreshExperience().catch(function (error) {
      setStatus('unknown', 'Preparation status is unknown', error.message || 'Profiler did not respond.', 'fa-circle-question');
    });
  });
})();
