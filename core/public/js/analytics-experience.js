/** Human summary and progressive disclosure for product analytics. */
(function () {
  'use strict';

  var cockpit;
  var surface;
  var status;
  var statusLabel;
  var statusDetail;

  function text(id) {
    return document.getElementById(id)?.textContent.trim() || '';
  }

  function number(id) {
    var match = text(id).match(/-?[\d,.]+/);
    return match ? Number(match[0].replace(/,/g, '')) : null;
  }

  function setStatus(state, label, detail, icon) {
    status.className = 'analytics-experience-status is-' + state;
    status.querySelector('.analytics-experience-icon i').className = 'fas ' + icon;
    statusLabel.textContent = label;
    statusDetail.textContent = detail;
  }

  function refreshSummary() {
    var calls = number('infCalls');
    var errors = number('infErrors');
    var errorRate = text('infErrorRate');
    var conversations = number('totalConversations');
    var messages = number('totalMessages');
    var ragUsage = text('ragUsage');
    var documents = number('ragTotalDocs');
    var windowLabel = document.querySelector('#infWindow option:checked')?.textContent.toLowerCase() || 'recent window';

    if (calls == null || errors == null) {
      setStatus('unknown', 'Activity is still being observed', 'Refresh if the recent inference summary does not appear.', 'fa-circle-question');
    } else if (errors > 0) {
      setStatus('attention', 'Inference needs review', errors + ' failed call' + (errors === 1 ? '' : 's') + ' · ' + errorRate + ' error rate · ' + windowLabel, 'fa-circle-info');
    } else {
      setStatus('ready', 'Inference is healthy', calls + ' call' + (calls === 1 ? '' : 's') + ' · no failures · ' + windowLabel, 'fa-circle-check');
    }

    document.getElementById('analytics-inference-detail').textContent = calls == null
      ? 'Calls and reliability are not observed yet'
      : calls + ' call' + (calls === 1 ? '' : 's') + ' · ' + (errors || 0) + ' failed';
    document.getElementById('analytics-chat-detail').textContent = conversations == null
      ? 'Conversation activity is not observed yet'
      : conversations + ' conversation' + (conversations === 1 ? '' : 's') + ' · ' + (messages || 0) + ' messages';
    document.getElementById('analytics-knowledge-detail').textContent = documents == null
      ? (ragUsage || 'Knowledge usage is not observed yet')
      : documents + ' source' + (documents === 1 ? '' : 's') + ' · ' + (ragUsage || 'usage not observed');
  }

  function syncCockpitAccessibility() {
    surface.inert = !cockpit.open;
    if (cockpit.open) surface.removeAttribute('aria-hidden');
    else surface.setAttribute('aria-hidden', 'true');
  }

  function openTo(targetId) {
    cockpit.open = true;
    syncCockpitAccessibility();
    requestAnimationFrame(function () {
      var target = document.getElementById(targetId);
      if (!target) return;
      target.tabIndex = -1;
      target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      target.focus({ preventScroll: true });
    });
  }

  function refreshAll() {
    setStatus('unknown', 'Refreshing activity…', 'Reading recent inference, conversations and knowledge signals', 'fa-circle-notch fa-spin');
    ['infRefreshBtn', 'refreshBtn', 'refreshRagBtn'].forEach(function (id) {
      document.getElementById(id)?.click();
    });
    window.setTimeout(refreshSummary, 900);
  }

  document.addEventListener('DOMContentLoaded', function () {
    cockpit = document.getElementById('analytics-cockpit');
    surface = cockpit.querySelector('.analytics-cockpit-surface');
    status = document.getElementById('analytics-experience-status');
    statusLabel = document.getElementById('analytics-experience-status-label');
    statusDetail = document.getElementById('analytics-experience-status-detail');

    cockpit.addEventListener('toggle', syncCockpitAccessibility);
    document.querySelectorAll('[data-analytics-target]').forEach(function (button) {
      button.addEventListener('click', function () { openTo(button.dataset.analyticsTarget); });
    });
    document.getElementById('analytics-experience-refresh').addEventListener('click', refreshAll);
    ['infCalls', 'infErrors', 'infErrorRate', 'totalConversations', 'totalMessages', 'ragUsage', 'ragTotalDocs'].forEach(function (id) {
      var element = document.getElementById(id);
      if (element) new MutationObserver(refreshSummary).observe(element, { childList: true, subtree: true, characterData: true });
    });

    syncCockpitAccessibility();
    refreshSummary();
  });
})();
