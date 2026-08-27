/** Human entry point and accessibility boundary for the model registry. */
(function () {
  'use strict';

  var cockpit;
  var cockpitSurface;
  var refreshButton;
  var status;
  var statusLabel;
  var statusDetail;
  var browseDetail;

  function numberFrom(id) {
    var value = document.getElementById(id);
    if (!value) return null;
    var match = value.textContent.match(/[\d,.]+/);
    return match ? Number(match[0].replace(/,/g, '')) : null;
  }

  function setStatus(state, label, detail, icon) {
    status.className = 'models-experience-readiness is-' + state;
    status.querySelector('.models-experience-status-icon i').className = 'fas ' + icon;
    statusLabel.textContent = label;
    statusDetail.textContent = detail;
  }

  function refreshHumanStatus() {
    var total = numberFrom('statTotal');
    var hosts = numberFrom('statHosts');
    var storage = document.getElementById('statStorage')?.textContent.trim();
    var tableError = document.querySelector('#modelsTableBody .error-msg');

    if (tableError) {
      setStatus('blocked', 'Could not read the model registry', 'Refresh the registry or inspect the runtime connection.', 'fa-circle-exclamation');
      browseDetail.textContent = 'Open the registry and inspect the connection';
      return;
    }
    if (total == null || hosts == null) {
      setStatus('loading', 'Checking models…', 'Reading the live model registry', 'fa-circle-notch fa-spin');
      return;
    }
    if (total === 0) {
      setStatus('attention', 'No model is installed', 'Add a model or connect an Ollama runtime before chatting.', 'fa-circle-info');
      browseDetail.textContent = 'Open the registry to add a model source';
      return;
    }

    var hostLabel = hosts + ' runtime host' + (hosts === 1 ? '' : 's');
    var storageLabel = storage && storage !== '--' ? ' · ' + storage + ' installed' : '';
    setStatus('ready', total + ' model' + (total === 1 ? '' : 's') + ' ready', hostLabel + storageLabel, 'fa-circle-check');
    browseDetail.textContent = total + ' installed · search, inspect or choose an exact model';
  }

  function syncCockpitAccessibility() {
    if (!cockpitSurface) return;
    cockpitSurface.inert = !cockpit.open;
    if (cockpit.open) cockpitSurface.removeAttribute('aria-hidden');
    else cockpitSurface.setAttribute('aria-hidden', 'true');
  }

  function openLibrary() {
    cockpit.open = true;
    syncCockpitAccessibility();
    requestAnimationFrame(function () {
      var search = document.getElementById('searchInput');
      if (search) {
        search.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
        search.focus({ preventScroll: true });
      }
    });
  }

  function syncOverlayAccessibility(element) {
    var open = element.classList.contains('active') || element.classList.contains('open');
    element.inert = !open;
    if (open) element.removeAttribute('aria-hidden');
    else element.setAttribute('aria-hidden', 'true');
  }

  function guardOverlays() {
    ['modelDetailDrawer', 'statPopoutDrawer', 'addSourceModal', 'comparisonModal', 'execConfigModal'].forEach(function (id) {
      var element = document.getElementById(id);
      if (!element) return;
      syncOverlayAccessibility(element);
      new MutationObserver(function () { syncOverlayAccessibility(element); })
        .observe(element, { attributes: true, attributeFilter: ['class'] });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    cockpit = document.getElementById('models-cockpit');
    cockpitSurface = cockpit.querySelector('.models-cockpit-surface');
    refreshButton = document.getElementById('models-experience-refresh');
    status = document.getElementById('models-experience-readiness');
    statusLabel = document.getElementById('models-experience-status-label');
    statusDetail = document.getElementById('models-experience-status-detail');
    browseDetail = document.getElementById('models-browse-detail');

    cockpit.addEventListener('toggle', syncCockpitAccessibility);
    document.getElementById('models-browse-action').addEventListener('click', openLibrary);
    refreshButton.addEventListener('click', async function () {
      setStatus('loading', 'Refreshing models…', 'Reading the live model registry', 'fa-circle-notch fa-spin');
      if (window.unifiedModels?.fetchModels) await window.unifiedModels.fetchModels();
      refreshHumanStatus();
    });

    syncCockpitAccessibility();
    guardOverlays();
    ['statTotal', 'statHosts', 'statStorage', 'modelsTableBody'].forEach(function (id) {
      var element = document.getElementById(id);
      if (element) new MutationObserver(refreshHumanStatus).observe(element, { childList: true, subtree: true, characterData: true });
    });
    refreshHumanStatus();
  });
})();
