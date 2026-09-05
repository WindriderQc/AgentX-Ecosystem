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

  function parseCompactNumber(value) {
    var match = String(value || '')
      .trim()
      .match(/-?[\d,.]+\s*[kmb]?/i);
    if (!match) return null;

    var compact = match[0].replace(/,/g, '').replace(/\s+/g, '');
    var suffix = compact.slice(-1).toLowerCase();
    var multiplier = { k: 1e3, m: 1e6, b: 1e9 }[suffix] || 1;
    var numericText = multiplier === 1 ? compact : compact.slice(0, -1);
    var parsed = Number(numericText);
    return Number.isFinite(parsed) ? parsed * multiplier : null;
  }

  function number(id) {
    return parseCompactNumber(text(id));
  }

  function formatCount(value) {
    return Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
  }

  function observedLabel(value) {
    var label = String(value || '').trim();
    if (!label || /^(?:—|--|n\/?a|unknown|loading…?)$/i.test(label)) return null;
    return label;
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
    var cancellations = number('infCancellations');
    var errorRate = text('infErrorRate');
    var conversations = number('totalConversations');
    var messages = number('totalMessages');
    var ragUsage = observedLabel(text('ragUsage'));
    var documents = number('ragTotalDocs');
    var windowLabel = document.querySelector('#infWindow option:checked')?.textContent.toLowerCase() || 'recent window';

    if (calls == null || errors == null) {
      setStatus('unknown', 'Activity is still being observed', 'Refresh if the recent inference summary does not appear.', 'fa-circle-question');
    } else if (errors > 0) {
      setStatus('attention', 'Inference needs review', formatCount(errors) + ' operational error' + (errors === 1 ? '' : 's') + ' · ' + errorRate + ' error rate · ' + formatCount(cancellations || 0) + ' canceled · ' + windowLabel, 'fa-circle-info');
    } else {
      setStatus('ready', 'Inference is healthy', formatCount(calls) + ' call' + (calls === 1 ? '' : 's') + ' · no operational errors · ' + formatCount(cancellations || 0) + ' canceled · ' + windowLabel, 'fa-circle-check');
    }

    document.getElementById('analytics-inference-detail').textContent = calls == null
      ? 'Calls and reliability are not observed yet'
      : formatCount(calls) + ' call' + (calls === 1 ? '' : 's') + ' · ' + formatCount(errors || 0) + ' errors · ' + formatCount(cancellations || 0) + ' canceled · ' + windowLabel;
    document.getElementById('analytics-chat-detail').textContent = conversations == null
      ? 'Conversation activity is not observed yet'
      : formatCount(conversations) + ' conversation' + (conversations === 1 ? '' : 's') + ' · ' + formatCount(messages || 0) + ' messages';
    document.getElementById('analytics-knowledge-detail').textContent = documents == null
      ? (ragUsage ? ragUsage + ' of conversations used knowledge · ' + windowLabel : 'Knowledge usage is not observed yet')
      : formatCount(documents) + ' source' + (documents === 1 ? '' : 's') + ' · ' + (ragUsage ? ragUsage + ' of conversations used knowledge' : 'usage not observed') + ' · ' + windowLabel;
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

  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', function () {
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
    ['infCalls', 'infErrors', 'infCancellations', 'infErrorRate', 'totalConversations', 'totalMessages', 'ragUsage', 'ragTotalDocs'].forEach(function (id) {
      var element = document.getElementById(id);
      if (element) new MutationObserver(refreshSummary).observe(element, { childList: true, subtree: true, characterData: true });
    });

    syncCockpitAccessibility();
    refreshSummary();
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseCompactNumber: parseCompactNumber,
      observedLabel: observedLabel
    };
  }
})();
