// index.js — Benchmark v2 entry point (The Engine Room)
// State machine: IDLE ↔ LIVE, polling via PollingController.
// No exports — this is the page entry point.

import { PollingController }    from '../utils/polling-controller.js';
import {
    fetchActiveBatch,
    fetchBatchProgress,
    fetchTimeline,
    fetchHosts,
    fetchProfilerHosts,
    fetchProfilerModels,
    fetchProfilerDashboard,
    fetchPrompts,
    fetchConfig,
    fetchBenchmarkTargets,
    fetchBatches,
    fetchJudgeRoster,
    startBatch,
    stopBatch,
    fetchResumableBatch,
    dismissResumableBatch,
    resumeBatch,
} from './api.js';
import {
    renderActionZoneIdle,
    renderActionZoneLive,
    updatePipelineBar,
    startElapsedTimer,
    stopElapsedTimer,
} from './action-zone.js';
import { renderHostSelection, getSelectedHost } from './infrastructure.js';
import { renderBatchConfig }               from './batch-config.js';
import { renderLaunchSummary, updateLaunchSummary, renderResumeBanner } from './launch-summary.js';
import { renderBatchCard, updateBatchCard } from './batch-card.js';
import { renderLiveDetail, updateLiveDetail } from './live-detail.js';
import { renderModelArena, updateModelArena } from './model-arena.js';
import { renderAnomalies, updateAnomalies }   from './anomalies.js';
import { renderEventLog, appendEvents }        from './event-log.js';
import { showFatalError }                      from '../components/error-banner.js';
import { showToast }                           from '../components/toast.js';
import { ensureBv2Schema, esc }                from './helpers.js';
import { getSelectedJudge }                    from './judge-roster.js';


// ── Module state ─────────────────────────────────────────────────────────────

/** @type {PollingController|null} */
let _poller = null;

/** @type {PollingController|null} Idle-mode poller — checks for batches launched out-of-band */
let _idlePoller = null;

/** @type {boolean} Guard against overlapping idle-mode active-batch checks */
let _idlePollRequestInFlight = false;

/** @type {number} Session id used to ignore stale idle-poll responses after mode changes */
let _idlePollSession = 0;

/** @type {number} Token used to ignore stale async idle renders after mode changes */
let _idleRenderToken = 0;

/** @type {string|null} Active batch id */
let _batchId = null;

/** @type {number|null} Pending timeout id for delayed transition back to idle */
let _idleTransitionTimer = null;

/** @type {number} Live-session token used to ignore stale async terminal handling */
let _liveSession = 0;

/** @type {Set<string>} Batch ids that already emitted a terminal toast */
const _announcedTerminalBatches = new Set();

/** @type {Set<string>} Keys of already-seen timeline entries */
const _seenEvents = new Set();

/** @type {string|null} Last observed current_test.stage */
let _lastStage = null;

/** @type {HTMLElement|null} Active error banner element */
let _errorBannerEl = null;

/** @type {'poll'|'action'|'general'|null} What produced the active error banner */
let _errorBannerKind = null;

/** @type {boolean} Prevent duplicate stop requests while acknowledgement is pending */
let _stopRequestInFlight = false;

/** @type {{state:string,message:string,detail:string}|null} Transient launch/preflight status for the sticky dock */
let _launchStatusOverride = null;

// ── DOM element references (resolved once on DOMContentLoaded) ───────────────

let $actionZone     = null;
let $idleSections   = null;
let $liveSections   = null;
let $batchCard      = null;
let $liveDetail     = null;
let $modelArena     = null;
let $anomalies      = null;
let $eventLog       = null;
let $infrastructure = null;
let $batchConfig    = null;
let $launchSummary  = null;
let $workflowGuide  = null;
let $launchDock     = null;
let $btnStop        = null;
let $stopStatus     = null;

/** @type {Array} Profiler model profiles */
let _modelProfiles  = [];

/** @type {Array<string>} Base model names with successful benchmark history */
let _benchmarkedModels = [];

function _resolveElements() {
    $actionZone     = document.getElementById('action-zone');
    $idleSections   = document.getElementById('idle-sections');
    $liveSections   = document.getElementById('live-sections');
    $batchCard      = document.getElementById('batch-card');
    $liveDetail     = document.getElementById('live-detail');
    $modelArena     = document.getElementById('model-arena');
    $anomalies      = document.getElementById('anomalies');
    $eventLog       = document.getElementById('event-log');
    $infrastructure = document.getElementById('host-cards');
    $batchConfig    = document.getElementById('batch-config');
    $launchSummary  = document.getElementById('launch-summary');
    $workflowGuide  = document.getElementById('workflow-guide');
    $launchDock     = document.getElementById('launch-dock');
    $btnStop        = document.getElementById('btn-stop');
    $stopStatus     = document.getElementById('stop-status');
}

// ── Error display helpers ─────────────────────────────────────────────────────

/**
 * Show a fatal error banner using the shared component.
 * @param {string}   message
 * @param {Function} [onRetry]
 */
function _showErrorBanner(message, onRetry, kind = 'general') {
    _clearErrorBanner();
    _errorBannerEl = showFatalError(`Error: ${message}`);
    _errorBannerKind = kind;
    if (typeof onRetry === 'function') {
        const btn = document.createElement('button');
        btn.textContent = 'Retry';
        btn.style.cssText = 'margin-left:0.75rem;border:1px solid currentColor;background:none;color:inherit;border-radius:4px;padding:0.2rem 0.5rem;cursor:pointer;font-size:0.85em;';
        btn.addEventListener('click', () => {
            _clearErrorBanner();
            onRetry();
        });
        _errorBannerEl.appendChild(btn);
    }
}

function _clearErrorBanner() {
    if (_errorBannerEl) {
        _errorBannerEl.remove();
        _errorBannerEl = null;
    }
    _errorBannerKind = null;
}

function _clearPollingErrorBanner() {
    if (_errorBannerKind === 'poll') _clearErrorBanner();
}

function _setStopControl(state = 'ready', message = '') {
    if ($btnStop) {
        $btnStop.disabled = state === 'pending';
        $btnStop.dataset.stopState = state;
        $btnStop.textContent = state === 'pending'
            ? 'Stopping\u2026'
            : state === 'failed'
                ? 'Retry stop'
                : 'Stop';
    }
    if ($stopStatus) {
        $stopStatus.textContent = message;
        $stopStatus.hidden = !message;
    }
}

function _clearIdleTransitionTimer() {
    if (_idleTransitionTimer != null) {
        clearTimeout(_idleTransitionTimer);
        _idleTransitionTimer = null;
    }
}

function _estimateSelectedPromptCount() {
    if (!$batchConfig) return 0;
    const levelPrompts = { 1: 14, 2: 21, 3: 21, 4: 21, 5: 7 };
    const levelCats = { 1: 7, 2: 7, 3: 7, 4: 7, 5: 7 };
    let total = 0;
    $batchConfig.querySelectorAll('.bv2-depth-radio:checked').forEach((radio) => {
        const level = parseInt(radio.dataset.level, 10);
        const depth = radio.dataset.depth;
        if (depth === 'single') total += 1;
        else if (depth === 'light') total += levelCats[level] || 7;
        else if (depth === 'full') total += levelPrompts[level] || 7;
    });
    return total;
}

function _getWorkflowState() {
    const host = $infrastructure ? getSelectedHost($infrastructure) : null;
    const modelCount = $batchConfig ? $batchConfig.querySelectorAll('.bv2-model-cb:checked').length : 0;
    const localModelCount = $batchConfig ? $batchConfig.querySelectorAll('.bv2-model-cb:checked:not([data-execution-kind="harness"])').length : 0;
    const cloudModelCount = modelCount - localModelCount;
    const judge = $batchConfig ? getSelectedJudge($batchConfig) : {};
    const promptCount = _estimateSelectedPromptCount();
    const testCount = modelCount * promptCount;

    let blockedReason = '';
    if (!host && localModelCount > 0) blockedReason = 'Select an execution host';
    else if (modelCount === 0) blockedReason = 'Select at least one profiled model';
    else if (!judge.model) blockedReason = 'Choose a judge model';
    else if (promptCount <= 0) blockedReason = 'Enable at least one test level';

    return {
        host,
        modelCount,
        localModelCount,
        cloudModelCount,
        judge,
        promptCount,
        testCount,
        ready: !blockedReason,
        blockedReason,
        hostName: host?.displayName || host?.name || host?.hostname || (cloudModelCount > 0 ? 'Cloud harnesses' : ''),
    };
}

function _setWorkflowStep(step, state, meta) {
    if (!$workflowGuide) return;
    const el = $workflowGuide.querySelector(`[data-wf-step="${step}"]`);
    if (!el) return;
    el.classList.remove('wf-current', 'wf-done', 'wf-locked');
    el.classList.add(`wf-${state}`);
    const metaEl = el.querySelector('.wf-meta');
    if (metaEl && meta) metaEl.textContent = meta;
}

function _setSectionSummary(section, visible, summary, actionLabel, statusLabel = 'Done') {
    if (!section) return;
    let summaryEl = section.querySelector(':scope > .workflow-section-summary');
    if (!visible) {
        summaryEl?.remove();
        return;
    }
    if (!summaryEl) {
        summaryEl = document.createElement('div');
        summaryEl.className = 'workflow-section-summary';
        const head = section.querySelector(':scope > .r-sec-head, :scope > .bf-section-header');
        if (head) head.after(summaryEl);
        else section.prepend(summaryEl);
    }
    summaryEl.innerHTML = `
      <span class="wfs-status">${esc(statusLabel)}</span>
      <span class="wfs-copy">${esc(summary)}</span>
      <button type="button" class="wfs-action" data-workflow-expand="${esc(section.id)}">${esc(actionLabel)}</button>`;
}

function _updateCompactSections(state) {
    const infraSection = document.getElementById('infrastructure');
    const configSection = document.getElementById('batch-config');

    if (infraSection) {
        const hostKey = state.host?.hostId || state.host?.hostUrl || state.host?.url || state.hostName || '';
        if (infraSection.dataset.workflowHostKey !== hostKey) {
            infraSection.dataset.workflowHostKey = hostKey;
            delete infraSection.dataset.workflowExpanded;
        }
        const compactHost = !!state.host && state.modelCount > 0 && infraSection.dataset.workflowExpanded !== 'true';
        infraSection.classList.toggle('wf-section-compact', compactHost);
        _setSectionSummary(
            infraSection,
            !!state.host,
            `${state.hostName || 'Selected host'} selected`,
            compactHost ? 'Change' : 'Collapse',
            'Done'
        );
    }

    if (configSection) {
        const hasConfig = state.modelCount > 0 || !!state.judge?.model;
        const summaryParts = [];
        if (state.modelCount > 0) summaryParts.push(`${state.modelCount} model${state.modelCount === 1 ? '' : 's'}`);
        if (state.judge?.model) summaryParts.push(`judge ${state.judge.model}`);
        if (state.promptCount > 0) summaryParts.push(`${state.promptCount} prompts`);
        _setSectionSummary(
            configSection,
            hasConfig,
            summaryParts.join(' • ') || state.blockedReason,
            'Review',
            state.ready ? 'Ready' : 'Set'
        );
    }
}

function _clearLaunchStatusOverride() {
    _launchStatusOverride = null;
}

function _setLaunchDockOverride(state, override) {
    if (!$launchDock || !override) return true;
    const title = $launchDock.querySelector('#ldock-title');
    const meta = $launchDock.querySelector('#ldock-meta');
    const btn = $launchDock.querySelector('#ldock-launch-btn');
    const isBusy = ['checking', 'preflight', 'launching'].includes(override.state);
    const isBlocked = override.state === 'blocked';

    $launchDock.classList.toggle('ldock-ready', false);
    $launchDock.classList.toggle('ldock-blocked', isBlocked);
    $launchDock.classList.toggle('ldock-busy', isBusy);
    if (title) {
        if (override.state === 'preflight') title.textContent = 'Running preflight';
        else if (override.state === 'launching') title.textContent = 'Launching';
        else if (override.state === 'checking') title.textContent = 'Checking launch';
        else if (override.state === 'blocked') title.textContent = 'Blocked';
        else title.textContent = override.message || (state.ready ? 'Ready to launch' : 'Blocked');
    }
    if (meta) meta.textContent = override.detail || override.message || state.blockedReason;
    if (btn) {
        btn.disabled = isBusy || !state.ready;
        if (override.state === 'preflight') btn.textContent = 'Checking';
        else if (override.state === 'launching') btn.textContent = 'Launching';
        else if (override.state === 'checking') btn.textContent = 'Checking';
        else btn.textContent = state.ready ? 'Launch' : 'Blocked';
    }
    return true;
}

function _updateLaunchDock(state) {
    if (!$launchDock) return;
    const title = $launchDock.querySelector('#ldock-title');
    const meta = $launchDock.querySelector('#ldock-meta');
    const btn = $launchDock.querySelector('#ldock-launch-btn');
    const readyMeta = `${state.modelCount} model${state.modelCount === 1 ? '' : 's'} • ${state.promptCount} prompts • ~${state.testCount} tests`;

    if (_launchStatusOverride && _setLaunchDockOverride(state, _launchStatusOverride)) return;

    $launchDock.classList.toggle('ldock-busy', false);
    $launchDock.classList.toggle('ldock-ready', state.ready);
    $launchDock.classList.toggle('ldock-blocked', !state.ready);
    if (title) title.textContent = state.ready ? 'Ready to launch' : 'Blocked';
    if (meta) meta.textContent = state.ready ? readyMeta : state.blockedReason;
    if (btn) {
        btn.disabled = !state.ready;
        btn.textContent = state.ready ? 'Launch' : 'Blocked';
    }
}

function _updateWorkflowGuide() {
    const state = _getWorkflowState();

    if (!$workflowGuide) {
        _updateLaunchDock(state);
        _updateCompactSections(state);
        return;
    }

    _setWorkflowStep('host', state.host ? 'done' : 'current', state.host ? state.hostName : 'Select execution target');
    _setWorkflowStep(
        'models',
        (!state.host && state.cloudModelCount === 0) ? 'locked' : state.modelCount > 0 ? 'done' : 'current',
        (!state.host && state.cloudModelCount === 0) ? 'Waiting for host or cloud target' : state.modelCount > 0 ? `${state.modelCount} selected` : 'Pick contenders'
    );
    _setWorkflowStep(
        'tests',
        !state.host || state.modelCount === 0 ? 'locked' : state.judge.model && state.promptCount > 0 ? 'done' : 'current',
        !state.host || state.modelCount === 0 ? 'Waiting for models' : state.judge.model ? `${state.promptCount} prompts` : 'Choose judge'
    );
    _setWorkflowStep(
        'launch',
        state.ready ? 'current' : 'locked',
        state.ready ? `~${state.testCount} tests ready` : state.blockedReason
    );

    _updateLaunchDock(state);
    _updateCompactSections(state);
}

function _wireWorkflowGuide() {
    if (!$workflowGuide) return;
    $workflowGuide.addEventListener('click', (event) => {
        const link = event.target.closest('a[href^="#"]');
        if (!link) return;
        const target = document.querySelector(link.getAttribute('href'));
        if (!target) return;
        event.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
}

function _wireWorkflowActions() {
    document.addEventListener('click', (event) => {
        const expandBtn = event.target.closest('[data-workflow-expand]');
        if (expandBtn) {
            const section = document.getElementById(expandBtn.dataset.workflowExpand);
            if (section) {
                section.dataset.workflowExpanded = section.classList.contains('wf-section-compact') ? 'true' : 'false';
                section.classList.toggle('wf-section-compact', false);
                section.scrollIntoView({ behavior: 'smooth', block: 'start' });
                _updateWorkflowGuide();
            }
            return;
        }

        const dockLaunch = event.target.closest('#ldock-launch-btn');
        if (!dockLaunch || dockLaunch.disabled) return;
        const launchBtn = document.getElementById('ls-launch-btn');
        launchBtn?.click();
    });
}

function _handleWorkflowInputChanged() {
    _clearLaunchStatusOverride();
    _updateWorkflowGuide();
}

function _handleLaunchStatusChanged(event) {
    const detail = event.detail || {};
    _launchStatusOverride = {
        state: detail.state || 'checking',
        message: detail.message || '',
        detail: detail.detail || '',
    };
    _updateWorkflowGuide();
}

function _publishLaunchStatus(state, message, detail = '') {
    const statusEl = document.getElementById('ls-launch-status');
    if (statusEl) {
        statusEl.dataset.launchState = state;
        statusEl.className = `ls-launch-status ls-launch-${state}`;
        statusEl.innerHTML = `
          <span class="ls-launch-status-kicker">${esc(message)}</span>
          ${detail ? `<span class="ls-launch-status-detail">${esc(detail)}</span>` : ''}`;
    }
    document.dispatchEvent(new CustomEvent('benchmark-launch-status', {
        detail: { state, message, detail }
    }));
}

// ── IDLE state ────────────────────────────────────────────────────────────────

const IDLE_POLL_INTERVAL_MS = 10000;

function _extractActiveBatch(res) {
    const batches = res?.data || res || [];
    const activeBatch = Array.isArray(batches) ? batches[0] : batches;
    return activeBatch && (activeBatch._id || activeBatch.batch_id) ? activeBatch : null;
}

function _renderIdlePollingStatus() {
    if (!$actionZone) return;

    const idleRow = $actionZone.querySelector('#az-idle');
    if (!idleRow) return;

    let statusEl = idleRow.querySelector('[data-idle-poll-status]');
    if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.dataset.idlePollStatus = 'true';
        statusEl.textContent = 'Checking for active batches…';
        statusEl.style.cssText = [
            'font-size:0.72rem',
            'letter-spacing:0.08em',
            'text-transform:uppercase',
            'color:var(--r-text-dim)',
            'white-space:nowrap',
        ].join(';');
        const actions = idleRow.querySelector('.az-actions');
        idleRow.insertBefore(statusEl, actions || null);
    }
}

async function _checkForActiveBatchDuringIdle(sessionId) {
    if (_batchId || _idlePollRequestInFlight) return null;
    if (document.visibilityState !== 'visible') return null;

    _idlePollRequestInFlight = true;
    try {
        const activeBatch = _extractActiveBatch(await fetchActiveBatch());
        if (!activeBatch) return null;
        if (sessionId !== _idlePollSession || _batchId) return null;
        _enterLive(activeBatch);
        return activeBatch;
    } catch (_) {
        // Network hiccups are fine — we'll retry on the next tick.
        return null;
    } finally {
        _idlePollRequestInFlight = false;
    }
}

/** Poll /batches/active while idle so batches launched out-of-band transition the UI. */
function _startIdlePoll() {
    if (_idlePoller) return;

    const sessionId = ++_idlePollSession;
    _idlePoller = new PollingController();
    _idlePoller.addTask('active-batch', async () => {
        await _checkForActiveBatchDuringIdle(sessionId);
    }, IDLE_POLL_INTERVAL_MS, { runOnStart: true });
    _idlePoller.start();
}

function _stopIdlePoll() {
    _idlePollSession += 1;
    if (_idlePoller) {
        _idlePoller.destroy();
        _idlePoller = null;
    }
}

/**
 * Enter IDLE state.
 * Shows idle sections, hides live sections, renders infrastructure + config form.
 */
async function _enterIdle() {
    const idleRenderToken = ++_idleRenderToken;
    _clearIdleTransitionTimer();

    _stopPolling();
    _stopIdlePoll();
    stopElapsedTimer();
    _stopRequestInFlight = false;
    _setStopControl();
    _clearErrorBanner();
    _batchId   = null;
    _lastStage = null;
    _seenEvents.clear();

    if ($liveSections)  $liveSections.style.display  = 'none';
    if ($idleSections)  $idleSections.style.display  = '';
    document.body.classList.remove('state-live', 'state-error');
    _updateWorkflowGuide();

    // ── Fetch profiler data + legacy hosts in parallel ──
    let profilerHosts = [], legacyHosts = [];
    try {
        const [phRes, pmRes, dashRes, lhRes] = await Promise.all([
            fetchProfilerHosts().catch(() => null),
            fetchProfilerModels().catch(() => null),
            fetchProfilerDashboard().catch(() => null),
            fetchHosts().catch(() => null),
        ]);
        profilerHosts = phRes?.data || phRes || [];
        _modelProfiles = pmRes?.data || pmRes || [];
        _benchmarkedModels = dashRes?.data?.benchmarkedModels || dashRes?.benchmarkedModels || [];
        legacyHosts = lhRes?.hosts || lhRes || [];
        if (!Array.isArray(profilerHosts)) profilerHosts = [];
        if (!Array.isArray(_modelProfiles)) _modelProfiles = [];
        if (!Array.isArray(_benchmarkedModels)) _benchmarkedModels = [];
        if (!Array.isArray(legacyHosts)) legacyHosts = [];
    } catch (err) {
        console.warn('[bv2] data fetch failed:', err.message);
    }
    if (idleRenderToken !== _idleRenderToken || _batchId) return;

    if ($actionZone) renderActionZoneIdle($actionZone, legacyHosts);
    _renderIdlePollingStatus();

    // ── Section ① — Host Selection ──
    let selectedHost = null;
    if ($infrastructure) {
        try {
            selectedHost = await renderHostSelection($infrastructure, profilerHosts.length ? profilerHosts : null);
        } catch (err) {
            console.warn('[bv2] renderHostSelection failed:', err.message);
        }

        $infrastructure.addEventListener('host-selected', (e) => {
            _onHostChanged(e.detail.host);
        });
    }
    if (idleRenderToken !== _idleRenderToken || _batchId) return;

    // ── Sections ②③ — Batch Config ──
    await _renderBatchConfigForHost(selectedHost);
    _updateWorkflowGuide();
    if (idleRenderToken !== _idleRenderToken || _batchId) return;

    // ── Section ④ — Launch Summary ──
    if ($launchSummary) {
        renderLaunchSummary($launchSummary, {
            $infrastructure,
            $batchConfig,
            modelProfiles: _modelProfiles,
        });
        _updateWorkflowGuide();

        // Check for resumable batch (stopped/failed/interrupted)
        try {
            const resumable = await fetchResumableBatch();
            if (resumable && resumable._id) {
                renderResumeBanner($launchSummary, resumable, {
                    onResume: _handleResume,
                    onDiscard: (batch) => {
                        // Remember the dismissal so the banner doesn't return
                        // on the next idle re-render or page refresh.
                        dismissResumableBatch(batch?._id || batch?.id);
                    },
                });
            }
        } catch (err) {
            console.warn('[bv2] fetchResumableBatch failed:', err.message);
        }
    }
    if (idleRenderToken !== _idleRenderToken || _batchId) return;

    // Detect batches launched out-of-band (curl, other tab, remote script)
    // once the idle UI has finished rendering.
    _startIdlePoll();
}

/** Called when the user selects a different host in section ① */
async function _onHostChanged(host) {
    await _renderBatchConfigForHost(host);
    if ($launchSummary) {
        updateLaunchSummary($launchSummary, {
            $infrastructure,
            $batchConfig,
            modelProfiles: _modelProfiles,
        });
    }
    _updateWorkflowGuide();
}

/** Render/re-render sections ②③ for the given host */
async function _renderBatchConfigForHost(host) {
    if (!$batchConfig) return;

    let prompts = [], config = {}, judgeRoster = null, lastBatch = null, harnessTargets = [];
    try {
        const [promptsRes, configRes, rosterRes, batchesRes, targetsRes] = await Promise.all([
            fetchPrompts(),
            fetchConfig(),
            fetchJudgeRoster().catch(() => null),
            fetchBatches({ status: 'completed', limit: 1 }).catch(() => null),
            fetchBenchmarkTargets().catch(() => null),
        ]);
        prompts = promptsRes?.data?.prompts || promptsRes?.data || [];
        const rawCfg = configRes?.data || {};
        const jc = rawCfg.judge_config || {};
        config = { ...rawCfg, judge_model: jc.model, judge_host: jc.host };
        judgeRoster = rosterRes?.data || null;
        const batches = batchesRes?.data?.batches || [];
        lastBatch = batches[0] || null;
        harnessTargets = targetsRes?.data?.targets || targetsRes?.targets || [];
    } catch (err) {
        console.warn('[bv2] fetchPrompts/fetchConfig failed:', err.message);
    }

    try {
        renderBatchConfig($batchConfig, {
            host,
            modelProfiles: _modelProfiles,
            benchmarkedModels: _benchmarkedModels,
            prompts,
            config,
            judgeRoster,
            lastBatch,
            harnessTargets,
            onLaunch: _handleLaunch,
        });
        _updateWorkflowGuide();
    } catch (err) {
        console.warn('[bv2] renderBatchConfig failed:', err.message);
    }
}

// ── LIVE state ────────────────────────────────────────────────────────────────

/**
 * Enter LIVE state with the given batch.
 * Shows live sections, starts polling, wires stop button.
 *
 * @param {object} batch — initial batch data
 */
function _enterLive(batch) {
    _clearIdleTransitionTimer();
    _idleRenderToken += 1;
    _stopIdlePoll();
    _batchId   = batch._id || batch.batch_id || batch.id;
    _liveSession += 1;
    _lastStage = batch.current_test ? batch.current_test.stage : null;
    _seenEvents.clear();
    _stopRequestInFlight = false;
    _setStopControl();

    if ($idleSections) $idleSections.style.display  = 'none';
    if ($liveSections) $liveSections.style.display  = '';
    document.body.classList.remove('state-error');
    document.body.classList.add('state-live');

    if ($actionZone) {
        renderActionZoneLive($actionZone, batch);
        startElapsedTimer(batch.started_at ? new Date(batch.started_at).getTime() : null);
    }

    if ($batchCard)   renderBatchCard($batchCard, batch);
    if ($liveDetail)  renderLiveDetail($liveDetail, batch);
    if ($modelArena)  renderModelArena($modelArena, batch);
    if ($anomalies)   renderAnomalies($anomalies, batch);
    if ($eventLog)    renderEventLog($eventLog);

    if ($btnStop) {
        // Browsers ignore duplicate registrations for the same callback, so this
        // remains one listener while preserving an explicit retry after failure.
        $btnStop.addEventListener('click', _handleStop);
    }

    _startPolling(_batchId);
}

// ── Polling ───────────────────────────────────────────────────────────────────

const POLL_INTERVAL_EXEC   = 2000;
const POLL_INTERVAL_JUDGE  = 5000;

/** @type {EventSource|null} */
let _sseSource = null;

function _startPolling(batchId) {
    _stopPolling();

    // Try SSE first
    if (typeof EventSource !== 'undefined') {
        try {
            _sseSource = new EventSource(`/api/benchmark/batch/${batchId}/stream`);

            _sseSource.addEventListener('progress', (e) => {
                try {
                    const batch = JSON.parse(e.data);
                    // SSE gives lightweight progress. Still need full poll for results array.
                    _pollBatch(batchId);
                } catch (err) {
                    console.warn('[bv2] SSE progress parse error:', err);
                }
            });

            _sseSource.addEventListener('done', () => {
                _pollBatch(batchId); // One final full poll
            });

            _sseSource.addEventListener('error', () => {
                // Fall back to polling if SSE fails
                if (_sseSource) { _sseSource.close(); _sseSource = null; }
                _startPollingFallback(batchId);
            });
            return;
        } catch (_) {
            // SSE not supported, fall back
        }
    }

    _startPollingFallback(batchId);
}

function _startPollingFallback(batchId) {
    _stopPolling();
    _poller = new PollingController();

    _poller.addTask('batch-progress', async () => {
        await _pollBatch(batchId);
    }, POLL_INTERVAL_EXEC, { runOnStart: false });

    _poller.start();
}

function _stopPolling() {
    if (_sseSource) {
        _sseSource.close();
        _sseSource = null;
    }
    if (_poller) {
        _poller.destroy();
        _poller = null;
    }
}

/**
 * Single poll cycle: fetch batch + timeline, update all live sections.
 * Individual update failures are caught and logged without crashing the loop.
 */
async function _pollBatch(batchId) {
    if (!batchId || (_batchId && batchId !== _batchId)) return;

    let batch;
    try {
        const res = await fetchBatchProgress(batchId);
        batch = res?.data || res;
        _clearPollingErrorBanner();
    } catch (err) {
        _showErrorBanner(err.message, () => _pollBatch(batchId), 'poll');
        return;
    }

    // ── Update live sections (each wrapped independently) ──
    try { if ($actionZone) renderActionZoneLive($actionZone, batch); }
    catch (e) { console.warn('[bv2] renderActionZoneLive update failed:', e); }

    try { updatePipelineBar(batch); }
    catch (e) { console.warn('[bv2] updatePipelineBar failed:', e); }

    try { if ($batchCard)  updateBatchCard($batchCard, batch); }
    catch (e) { console.warn('[bv2] updateBatchCard failed:', e); }

    try { if ($liveDetail) updateLiveDetail($liveDetail, batch); }
    catch (e) { console.warn('[bv2] updateLiveDetail failed:', e); }

    try { if ($modelArena) updateModelArena($modelArena, batch); }
    catch (e) { console.warn('[bv2] updateModelArena failed:', e); }

    try { if ($anomalies)  updateAnomalies($anomalies, batch); }
    catch (e) { console.warn('[bv2] updateAnomalies failed:', e); }

    // ── Timeline / event log ──
    try {
        const tlRes = await fetchTimeline(batchId);
        const tlData = tlRes?.data || tlRes || {};
        const timeline = tlData.timeline || (Array.isArray(tlData) ? tlData : []);
        if ($eventLog) appendEvents($eventLog, timeline, _seenEvents);
    } catch (e) {
        console.warn('[bv2] fetchTimeline / appendEvents failed:', e);
    }

    // ── Adaptive poll interval based on stage ──
    _adaptPollInterval(batch);

    // ── Terminal state check ──
    const status = batch.status;
    if (status === 'completed' || status === 'failed' || status === 'stopped') {
        const terminalBatchId = batch._id || batch.batch_id || batch.id || batchId;
        const liveSessionAtTerminal = _liveSession;
        _stopPolling();
        stopElapsedTimer();

        if (status === 'completed' && terminalBatchId && !_announcedTerminalBatches.has(terminalBatchId)) {
            _announcedTerminalBatches.add(terminalBatchId);
            // Build the toast content as a DOM fragment so the links render as
            // clickable anchors. Passing HTML as a string renders it literally
            // (toast.js escapes for XSS).
            const frag = document.createDocumentFragment();
            frag.appendChild(document.createTextNode('Batch complete — '));
            const links = [
                ['/leaderboard', 'Leaderboard'],
                ['/courthouse', 'Courthouse'],
                ['/results-explorer', 'Results']
            ];
            links.forEach(([href, label], i) => {
                const a = document.createElement('a');
                a.href = href;
                a.textContent = label;
                a.style.color = 'inherit';
                a.style.textDecoration = 'underline';
                frag.appendChild(a);
                if (i < links.length - 1) frag.appendChild(document.createTextNode(' · '));
            });
            showToast(frag, 'success', 15000);
        }

        // Brief delay so the final batch state is visible before transitioning
        _clearIdleTransitionTimer();
        _idleTransitionTimer = window.setTimeout(() => {
            if (_batchId !== terminalBatchId) return;
            if (_liveSession !== liveSessionAtTerminal) return;
            _enterIdle();
        }, 3000);
    }
}

/**
 * Switch poll interval between exec (2 s) and judge (5 s) based on stage
 * transition from 'executing' → 'judging'.
 */
function _adaptPollInterval(batch) {
    if (!_poller) return;

    const newStage = batch.current_test ? batch.current_test.stage : null;

    if (_lastStage === 'executing' && newStage === 'judging') {
        // Switch to slower interval
        _stopPolling();
        _poller = new PollingController();
        _poller.addTask('batch-progress', async () => {
            await _pollBatch(_batchId);
        }, POLL_INTERVAL_JUDGE, { runOnStart: false });
        _poller.start();
    }

    _lastStage = newStage;
}

// ── Event handlers ────────────────────────────────────────────────────────────

/**
 * Called by batch-config.js onLaunch callback with the assembled batch config.
 * Starts the batch and transitions to LIVE state.
 */
async function _handleLaunch(batchConfig) {
    let batch;
    try {
        const res = await startBatch(batchConfig);
        batch = res?.data || res;
    } catch (err) {
        // 409s carry a friendlier `message` plus structured context — prefer
        // it so the user sees WHAT owns the host, not just "conflict".
        const detail = err.payload?.message || err.message;
        if (err.status === 409 && err.payload?.active_profiling) {
            _showErrorBanner(detail, null);
            _publishLaunchStatus('blocked', 'Host is profiling', detail);
        } else if (err.status === 409 && err.payload?.active_batch) {
            const active = err.payload.active_batch;
            _showErrorBanner(detail, null);
            _publishLaunchStatus(
                'blocked',
                active.is_stuck ? 'Active batch looks stuck' : 'A batch is already running',
                detail
            );
        } else {
            _showErrorBanner(`Launch failed: ${detail}`, null);
            _publishLaunchStatus('blocked', 'Launch failed', detail);
        }
        return;
    }

    _publishLaunchStatus('live', 'Batch started', 'Switching to live execution view.');
    _enterLive(batch);
}

/**
 * Called when the user clicks "Resume Batch" on the resume banner.
 * Calls the resume API and transitions to LIVE state.
 */
async function _handleResume(batch) {
    const batchId = batch._id || batch.id;
    const btn = document.querySelector('.rb-resume-btn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Resuming\u2026';
        btn.style.opacity = '0.7';
    }

    try {
        const targets = Array.isArray(batch.targets) ? batch.targets : [];
        const paidCandidates = targets.filter(target => target?.tier === 'paid_cloud');
        const paidJudge = batch.judge_config?.target?.tier === 'paid_cloud'
            ? batch.judge_config.target
            : null;
        let paidApproval = null;
        if (paidCandidates.length > 0 || paidJudge) {
            const repeats = Math.max(1, Math.min(5, Number(batch.execution_config?.repeats) || 1));
            const promptCount = Math.max(1, Math.ceil(Number(batch.total_tests || 0) / Math.max(1, targets.length * repeats)));
            const callsPerTarget = promptCount * repeats;
            const judgeAttempts = Math.max(1, Math.min(6, Number(batch.judge_config?.max_retries ?? 2) + 1));
            const units = [
                ...paidCandidates.map(target => ({ target, calls: callsPerTarget })),
                ...(paidJudge ? [{ target: paidJudge, calls: targets.length * callsPerTarget * judgeAttempts }] : [])
            ];
            const inputTokens = Math.max(1, Number(batch.execution_config?.input_token_ceiling) || 32_000);
            const outputTokens = Math.max(1, Number(batch.execution_config?.response_max_tokens) || 32_000);
            const maxCalls = units.reduce((sum, unit) => sum + unit.calls, 0);
            const maxCostNanodollars = units.reduce((sum, { target, calls }) => {
                const price = target.pricing || {};
                const perCall = Number(price.callNanodollars || 0)
                    + Math.ceil(inputTokens * Number(price.inputNanodollarsPerMillion || 0) / 1_000_000)
                    + Math.ceil(outputTokens * Number(price.outputNanodollarsPerMillion || 0) / 1_000_000);
                return sum + calls * perCall;
            }, 0);
            if (!window.confirm(`Resume paid cloud benchmark\n\nNew one-batch ceiling (manual estimate): US$${(maxCostNanodollars / 1e9).toFixed(6)}\nCalls: ${maxCalls}\nTokens: ${maxCalls * (inputTokens + outputTokens)}\n\nApprove before any provider call?`)) {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = '\u25B6 Resume Batch';
                    btn.style.opacity = '';
                }
                return;
            }
            paidApproval = {
                confirmed: true,
                maxCalls,
                maxTokens: maxCalls * (inputTokens + outputTokens),
                maxCostNanodollars
            };
        }
        await resumeBatch(batchId, { paid_approval: paidApproval });
        // Fetch the refreshed batch to get running state
        const res = await fetchBatchProgress(batchId);
        const liveBatch = res?.data || res;
        _enterLive(liveBatch);
    } catch (err) {
        _showErrorBanner(`Resume failed: ${err.message}`, () => _handleResume(batch));
        if (btn) {
            btn.disabled = false;
            btn.textContent = '\u25B6 Resume Batch';
            btn.style.opacity = '';
        }
    }
}

/**
 * Called when the stop button is clicked.
 */
async function _handleStop() {
    if (!_batchId || _stopRequestInFlight) return false;

    const requestedBatchId = _batchId;
    const requestedLiveSession = _liveSession;
    _stopRequestInFlight = true;
    _setStopControl('pending', 'Waiting for stop acknowledgement\u2026');
    _clearErrorBanner();

    try {
        const response = await stopBatch(requestedBatchId);
        const acknowledgedStatus = response?.data?.status;
        const terminalStatuses = new Set(['stopped', 'completed', 'failed', 'interrupted']);
        if (response?.status !== 'success' || !terminalStatuses.has(acknowledgedStatus)) {
            throw new Error('The service did not acknowledge a terminal batch state');
        }

        // Ignore a late response from an older live session. It must never tear
        // down a newer batch that appeared while this request was outstanding.
        if (_batchId !== requestedBatchId || _liveSession !== requestedLiveSession) return false;

        _clearErrorBanner();
        showToast(response.message || 'Batch stopped', 'success', 8000);
        _stopPolling();
        stopElapsedTimer();
        await _enterIdle();
        return true;
    } catch (err) {
        console.warn('[bv2] stopBatch failed:', err.message);
        if (_batchId === requestedBatchId && _liveSession === requestedLiveSession) {
            const detail = err.payload?.message || err.payload?.error || err.message || 'Unknown error';
            const message = `Stop failed: ${detail}. The batch is still running.`;
            _setStopControl('failed', message);
            _showErrorBanner(message, () => _handleStop(), 'action');
        }
        return false;
    } finally {
        if (_batchId === requestedBatchId && _liveSession === requestedLiveSession) {
            _stopRequestInFlight = false;
            if ($btnStop?.dataset.stopState === 'pending') _setStopControl();
        }
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    ensureBv2Schema();
    _resolveElements();
    _wireWorkflowGuide();
    _wireWorkflowActions();
    document.addEventListener('benchmark-launch-status', _handleLaunchStatusChanged);

    $batchConfig?.addEventListener('change', _handleWorkflowInputChanged);
    $batchConfig?.addEventListener('config-changed', _handleWorkflowInputChanged);
    $infrastructure?.addEventListener('host-selected', _handleWorkflowInputChanged);

    let activeBatch = null;
    try {
        activeBatch = _extractActiveBatch(await fetchActiveBatch());
    } catch (err) {
        console.warn('[bv2] fetchActiveBatch failed:', err.message);
    }

    if (activeBatch) {
        _enterLive(activeBatch);
    } else {
        await _enterIdle();
    }
});
