// public/js/model-profiler/models.js
/**
 * Models renderer — grid, cards, search, filter pills
 * Renders the Models sub-tab for the Model Profiler page.
 *
 * This is the orchestrator/event-wiring entry point. Pure helpers live in
 * `models-helpers.js`, HTML builders in `models-render.js`, and the live
 * profiling panel in `models-profiling.js` (split out under task 0229).
 */

import { openProfileHostDialog } from './components/profile-host-dialog.js';
import { showToast } from '../components/toast.js';
import {
  getReadinessForHost,
  applyFilters,
} from './models-helpers.js';
import {
  renderModelControls,
  renderTopBar,
  renderSettingsPanel,
  renderGrid,
  renderError,
  renderLoading,
} from './models-render.js';
import {
  _showFeedback,
  _runProfiling,
} from './models-profiling.js';

// ─── Event wiring ─────────────────────────────────────────────────────────────

function wireTopBar(container, allModels, state, api) {
  const activeFilter = () => state._modelsFilter || 'all';
  const activeQuery  = () => state._modelsQuery  || '';

  // Selection set persists across filter/search changes
  if (!state._selectedModels) state._selectedModels = new Set();

  function syncSelectionUi() {
    const sel = state._selectedModels;
    const profileBtn = container.querySelector('.mp-btn-profile-host');
    const clearBtn   = container.querySelector('.mp-btn-select-clear');
    if (profileBtn) profileBtn.textContent = sel.size > 0 ? `Profile ${sel.size} selected` : 'Profile All on Host';
    if (clearBtn) clearBtn.disabled = sel.size === 0;
    container.querySelectorAll('.mp-card-checkbox').forEach(cb => {
      cb.checked = sel.has(cb.dataset.model);
    });
  }

  function refresh() {
    const filtered = applyFilters(allModels, activeFilter(), activeQuery());
    const gridWrap = container.querySelector('#mp-model-grid-wrap');
    if (gridWrap) gridWrap.innerHTML = renderGrid(filtered, api, state._modelsView || 'list');
    wireCardActions(container, api);
    syncSelectionUi();
  }

  // Search input
  const searchEl = container.querySelector('#mp-model-search');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      state._modelsQuery = searchEl.value;
      refresh();
    });
  }

  // Filter pills
  container.querySelectorAll('.mp-filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      state._modelsFilter = btn.dataset.filter;
      // Update pill active states without full re-render
      container.querySelectorAll('.mp-filter-pill').forEach(p => {
        const isActive = p.dataset.filter === state._modelsFilter;
        p.classList.toggle('mp-action--primary', isActive);
        p.classList.remove('mp-action--teal'); // ensure no cross-class conflict
        if (!isActive) p.classList.remove('mp-action--primary');
      });
      refresh();
    });
  });

  // View toggle (list / cards)
  function syncViewBtns() {
    const view = state._modelsView || 'list';
    container.querySelectorAll('.mp-view-btn').forEach(b => {
      b.classList.toggle('mp-view-btn--active', b.dataset.view === view);
    });
  }
  syncViewBtns();
  container.querySelectorAll('.mp-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state._modelsView = btn.dataset.view;
      try { localStorage.setItem('mp-models-view', state._modelsView); } catch {}
      syncViewBtns();
      refresh();
    });
  });

  // Selection: checkbox change (event delegation, survives grid re-renders)
  container.addEventListener('change', (e) => {
    const cb = e.target.closest('.mp-card-checkbox');
    if (!cb) return;
    if (cb.checked) state._selectedModels.add(cb.dataset.model);
    else state._selectedModels.delete(cb.dataset.model);
    syncSelectionUi();
  });

  // Select-all (visible models only)
  const selectAllBtn = container.querySelector('.mp-btn-select-all');
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', () => {
      const filtered = applyFilters(allModels, activeFilter(), activeQuery());
      // Skip embedding models — they're not profilable
      filtered
        .filter(m => !/embed|nomic|bert|bge|diagnostic/i.test(m.name))
        .forEach(m => state._selectedModels.add(m.name));
      syncSelectionUi();
    });
  }
  const clearSelBtn = container.querySelector('.mp-btn-select-clear');
  if (clearSelBtn) {
    clearSelBtn.addEventListener('click', () => {
      state._selectedModels.clear();
      syncSelectionUi();
    });
  }

  // Profile All on Host button
  const profileHostBtn = container.querySelector('.mp-btn-profile-host');
  if (profileHostBtn) {
    profileHostBtn.addEventListener('click', async () => {
      const hostId = state._modelsHostId;
      if (!hostId) { showToast('Select a host first', 'error'); return; }
      const existing = state._hostQueue;
      if (existing?.queueId && existing.status === 'running') {
        const banner = container.querySelector('.mp-host-queue-banner');
        if (banner) banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
      const selection = Array.from(state._selectedModels || []);
      const usingSelection = selection.length > 0;
      const hostName = container.querySelector('#mp-models-host-select')?.selectedOptions?.[0]?.textContent?.trim() || hostId;
      const result = await openProfileHostDialog({
        hostName,
        showSkipRecent: !usingSelection,
        modelCount: usingSelection ? selection.length : 0
      });
      if (!result) return;
      const { depth, skipRecentDays } = result;

      profileHostBtn.disabled = true;
      profileHostBtn.textContent = 'Queueing…';
      try {
        const payload = { hostId, depth, skipRecentDays };
        if (usingSelection) payload.modelNames = selection;
        const res = await api.startHostProfileQueue(payload);
        const data = res?.data || res;
        state._hostQueue = {
          queueId: data.queueId,
          hostId,
          hostName: container.querySelector('#mp-models-host-select')?.selectedOptions?.[0]?.textContent?.trim() || hostId,
          depth: data.depth || depth,
          status: 'running',
          total: data.total,
          models: (data.models || []).map(name => ({ name, status: 'pending' })),
          skippedRecent: data.skippedRecent || [],
          currentIndex: 0
        };
        _renderHostQueueBanner(container, state, api);
        _scheduleHostQueuePoll(container, state, api);
      } catch (err) {
        showToast(`Queue failed: ${err.message}`, 'error');
      } finally {
        profileHostBtn.disabled = false;
        syncSelectionUi();
      }
    });
  }

  // Register Model button
  const registerBtn = container.querySelector('#mp-btn-register');
  if (registerBtn) {
    registerBtn.addEventListener('click', () => {
      const name = prompt('Model name to register (e.g. llama3.2:3b):');
      if (!name || !name.trim()) return;
      registerBtn.disabled = true;
      registerBtn.textContent = 'Registering…';
      api.upsertModel(name.trim(), { name: name.trim() })
        .then(() => {
          registerBtn.textContent = '⊕ Register Model';
          registerBtn.disabled = false;
          // Re-render the whole tab to pick up the new model
          renderModels(container, state, api);
        })
        .catch(err => {
          showToast(`Register failed: ${err.message}`, 'error');
          registerBtn.textContent = '⊕ Register Model';
          registerBtn.disabled = false;
        });
    });
  }

  // Initial sync — reflect any selection carried over from a prior render
  syncSelectionUi();
}

function wireCardActions(container, api, state) {
  const getHostId = () => state?._modelsHostId || null;

  // Profile — inline depth chooser then pipeline call with animated step UI
  container.querySelectorAll('.mp-btn-profile').forEach(btn => {
    btn.addEventListener('click', () => {
      const modelName = btn.dataset.model;
      const hostId = getHostId();
      if (!modelName) return;
      if (!hostId) {
        _showFeedback(container, modelName, '<span class="mp-fb mp-fb--err">Select a host first</span>');
        return;
      }

      const feedbackEl = container.querySelector(`.mp-model-feedback[data-model="${CSS.escape(modelName)}"]`);
      if (!feedbackEl) return;

      if (feedbackEl.querySelector('.mp-depth-inline')) {
        feedbackEl.innerHTML = '';
        return;
      }

      _showFeedback(container, modelName, `
        <div class="mp-depth-inline">
          <div class="mp-depth-inline__title">Profiling Depth</div>
          <label class="mp-depth-option">
            <input type="radio" name="mp-depth-${CSS.escape(modelName)}" value="quick">
            <span class="mp-depth-option-label">Quick</span>
            <span class="mp-depth-option-est">~1 min</span>
          </label>
          <label class="mp-depth-option">
            <input type="radio" name="mp-depth-${CSS.escape(modelName)}" value="standard" checked>
            <span class="mp-depth-option-label">Standard</span>
            <span class="mp-depth-option-est">~5 min</span>
          </label>
          <label class="mp-depth-option">
            <input type="radio" name="mp-depth-${CSS.escape(modelName)}" value="full">
            <span class="mp-depth-option-label">Full</span>
            <span class="mp-depth-option-est">~15-20 min</span>
          </label>
          <div class="mp-depth-inline__actions">
            <button class="mp-action mp-btn-depth-cancel" type="button">Cancel</button>
            <button class="mp-action mp-action--teal mp-btn-start-profile" type="button">Start Profiling</button>
          </div>
        </div>
      `);

      const inlineEl = container.querySelector(`.mp-model-feedback[data-model="${CSS.escape(modelName)}"] .mp-depth-inline`);
      if (!inlineEl) return;

      inlineEl.querySelector('.mp-btn-depth-cancel')?.addEventListener('click', () => {
        const slot = container.querySelector(`.mp-model-feedback[data-model="${CSS.escape(modelName)}"]`);
        if (slot) slot.innerHTML = '';
      });

      inlineEl.querySelector('.mp-btn-start-profile')?.addEventListener('click', async () => {
        const depth = inlineEl.querySelector(`input[name="mp-depth-${CSS.escape(modelName)}"]:checked`)?.value || 'standard';
        const slot = container.querySelector(`.mp-model-feedback[data-model="${CSS.escape(modelName)}"]`);
        if (slot) slot.innerHTML = '';
        await _runProfiling(container, btn, modelName, hostId, depth, api);
      });
    });
  });

}

function wireSettings(container, api) {
  // Live slider updates
  const degradationEl = container.querySelector('#mp-set-degradation');
  const degradationVal = container.querySelector('#mp-set-degradation-val');
  if (degradationEl && degradationVal) {
    degradationEl.addEventListener('input', () => {
      degradationVal.textContent = degradationEl.value + '%';
    });
  }
  const ctxfillEl = container.querySelector('#mp-set-ctxfill');
  const ctxfillVal = container.querySelector('#mp-set-ctxfill-val');
  if (ctxfillEl && ctxfillVal) {
    ctxfillEl.addEventListener('input', () => {
      ctxfillVal.textContent = ctxfillEl.value + '%';
    });
  }
  const probefillEl = container.querySelector('#mp-set-probefill');
  const probefillVal = container.querySelector('#mp-set-probefill-val');
  if (probefillEl && probefillVal) {
    probefillEl.addEventListener('input', () => {
      probefillVal.textContent = probefillEl.value + '%';
    });
  }

  // Save button
  const saveBtn = container.querySelector('#mp-settings-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        await api.saveSettings({
          degradationThreshold: Number(container.querySelector('#mp-set-degradation')?.value ?? 30),
          contextProbeFillPct: Number(container.querySelector('#mp-set-probefill')?.value ?? 80),
          contextFillPct: Number(container.querySelector('#mp-set-ctxfill')?.value ?? 25),
          maxPromptTokens: Number(container.querySelector('#mp-set-maxprompt')?.value ?? 2048),
          numPredict: Number(container.querySelector('#mp-set-predtokens')?.value ?? 64),
          throughputSamples: Number(container.querySelector('#mp-set-samples')?.value ?? 3),
          collectHardwareTelemetry: container.querySelector('#mp-set-hw-collect')?.checked !== false,
          showHardwareDiagnostics: container.querySelector('#mp-set-hw-show')?.checked !== false,
          warmup: container.querySelector('#mp-set-warmup')?.checked !== false,
          testTimeoutSec: Number(container.querySelector('#mp-set-timeout')?.value ?? 60),
        });
        saveBtn.textContent = 'Saved ✓';
        setTimeout(() => { saveBtn.textContent = 'Save Settings'; saveBtn.disabled = false; }, 2000);
      } catch (err) {
        saveBtn.textContent = 'Save Failed';
        const errEl = container.querySelector('.mp-settings-error');
        if (errEl) errEl.textContent = err.message || 'Unknown error';
        setTimeout(() => { saveBtn.textContent = 'Save Settings'; saveBtn.disabled = false; }, 3000);
      }
    });
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function renderModels(container, state, api) {
  container.innerHTML = renderLoading();

  // Fetch settings + hosts in parallel
  let settings = {};
  let hosts = [];
  try {
    const [settingsRes, hostsRes] = await Promise.all([
      api.getSettings().catch(() => ({})),
      api.getHosts().catch(() => []),
    ]);
    settings = settingsRes || {};
    hosts = hostsRes || [];
    if (!Array.isArray(hosts)) hosts = [];
  } catch (_) {}

  const testedHosts = hosts.filter(h => h.baseline?.testedAt && h.status === 'online');
  const selectedHostId = state._modelsHostId || testedHosts[0]?.hostId || hosts[0]?.hostId || null;
  state._modelsHostId = selectedHostId;
  const selectedHost = hosts.find(h => h.hostId === selectedHostId);

  // Get models ON this host from Ollama, then enrich with profiler data
  let models = [];
  try {
    // Get live model list from the selected host
    let hostModels = [];
    if (selectedHostId) {
      const statusRes = await api.getHostStatus(selectedHostId).catch(() => null);
      hostModels = (statusRes?.models || [])
        .map(n => n.replace(/:latest$/i, ''));
    }

    // Get readiness plus exact-artifact performance evidence.
    const [profileRes, rosterRes] = await Promise.all([
      api.getModels(),
      api.getProfileEvidenceRoster({ hostId: selectedHostId }).catch(() => []),
    ]);
    const allProfiles = Array.isArray(profileRes) ? profileRes : (profileRes?.models || profileRes?.data?.models || profileRes?.data || []);
    const profileMap = new Map((allProfiles || []).map(m => [m.name, m]));
    const roster = Array.isArray(rosterRes) ? rosterRes : (rosterRes?.roster || rosterRes?.data || []);
    const hostRoster = selectedHostId
      ? roster.filter(a => a.hostId === selectedHostId)
      : roster;
    const evidenceMap = new Map(hostRoster.map(a => [a.modelName, a]));

    // Build model list: host models enriched with exact-artifact profile evidence.
    if (hostModels.length) {
      models = hostModels.map(name => {
        const storedProfile = profileMap.get(name) || {};
        const profile = {
          ...storedProfile,
          readiness: getReadinessForHost(storedProfile.readiness, selectedHostId)
        };
        const evidence = evidenceMap.get(name);
        if (evidence?.profile) profile.profile = { ...evidence.profile, _showHardwareDiagnostics: settings.showHardwareDiagnostics !== false };
        if (evidence) profile._evidence = evidence;
        return { name, ...profile };
      });
    } else {
      // Fallback: show all registered models if no host selected
      models = (allProfiles || []).map(profile => {
        const evidence = evidenceMap.get(profile.name);
        const next = {
          ...profile,
          readiness: getReadinessForHost(profile.readiness, selectedHostId)
        };
        if (evidence?.profile) next.profile = { ...evidence.profile, _showHardwareDiagnostics: settings.showHardwareDiagnostics !== false };
        if (evidence) next._evidence = evidence;
        return next;
      });
    }
  } catch (err) {
    container.innerHTML = renderError(`Failed to load models: ${err.message}`);
    return;
  }

  if (!Array.isArray(models)) models = [];

  // Restore persisted view preference (list / grid)
  if (!state._modelsView) {
    try {
      const saved = localStorage.getItem('mp-models-view');
      if (saved === 'list' || saved === 'grid') state._modelsView = saved;
    } catch {}
    state._modelsView = state._modelsView || 'list';
  }

  const filter  = state._modelsFilter || 'all';
  const query   = state._modelsQuery  || '';
  const visible = applyFilters(models, filter, query);

  container.innerHTML = `
    <div class="mp-section">
      <div class="mp-section-title mp-section-title--accent">
        Models
      </div>
      ${renderModelControls(hosts, selectedHostId, selectedHost, models)}
      ${renderTopBar(models, filter)}
      ${renderSettingsPanel(settings)}
      <div id="mp-model-grid-wrap">${renderGrid(visible, api, state._modelsView || 'list')}</div>
    </div>
  `;

  // Wire host selector
  const hostSelect = container.querySelector('#mp-models-host-select');
  if (hostSelect) {
    hostSelect.addEventListener('change', () => {
      state._modelsHostId = hostSelect.value;
      renderModels(container, state, api);
    });
  }

  wireTopBar(container, models, state, api);
  wireCardActions(container, api, state);
  wireSettings(container, api);

  // Reattach to any in-flight profile on this host after a page reload.
  _reattachActiveProfile(container, selectedHostId, api).catch(() => {});
  // Reattach to any in-flight per-host profile queue.
  _reattachHostQueue(container, selectedHostId, state, api).catch(() => {});
  // Re-render an already-active queue banner if the user just switched hosts back to it.
  if (state._hostQueue && state._hostQueue.hostId === selectedHostId) {
    _renderHostQueueBanner(container, state, api);
  }
}

// ─── Per-host profile queue UI ─────────────────────────────────────────────

const HOST_QUEUE_POLL_MS = 2500;

function _renderHostQueueBanner(container, state, api) {
  const queue = state._hostQueue;
  let banner = container.querySelector('.mp-host-queue-banner');
  if (!queue) { if (banner) banner.remove(); return; }

  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'mp-host-queue-banner';
    const grid = container.querySelector('#mp-model-grid-wrap');
    if (grid) grid.before(banner); else container.appendChild(banner);
  }

  const completed = queue.models.filter(m => m.status === 'completed').length;
  const failed = queue.models.filter(m => m.status === 'failed').length;
  const remaining = queue.models.filter(m => m.status === 'pending').length;
  const pct = queue.total > 0 ? Math.round(((completed + failed) / queue.total) * 100) : 0;
  const isDone = ['completed', 'failed', 'cancelled'].includes(queue.status);
  const statusColor = isDone
    ? (queue.status === 'completed' ? '#2ecc71' : queue.status === 'cancelled' ? '#f39c12' : '#ef5350')
    : '#58a6ff';
  const current = queue.models.find(m => m.status === 'running');

  const pills = queue.models.map(m => {
    const c = m.status === 'completed' ? '#2ecc71'
            : m.status === 'failed'    ? '#ef5350'
            : m.status === 'running'   ? '#58a6ff'
            : '#666';
    return `<span class="mp-fleet-pill" style="border-color:${c}55;color:${c};background:${c}14;" title="${m.error ? String(m.error).replace(/"/g,'&quot;') : ''}">
      ${m.name}${m.status === 'failed' ? ' ✗' : m.status === 'completed' ? ' ✓' : ''}
    </span>`;
  }).join('');

  const skippedNote = queue.skippedRecent?.length
    ? `<span style="color:var(--r-text-muted,#888);font-size:0.6rem;">${queue.skippedRecent.length} skipped (recently profiled)</span>`
    : '';

  banner.innerHTML = `
    <div class="mp-fleet-banner-row">
      <span class="mp-fleet-status" style="color:${statusColor};border-color:${statusColor}55;background:${statusColor}14;">
        Profile queue · ${queue.status} · ${queue.depth}
      </span>
      <span style="color:var(--r-text-primary,#e0e0e0);font-size:0.7rem;">
        ${queue.hostName || queue.hostId} · ${completed + failed}/${queue.total} (${pct}%)
      </span>
      ${current ? `<span style="color:var(--r-text-muted,#888);font-size:0.65rem;">
        Now: <strong style="color:var(--r-text-primary,#e0e0e0);">${current.name}</strong>
      </span>` : ''}
      ${skippedNote}
      <span style="flex:1;"></span>
      ${!isDone ? `<button class="mp-action mp-host-queue-cancel" style="font-size:0.65rem;">${queue.cancelled ? 'Cancelling…' : 'Cancel queue'}</button>` : ''}
      ${isDone ? `<button class="mp-action mp-host-queue-dismiss" style="font-size:0.65rem;">Dismiss</button>` : ''}
    </div>
    <div class="mp-fleet-bar"><div class="mp-fleet-bar-fill" style="width:${pct}%;background:${statusColor};"></div></div>
    <div class="mp-fleet-pills">${pills}</div>
    ${queue.error ? `<div style="color:#ef5350;font-size:0.65rem;margin-top:0.4rem;">${queue.error}</div>` : ''}
  `;

  // Wire cancel/dismiss
  const cancelBtn = banner.querySelector('.mp-host-queue-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async () => {
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Cancelling…';
      try {
        await api.cancelHostProfileQueue(queue.queueId);
        state._hostQueue.cancelled = true;
        _renderHostQueueBanner(container, state, api);
      } catch (err) {
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Cancel queue';
        showToast(`Cancel failed: ${err.message}`, 'error');
      }
    });
  }
  const dismissBtn = banner.querySelector('.mp-host-queue-dismiss');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      _clearHostQueueTimer(state);
      state._hostQueue = null;
      banner.remove();
    });
  }
}

function _clearHostQueueTimer(state) {
  if (state._hostQueueTimer) { clearTimeout(state._hostQueueTimer); state._hostQueueTimer = null; }
}

function _scheduleHostQueuePoll(container, state, api) {
  _clearHostQueueTimer(state);
  state._hostQueueTimer = setTimeout(() => _pollHostQueue(container, state, api), HOST_QUEUE_POLL_MS);
}

async function _pollHostQueue(container, state, api) {
  const queue = state._hostQueue;
  if (!queue?.queueId) return;
  try {
    const res = await api.getHostProfileQueueProgress(queue.queueId);
    const data = res?.data || res || {};
    state._hostQueue = {
      ...queue,
      status: data.queueStatus || 'running',
      cancelled: !!data.cancelled,
      currentIndex: data.currentIndex ?? 0,
      total: data.total ?? queue.total,
      models: data.models || queue.models,
      summary: data.summary || null,
      error: data.error || null
    };
    _renderHostQueueBanner(container, state, api);

    // Auto-attach the rich per-model progress panel to whichever model the
    // queue is currently running. Without this, queue users only see the
    // compact pills banner and lose the ribbon / hero stat / activity log.
    const running = state._hostQueue.models?.find(m => m.status === 'running');
    if (running && state._attachedQueueModel !== running.name && !container.querySelector('#mp-prof-panel-wrap')) {
      state._attachedQueueModel = running.name;
      _reattachActiveProfile(container, state._hostQueue.hostId, api).catch(() => {});
    } else if (!running) {
      state._attachedQueueModel = null;
    }

    if (['completed', 'failed', 'cancelled'].includes(state._hostQueue.status)) {
      _clearHostQueueTimer(state);
      state._attachedQueueModel = null;
      // Re-render the model grid so freshly-profiled models pick up new readiness
      renderModels(container, state, api);
      return;
    }
    _scheduleHostQueuePoll(container, state, api);
  } catch (err) {
    state._hostQueue = { ...queue, status: 'failed', error: err.message };
    _clearHostQueueTimer(state);
    _renderHostQueueBanner(container, state, api);
  }
}

async function _reattachHostQueue(container, selectedHostId, state, api) {
  if (!selectedHostId || !api?.getActiveHostProfileQueues) return;
  let active;
  try { active = await api.getActiveHostProfileQueues(); } catch { return; }
  const list = active?.active || [];
  const match = list.find(q => q.hostId === selectedHostId);
  if (!match?.queueId) return;
  try {
    const res = await api.getHostProfileQueueProgress(match.queueId);
    const data = res?.data || res;
    state._hostQueue = {
      queueId: match.queueId,
      hostId: match.hostId,
      hostName: container.querySelector('#mp-models-host-select')?.selectedOptions?.[0]?.textContent?.trim() || match.hostId,
      depth: data.depth || match.depth,
      status: data.queueStatus || 'running',
      total: data.total,
      models: data.models || [],
      currentIndex: data.currentIndex ?? 0,
      skippedRecent: data.skippedRecent || [],
      cancelled: !!data.cancelled
    };
    _renderHostQueueBanner(container, state, api);
    _scheduleHostQueuePoll(container, state, api);
  } catch (_) {}
}

async function _reattachActiveProfile(container, selectedHostId, api) {
  if (!selectedHostId || !api?.getActiveProfiles) return;
  let active;
  try { active = await api.getActiveProfiles(); } catch { return; }
  const list = active?.active || [];
  if (!list.length) return;
  // Prefer a match for the currently selected host; fall back to first running.
  const match = list.find(j => j.hostId === selectedHostId) || list[0];
  if (!match?.profileId) return;
  const startedAtMs = match.startedAt || (Date.now() - (match.elapsed || 0));
  // Find the model's Profile button so we can keep labels in sync when the run finishes.
  const btn = container.querySelector(`.mp-btn-profile[data-model="${CSS.escape(match.modelName)}"]`) || null;
  _runProfiling(container, btn, match.modelName, match.hostId, match.depth || 'standard', api, {
    existingProfileId: match.profileId,
    startedAtMs
  });
}
