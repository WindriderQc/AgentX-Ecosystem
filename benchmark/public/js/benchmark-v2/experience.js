/** Human entry point for the Benchmark laboratory. */
(function () {
  'use strict';

  var els = {};

  function cacheElements() {
    els.cockpit = document.getElementById('benchmark-cockpit');
    els.primary = document.getElementById('evaluation-primary-action');
    els.primaryLabel = document.getElementById('evaluation-primary-label');
    els.primaryDetail = document.getElementById('evaluation-primary-detail');
    els.readiness = document.getElementById('evaluation-readiness');
    els.readinessLabel = document.getElementById('evaluation-readiness-label');
    els.readinessDetail = document.getElementById('evaluation-readiness-detail');
    els.refresh = document.getElementById('evaluation-refresh');
    els.historyDetail = document.getElementById('evaluation-history-detail');
  }

  function setReadiness(state, label, detail) {
    var icons = { ok: 'fa-circle-check', warn: 'fa-circle-info', error: 'fa-circle-exclamation', unknown: 'fa-circle-question', loading: 'fa-circle-notch fa-spin' };
    els.readiness.className = 'evaluation-readiness is-' + state;
    els.readiness.querySelector('.evaluation-readiness-icon i').className = 'fas ' + icons[state];
    els.readinessLabel.textContent = label;
    els.readinessDetail.textContent = detail;
  }

  function setPrimary(label, detail, href) {
    els.primaryLabel.textContent = label;
    els.primaryDetail.textContent = detail;
    els.primary.href = href;
  }

  function openCockpit() {
    els.cockpit.open = true;
    requestAnimationFrame(function () {
      var firstStep = document.getElementById('infrastructure');
      if (firstStep) {
        firstStep.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
        firstStep.focus({ preventScroll: true });
      }
    });
  }

  function syncCockpitAccessibility() {
    var surface = els.cockpit.querySelector('.evaluation-cockpit-surface');
    if (!surface) return;
    if (els.cockpit.open) {
      surface.removeAttribute('inert');
      surface.removeAttribute('aria-hidden');
      return;
    }
    surface.setAttribute('inert', '');
    surface.setAttribute('aria-hidden', 'true');
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

  async function refreshExperience() {
    setReadiness('loading', 'Checking evaluation…', 'Confirming models, host profile and history');
    var responses = await Promise.allSettled([
      fetchJson('/api/ollama-hosts'),
      fetchJson('/api/profiler/hosts'),
      fetchJson('/api/benchmark/batches?limit=1'),
      fetchJson('/api/benchmark/batches/active')
    ]);

    var runtimes = responses[0].status === 'fulfilled' ? (responses[0].value.hosts || []) : [];
    var profilePayload = responses[1].status === 'fulfilled' ? responses[1].value : {};
    var profiles = profilePayload.data || profilePayload || [];
    var batchPayload = responses[2].status === 'fulfilled' ? responses[2].value : {};
    var batches = (batchPayload.data && batchPayload.data.batches) || [];
    var activePayload = responses[3].status === 'fulfilled' ? responses[3].value : {};
    var active = (activePayload.data && (activePayload.data.batch || activePayload.data)) || null;
    var activeId = active && (active._id || active.id);
    var onlineModels = runtimes.reduce(function (count, host) {
      return count + (host.available && Array.isArray(host.models) ? host.models.length : 0);
    }, 0);
    var readyProfiles = Array.isArray(profiles) ? profiles.filter(function (host) {
      return host.status === 'online' && host.baseline && host.baseline.testedAt;
    }) : [];

    els.historyDetail.textContent = batches.length
      ? batches.length + ' recent comparison' + (batches.length === 1 ? '' : 's')
      : 'No completed comparisons yet';

    if (responses[0].status !== 'fulfilled') {
      setReadiness('unknown', 'Model runtime status is unknown', 'The live check did not finish. Refresh or open connection setup.');
      setPrimary('Open connection setup', 'Verify the runtime without guessing its state', '/setup');
      return;
    }

    if (activeId) {
      setReadiness('ok', 'Comparison in progress', 'Live evidence is updating in the expert lab');
      setPrimary('View live comparison', 'Follow progress, rankings and anomalies', '#benchmark-cockpit');
      els.cockpit.open = true;
      return;
    }
    if (onlineModels === 0) {
      setReadiness('error', 'No model runtime available', 'Connect an Ollama host before comparing models.');
      setPrimary('Set up evaluation', 'Connect a model host and verify it', '/setup');
      return;
    }
    if (!readyProfiles.length) {
      setReadiness('warn', 'Host needs a quick profile', onlineModels + ' model' + (onlineModels === 1 ? '' : 's') + ' online · performance baseline required');
      setPrimary('Prepare the host', 'Run one baseline so comparisons are trustworthy', '/profiler');
      return;
    }
    setReadiness('ok', 'Ready to compare', onlineModels + ' model' + (onlineModels === 1 ? '' : 's') + ' available on a prepared host');
    setPrimary('Set up a comparison', 'Choose contenders and a focused test depth', '#benchmark-cockpit');
  }

  document.addEventListener('DOMContentLoaded', function () {
    cacheElements();
    els.primary.addEventListener('click', function (event) {
      if (els.primary.getAttribute('href') !== '#benchmark-cockpit') return;
      event.preventDefault();
      openCockpit();
    });
    els.refresh.addEventListener('click', refreshExperience);
    els.cockpit.addEventListener('toggle', syncCockpitAccessibility);
    if (location.hash === '#benchmark-cockpit' || document.body.classList.contains('state-live')) els.cockpit.open = true;
    syncCockpitAccessibility();
    new MutationObserver(function () {
      if (document.body.classList.contains('state-live')) {
        els.cockpit.open = true;
        syncCockpitAccessibility();
      }
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    refreshExperience().catch(function (error) {
      setReadiness('error', 'Could not check evaluation', error.message || 'Benchmark did not respond.');
    });
  });
})();
