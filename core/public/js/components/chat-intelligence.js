/**
 * Chat Intelligence — Status Bar & Side Panel
 *
 * Layer 1: Thin status bar below the composer showing model/host/route/ctx/VRAM.
 * Layer 3: Collapsible right-side panel with cluster health, routing, host preferences,
 *          alerts, and recent routing log.
 *
 * IIFE module pattern — exposes ChatIntelligence on window.
 */
const ChatIntelligence = (() => {
  'use strict';

  // ── Private state ───────────────────────────────────

  let _statusBarEl = null;
  let _panelEl = null;
  let _backdropEl = null;
  let _toggleBtnEl = null;
  let _pollTimer = null;
  let _isOpen = false;

  const POLL_INTERVAL = 15000; // 15 s
  const API_URL = '/api/nerve-center/intelligence';

  // Cached field references inside the status bar
  const _fields = {};

  // ── Status Bar ──────────────────────────────────────

  /**
   * Bind to the inline CI fields already in the header bar (no separate bar created).
   */
  function _createStatusBar(composerEl) {
    // Fields are embedded in .chat-header-bar in index.html
    const headerBar = document.querySelector('.chat-header-bar');
    if (!headerBar) return;
    _statusBarEl = headerBar; // re-use as sentinel so updateStatusBar works

    ['model', 'host', 'route', 'ctx', 'vram'].forEach(key => {
      _fields[key] = headerBar.querySelector(`[data-ci-field="${key}"]`);
    });
    _fields.hostDot = headerBar.querySelector('.ci-health-dot');

    // Model field is the existing headerModelBadge
    if (!_fields.model) _fields.model = document.getElementById('headerModelBadge');
  }

  function _fieldHTML(key, label, defaultVal, withDot) {
    const dotHTML = withDot ? '<span class="ci-health-dot"></span> ' : '';
    const accentClass = key === 'model' ? ' ci-accent' : '';
    return `<span class="ci-status-field">` +
      `${dotHTML}` +
      `<span class="ci-status-label">${label}:</span> ` +
      `<span class="ci-status-value${accentClass}" data-ci-field="${key}">${defaultVal}</span>` +
      `</span>`;
  }

  function _sep() {
    return '<span class="ci-status-sep">|</span>';
  }

  /**
   * Update status bar fields from a routing-info object.
   * Expected shape: { model, host, hostHealth, routeReason, contextSize, vramUsed, vramTotal }
   */
  function updateStatusBar(data) {
    if (!_statusBarEl || !data) return;

    if (data.model && _fields.model) {
      _fields.model.textContent = data.model;
    }
    if (data.host && _fields.host) {
      _fields.host.textContent = data.host;
    }
    if (_fields.hostDot) {
      _fields.hostDot.className = 'ci-health-dot ' + (data.hostHealth || '');
    }
    if (data.routeReason && _fields.route) {
      _fields.route.textContent = data.routeReason;
    }
    if (data.contextSize !== undefined && _fields.ctx) {
      _fields.ctx.textContent = String(data.contextSize);
    }
    if (_fields.vram) {
      if (data.vramUsed !== undefined && data.vramTotal !== undefined) {
        _fields.vram.textContent = `${data.vramUsed}/${data.vramTotal}G`;
      } else if (data.vram) {
        _fields.vram.textContent = data.vram;
      }
    }
  }

  // ── Per-Message Routing Badge (for Task 4) ──────────

  /**
   * Create a DOM element representing a routing badge for a single message.
   * @param {Object} info - { model, host, hostHealth, duration }
   * @returns {HTMLElement}
   */
  function createRoutingBadge(info) {
    if (!info) return null;
    const badge = document.createElement('div');
    badge.className = 'ci-routing-badge';

    const dotClass = info.hostHealth || '';
    const taskLabel = info.taskType ? String(info.taskType).replace(/_/g, ' ') : null;
    const destination = [];
    const destinationHost = info.routedHost || info.host;

    if (info.model) destination.push(`<span class="ci-badge-model">${_esc(info.model)}</span>`);
    if (destinationHost) destination.push(`<span class="ci-badge-host">${_esc(destinationHost)}</span>`);

    const parts = [];
    parts.push(`<span class="ci-health-dot ${dotClass}"></span>`);
    if (taskLabel && info.autoRouted) {
      parts.push(`<span class="ci-badge-route">Classified as <strong>${_esc(taskLabel)}</strong> \u2192</span>`);
    } else if (taskLabel) {
      parts.push(`<span class="ci-badge-route">Route: <strong>${_esc(taskLabel)}</strong></span>`);
    }
    if (destination.length > 0) parts.push(destination.join(' on '));
    if (info.prompt?.name && info.prompt?.version != null) {
      const exactLabel = info.prompt.exact ? 'exact prompt' : 'prompt';
      parts.push(`<span class="ci-badge-prompt">${_esc(exactLabel)}: ${_esc(info.prompt.name)} v${_esc(info.prompt.version)}</span>`);
    }
    if (info.duration) parts.push(`<span class="ci-badge-time">${_esc(info.duration)}</span>`);

    badge.innerHTML = parts.join(' ');
    return badge;
  }

  // ── Side Panel ──────────────────────────────────────

  /**
   * Build the toggle button, backdrop, and panel DOM. Appends to <body>.
   */
  function _createPanel() {
    // Use the existing button in the header bar (not a floating one)
    _toggleBtnEl = document.getElementById('ciToggleBtn');
    if (_toggleBtnEl) {
      _toggleBtnEl.addEventListener('click', _toggle);
    }

    // Backdrop
    _backdropEl = document.createElement('div');
    _backdropEl.className = 'ci-backdrop';
    _backdropEl.addEventListener('click', closePanel);

    // Panel
    _panelEl = document.createElement('div');
    _panelEl.className = 'ci-panel';
    _panelEl.innerHTML = `
      <div class="ci-panel-header">
        <h3 class="ci-panel-title"><i class="fas fa-brain"></i> Intelligence</h3>
        <button class="ci-panel-close" title="Close">&times;</button>
      </div>
      <div class="ci-panel-body" id="ciPanelBody">
        <div class="ci-section">
          <div class="ci-section-label">Cluster</div>
          <div class="ci-cluster-row" id="ciCluster"><span class="ci-empty">Loading...</span></div>
        </div>
        <div class="ci-section">
          <div class="ci-section-label">Routing</div>
          <div id="ciRouting"><span class="ci-empty">Loading...</span></div>
        </div>
        <div class="ci-section">
          <div class="ci-section-label">Alerts</div>
          <div id="ciAlerts"><span class="ci-empty">Loading...</span></div>
        </div>
        <div class="ci-section">
          <div class="ci-section-label">Recent Routing</div>
          <ul class="ci-routing-log" id="ciRecentRouting"></ul>
        </div>
        <a href="/nerve-center.html" class="ci-action-btn"><i class="fas fa-project-diagram" style="margin-right:6px;"></i>Open Nerve Center</a>
      </div>
    `;

    _panelEl.querySelector('.ci-panel-close').addEventListener('click', closePanel);

    document.body.appendChild(_backdropEl);
    document.body.appendChild(_panelEl);
  }

  function _toggle() {
    if (_isOpen) closePanel();
    else openPanel();
  }

  function openPanel() {
    if (_isOpen) return;
    _isOpen = true;
    _panelEl.classList.add('open');
    _backdropEl.classList.add('visible');
    _toggleBtnEl.classList.add('active');
    refreshPanel();
    _startPoll();
  }

  function closePanel() {
    if (!_isOpen) return;
    _isOpen = false;
    _panelEl.classList.remove('open');
    _backdropEl.classList.remove('visible');
    _toggleBtnEl.classList.remove('active');
    _stopPoll();
  }

  // ── Data Fetching & Rendering ───────────────────────

  async function refreshPanel() {
    try {
      const res = await fetch(API_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const data = json.data || json;
      _renderCluster(data.cluster);
      _renderRouting(data.routing);
      _renderAlerts(data.alerts);
      _renderRecentRouting(data.recentRouting);
    } catch (err) {
      console.warn('[ChatIntelligence] refreshPanel failed:', err.message);
    }
  }

  function _renderCluster(cluster) {
    const el = document.getElementById('ciCluster');
    if (!el) return;

    if (!cluster || (Array.isArray(cluster) && cluster.length === 0)) {
      el.innerHTML = '<span class="ci-empty">No host data</span>';
      return;
    }

    // cluster can be an array or object keyed by host
    const hosts = Array.isArray(cluster) ? cluster : Object.values(cluster);
    if (hosts.length === 0) {
      el.innerHTML = '<span class="ci-empty">No hosts</span>';
      return;
    }

    el.innerHTML = hosts.map(h => {
      const name = h.name || h.hostKey || h.host || 'unknown';
      const health = _healthClass(h);
      return `<div class="ci-host-item"><span class="ci-health-dot ${health}"></span>${_esc(name)}</div>`;
    }).join('');
  }

  function _renderRouting(routing) {
    const el = document.getElementById('ciRouting');
    if (!el) return;

    if (!routing) {
      el.innerHTML = '<span class="ci-empty">No routing data</span>';
      return;
    }

    const mode = routing.mode || routing.strategy || 'primary';
    const activeHost = routing.activeHost || routing.currentHost || '---';
    el.innerHTML = `<div class="ci-routing-mode"><strong>${_esc(mode)}</strong> &mdash; ${_esc(activeHost)}</div>`;
  }

  function _renderAlerts(alerts) {
    const el = document.getElementById('ciAlerts');
    if (!el) return;

    const count = Array.isArray(alerts) ? alerts.length : 0;
    const badgeClass = count === 0 ? 'ci-badge zero' : 'ci-badge';
    el.innerHTML = `<div class="ci-alert-count">` +
      `<i class="fas fa-bell" style="color:#585f73;"></i> ` +
      `Active alerts <span class="${badgeClass}">${count}</span>` +
      `</div>`;
  }

  function _renderRecentRouting(logs) {
    const el = document.getElementById('ciRecentRouting');
    if (!el) return;

    if (!logs || logs.length === 0) {
      el.innerHTML = '<li class="ci-empty">No recent routing</li>';
      return;
    }

    const items = logs.slice(0, 5);
    el.innerHTML = items.map(log => {
      const model = log.model || '---';
      const host = log.hostKey || log.host || '---';
      const task = log.taskType || '';
      const ts = log.timestamp ? _relativeTime(log.timestamp) : '';
      return `<li>` +
        `<span class="ci-log-model">${_esc(model)}</span>` +
        `<span class="ci-log-meta">${_esc(host)}${task ? ' / ' + _esc(task) : ''} &middot; ${_esc(ts)}</span>` +
        `</li>`;
    }).join('');
  }

  // ── Polling ─────────────────────────────────────────

  function _startPoll() {
    _stopPoll();
    _pollTimer = setInterval(() => {
      if (_isOpen) refreshPanel();
    }, POLL_INTERVAL);
  }

  function _stopPoll() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
  }

  // ── Utilities ───────────────────────────────────────

  function _esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  function _healthClass(host) {
    if (!host) return '';
    const s = host.status || host.health || '';
    if (s === 'online' || s === 'healthy' || s === 'ok') return 'online';
    if (s === 'degraded' || s === 'slow' || s === 'warning') return 'degraded';
    if (s === 'offline' || s === 'error' || s === 'unreachable') return 'offline';
    // If host has an explicit boolean
    if (host.online === true) return 'online';
    if (host.online === false) return 'offline';
    return '';
  }

  function _relativeTime(ts) {
    try {
      const diff = Date.now() - new Date(ts).getTime();
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
      return Math.floor(diff / 86400000) + 'd ago';
    } catch { return ''; }
  }

  // ── Init ────────────────────────────────────────────

  /**
   * Initialize the Chat Intelligence layers.
   * @param {HTMLElement} composerEl — the .composer container
   */
  function init(composerEl) {
    if (!composerEl) {
      console.warn('[ChatIntelligence] init: no composer element provided');
      return;
    }
    _createStatusBar(composerEl);
    _createPanel();
  }

  // ── Public API ──────────────────────────────────────

  return {
    init,
    createRoutingBadge,
    updateStatusBar,
    refreshPanel,
    openPanel,
    closePanel
  };
})();

window.ChatIntelligence = ChatIntelligence;
