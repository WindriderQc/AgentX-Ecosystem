// action-zone.js — manages the sticky Action Zone header for benchmark-v2.
// Handles both IDLE and LIVE states, pipeline bar fills, and elapsed timer.

let _elapsedTimer = null;
let _startTime = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatElapsed(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function formatEta(batch) {
    const { completed = 0, total_tests = 0 } = batch;
    if (!completed || !total_tests || !_startTime) return '';
    const elapsed = Date.now() - _startTime;
    const rate = completed / elapsed; // tests per ms
    const remaining = (total_tests - completed) / rate;
    if (!isFinite(remaining) || remaining < 0) return '';
    const secs = Math.round(remaining / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `ETA ${m}:${String(s).padStart(2, '0')}`;
}

function pct(num, den) {
    if (!den) return 0;
    return Math.min(100, Math.round((num / den) * 100));
}

// ── IDLE state ────────────────────────────────────────────────────────────────

/**
 * Render the idle action zone.
 * @param {HTMLElement} container — the #action-zone element (or a parent that contains #az-idle)
 * @param {Array}       hosts     — array of host objects from fetchHosts()
 */
export function renderActionZoneIdle(container, hosts) {
    const idleRow = container.querySelector('#az-idle');
    const liveRow = container.querySelector('#az-live');
    const pipeWrap = container.querySelector('#pipeline-bar-wrap');

    if (liveRow) liveRow.style.display = 'none';
    if (pipeWrap) pipeWrap.style.display = 'none';
    if (idleRow) idleRow.style.display = 'flex';

    // Populate host pills
    const pillsEl = container.querySelector('#host-pills');
    if (pillsEl) {
        pillsEl.innerHTML = '';
        (hosts || []).forEach(h => {
            const online = h.available === true || h.status === 'online' || h.online === true;
            const statusClass = online ? 'online' : 'offline';
            const modelCount = h.models ? h.models.length : (h.model_count || 0);
            const pill = document.createElement('div');
            pill.className = `az-host-pill ${statusClass}`;
            pill.innerHTML = `
                <span class="az-hp-dot ${statusClass}"></span>
                <span class="az-hp-name">${h.name || h.hostname || 'Host'}</span>
                <span class="az-hp-detail">${modelCount}m</span>
            `;
            pill.title = `${h.url || h.host || ''} — ${online ? 'online' : 'offline'}`;
            pillsEl.appendChild(pill);
        });
        if (!hosts || hosts.length === 0) {
            pillsEl.innerHTML = '<span style="font-size:0.65rem;color:var(--r-text-dim)">No hosts configured</span>';
        }
    }
}

// ── LIVE state ────────────────────────────────────────────────────────────────

/**
 * Render the live action zone.
 * @param {HTMLElement} container — the #action-zone element
 * @param {object}      batch     — batch status object from fetchBatchProgress()
 */
export function renderActionZoneLive(container, batch) {
    const idleRow = container.querySelector('#az-idle');
    const liveRow = container.querySelector('#az-live');
    const pipeWrap = container.querySelector('#pipeline-bar-wrap');

    if (idleRow) idleRow.style.display = 'none';
    if (liveRow) liveRow.style.display = 'flex';
    if (pipeWrap) pipeWrap.style.display = 'block';

    const { completed = 0, total_tests = 0 } = batch;

    // Test counter
    const counter = container.querySelector('#prompt-counter');
    if (counter) counter.textContent = `${completed} / ${total_tests} tests`;

    // ETA
    const etaEl = container.querySelector('#eta');
    if (etaEl) etaEl.textContent = formatEta(batch);

    // Pipeline bar
    updatePipelineBar(batch);
}

// ── Pipeline bar ──────────────────────────────────────────────────────────────

// Phase ordering for the high-level pipeline (matches backend setBatchPhase calls).
// Anything in PRE_EXEC_PHASES happens before the first prompt fires; we use it
// to fill PREP and animate WARMUP so the user sees something is happening.
const PRE_EXEC_PHASES = new Set(['preparing', 'profiling', 'dedication', 'claiming']);
const WARMUP_PHASES = new Set(['baseline', 'warmup', 'judge_warmup']);

function _phaseLabel(phase) {
    switch (phase) {
        case 'preparing': return 'preparing';
        case 'profiling': return 'profiling models';
        case 'dedication': return 'detecting dedication';
        case 'claiming': return 'claiming hosts';
        case 'baseline': return 'baseline';
        case 'warmup': return 'warmup';
        case 'judge_warmup': return 'judge warmup';
        case 'executing': return 'executing';
        case 'judging': return 'judging';
        default: return null;
    }
}

/**
 * Update all 4 pipeline bar segment fills based on current batch state.
 * @param {object} batch — batch status from the API
 */
export function updatePipelineBar(batch) {
    const { completed = 0, total_tests = 0, judge_progress = 0, current_test } = batch;
    const stage = current_test ? current_test.stage : null;
    const phase = current_test ? current_test.phase : null;
    const phaseDetail = current_test ? current_test.phase_detail : null;

    // PREP — animated 50% during pre-exec phases, 100% once we're past them.
    let prepFill;
    let prepActive = false;
    if (PRE_EXEC_PHASES.has(phase)) {
        prepFill = 50;
        prepActive = true;
    } else if (phase || completed > 0 || stage) {
        prepFill = 100;
    } else {
        prepFill = 0;
    }
    _setFill('pf-prep', prepFill);
    _setPulsing('pf-prep', prepActive);
    _setLabel('pl-prep', prepActive ? `prep ▶ ${_phaseLabel(phase) || ''}`.trim() : 'prep', prepActive);

    // WARMUP — animated 50% during baseline/warmup/judge_warmup phases or per-prompt warmup,
    // 100% once we've moved into executing/judging. Falls back to legacy stage-only logic
    // when phase is absent (older batches resumed against new code).
    const inWarmup = WARMUP_PHASES.has(phase) || stage === 'warmup';
    const warmupDone = phase === 'executing' || phase === 'judging' || (stage && stage !== 'warmup' && !PRE_EXEC_PHASES.has(phase));
    const warmupFill = inWarmup ? 50 : (warmupDone ? 100 : 0);
    _setFill('pf-warm', warmupFill);
    _setPulsing('pf-warm', inWarmup);
    _setLabel('pl-warm', inWarmup ? `warmup ▶ ${_phaseLabel(phase) || ''}`.trim() : 'warmup', inWarmup);

    // GENERATING — proportional to completed / total_tests
    const execFill = pct(completed, total_tests);
    _setFill('pf-exec', execFill);
    _setLabel('pl-exec', `generating ${completed}/${total_tests}`, stage === 'executing' || phase === 'executing');

    // JUDGING — dual progress: overall % + queue depth
    // Use authoritative judge_stats when available
    const js = batch.judge_stats || {};
    const judgeCompleted = js.completed ?? batch.judge_completed ?? 0;
    const judgeTotal = js.total ?? batch.judge_total ?? 0;
    const judgeQueue = Math.max(0, judgeTotal - judgeCompleted);

    // Overall judge progress: judgeCompleted / total_tests (how many scored out of all tests)
    const jdgOverall = total_tests > 0 ? Math.round((judgeCompleted / total_tests) * 100) : 0;
    // Fallback to server-side judge_progress if no judge_total data
    const jdgFill = judgeTotal > 0 ? jdgOverall : Math.min(100, Math.max(0, judge_progress || 0));
    _setFill('pf-jdg', jdgFill);

    // Label: "judging 10/350 (5 in queue)" or just "judging X%"
    // Highlight parallel activity when executing and judging simultaneously
    const isParallel = stage === 'executing' && judgeQueue > 0;
    const jdgLabel = judgeTotal > 0
        ? `judging ${judgeCompleted}/${judgeTotal}${judgeQueue > 0 ? ` (${judgeQueue} queued)` : ''}`
        : `judging ${jdgFill}%`;
    _setLabel('pl-jdg', jdgLabel, stage === 'judging' || phase === 'judging' || isParallel);

    // Phase detail line — surface what the backend is currently doing.
    // Falls back to a generated label when no detail string is set (e.g. just-started batch).
    const statusEl = document.getElementById('pipe-status');
    if (statusEl) {
        let text = phaseDetail || '';
        if (!text && phase && phase !== 'executing') {
            text = _phaseLabel(phase) || '';
        }
        statusEl.textContent = text;
        statusEl.style.display = text ? 'block' : 'none';
    }

    // Update the LIVE label to reflect the actual phase (instead of always "EXECUTING").
    const liveLabelEl = document.querySelector('#az-live .live-label');
    if (liveLabelEl) {
        const lbl = phase ? (_phaseLabel(phase) || 'executing') : 'executing';
        liveLabelEl.textContent = lbl.toUpperCase();
    }
}

function _setFill(id, pct) {
    const el = document.getElementById(id);
    if (el) el.style.width = `${pct}%`;
}

function _setPulsing(id, pulsing) {
    const el = document.getElementById(id);
    if (!el) return;
    if (pulsing) el.classList.add('pulsing');
    else el.classList.remove('pulsing');
}

function _setLabel(id, text, active = false) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = active ? 'al' : '';
}

// ── Elapsed timer ─────────────────────────────────────────────────────────────

/**
 * Start the elapsed timer, updating #elapsed every second.
 * @param {number|null} anchorMs — optional epoch ms to use as start (batch.started_at).
 *                                 Defaults to now.
 */
export function startElapsedTimer(anchorMs = null) {
    stopElapsedTimer();
    _startTime = anchorMs || Date.now();
    _elapsedTimer = setInterval(() => {
        const el = document.getElementById('elapsed');
        if (el) el.textContent = formatElapsed(Date.now() - _startTime);
    }, 1000);
    // Immediate first tick
    const el = document.getElementById('elapsed');
    if (el) el.textContent = formatElapsed(Date.now() - _startTime);
}

/** Stop the elapsed timer and reset state. */
export function stopElapsedTimer() {
    if (_elapsedTimer !== null) {
        clearInterval(_elapsedTimer);
        _elapsedTimer = null;
    }
    _startTime = null;
}
