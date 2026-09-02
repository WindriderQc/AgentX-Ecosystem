// launch-summary.js — Section ④ Launch: summary card + launch button.
// Reads state from infrastructure + batch-config to populate a recap.
// Also renders a "Resume Batch" banner when a stopped/failed batch exists.

import { esc, normModel } from './helpers.js';
import { getSelectedHost } from './infrastructure.js';
import { getSelectedJudge } from './judge-roster.js';

const LEVEL_PROMPTS = { 1: 14, 2: 21, 3: 21, 4: 21, 5: 7 };
function _vramLabel(mib) { return mib ? `${Math.round(mib / 1024)} GB VRAM` : ''; }
const LEVEL_CATS    = { 1: 7,  2: 7,  3: 7,  4: 7,  5: 7 };

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Render the launch summary section.
 * @param {HTMLElement} container — #launch-summary
 * @param {object} deps — { $infrastructure, $batchConfig, modelProfiles }
 */
export function renderLaunchSummary(container, deps) {
    container.innerHTML = _build();
    _wire(container, deps);
}

/** Refresh the summary card data without full re-render */
export function updateLaunchSummary(container, deps) {
    _updateSummary(container, deps);
}

/**
 * Render a resume banner above the launch section when a resumable batch exists.
 * @param {HTMLElement} container — #launch-summary
 * @param {object}      batch     — the resumable batch object
 * @param {object}      callbacks — { onResume(batch), onDiscard(batch) }
 */
export function renderResumeBanner(container, batch, callbacks) {
    // Remove any existing banner
    clearResumeBanner(container);

    if (!batch) return;

    const id        = batch._id || batch.id || '';
    const status    = batch.status || 'stopped';
    const models    = batch.models || [];
    const total     = batch.total_tests || 0;
    const scored    = (batch.results || []).filter(r => r.quality_score != null).length;
    const done      = batch.progress || scored;
    const pct       = total > 0 ? Math.round((done / total) * 100) : 0;
    const host      = batch.host || batch.plan?.exec_hosts?.[0]?.exec_host || '—';
    const hostShort = host.replace(/^https?:\/\//, '').replace(/:11434$/, '');
    const judge     = batch.judge_config?.model || batch.plan?.judge_model || '—';
    const startedAt = batch.started_at ? new Date(batch.started_at).toLocaleString() : '—';
    const modelList = models.length <= 3
        ? models.map(m => typeof m === 'string' ? m : m.model || m.name || '?').join(', ')
        : `${models.slice(0, 2).map(m => typeof m === 'string' ? m : m.model || m.name || '?').join(', ')} +${models.length - 2}`;

    const statusClass = status === 'failed' ? 'rb-failed' : status === 'interrupted' ? 'rb-interrupted' : 'rb-stopped';
    const statusIcon  = status === 'failed' ? '&#10007;' : status === 'interrupted' ? '&#9888;' : '&#9724;';
    const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);

    const banner = document.createElement('div');
    banner.className = 'rb-banner';
    banner.id = 'resume-banner';
    banner.innerHTML = `
      <div class="rb-header">
        <span class="rb-status ${statusClass}">${statusIcon} ${esc(statusLabel)}</span>
        <span class="rb-title">Batch can be resumed</span>
        <span class="rb-date">${esc(startedAt)}</span>
      </div>
      <div class="rb-details">
        <div class="rb-detail">
          <span class="rb-label">Host</span>
          <span class="rb-val">${esc(hostShort)}</span>
        </div>
        <div class="rb-detail">
          <span class="rb-label">Models</span>
          <span class="rb-val">${esc(modelList)} (${models.length})</span>
        </div>
        <div class="rb-detail">
          <span class="rb-label">Judge</span>
          <span class="rb-val">${esc(judge)}</span>
        </div>
        <div class="rb-detail">
          <span class="rb-label">Progress</span>
          <span class="rb-val">${done}/${total} (${pct}%)</span>
        </div>
      </div>
      <div class="rb-progress-track">
        <div class="rb-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="rb-actions">
        <button type="button" class="rb-resume-btn" data-batch-id="${esc(id)}">&#9654; Resume Batch</button>
        <button type="button" class="rb-discard-btn" data-batch-id="${esc(id)}">Dismiss</button>
      </div>`;

    // Insert at the top of the container
    container.prepend(banner);

    // Wire buttons
    banner.querySelector('.rb-resume-btn')?.addEventListener('click', () => {
        callbacks?.onResume?.(batch);
    });
    banner.querySelector('.rb-discard-btn')?.addEventListener('click', () => {
        banner.remove();
        callbacks?.onDiscard?.(batch);
    });
}

/** Remove the resume banner if present */
export function clearResumeBanner(container) {
    container?.querySelector('#resume-banner')?.remove();
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _build() {
    return `
    <div class="bf-section-header">
      <span class="bf-section-num">\u2463</span>
      <span class="bf-section-title">Launch</span>
    </div>
    <div class="ls-card">
      <div class="ls-grid">
        <div class="ls-col" id="ls-host"><div class="ls-label">TARGET</div><div class="ls-val">\u2014</div></div>
        <div class="ls-col" id="ls-models"><div class="ls-label">MODELS</div><div class="ls-val">\u2014</div></div>
        <div class="ls-col" id="ls-judge"><div class="ls-label">JUDGE</div><div class="ls-val">\u2014</div></div>
        <div class="ls-col" id="ls-tests"><div class="ls-label">TESTS</div><div class="ls-val">\u2014</div></div>
      </div>
    </div>
    <div id="ls-warnings" class="ls-warnings"></div>
    <div id="ls-launch-status" class="ls-launch-status" role="status" aria-live="polite"></div>
    <div class="ls-bar">
      <div class="ls-estimates">
        <span id="ls-est-time" class="ls-est"></span>
        <span id="ls-est-cost" class="ls-est ls-est-cost">No paid targets selected</span>
      </div>
      <button type="button" id="ls-launch-btn" class="ls-launch-btn" disabled>Launch Benchmark</button>
    </div>`;
}

function _wire(container, deps) {
    const btn = container.querySelector('#ls-launch-btn');
    if (btn) {
        btn.addEventListener('click', () => {
            btn.disabled = true;
            btn.textContent = 'Preflight\u2026';
            btn.style.opacity = '0.7';
            const form = deps.$batchConfig?.querySelector('#bv2-batch-form');
            if (form) {
                form.requestSubmit();
            } else {
                btn.disabled = false;
                btn.textContent = 'Launch Benchmark';
                btn.style.opacity = '';
            }
        });
    }

    // Listen for changes to update summary
    document.addEventListener('host-selected', () => _updateSummary(container, deps));
    deps.$batchConfig?.addEventListener('config-changed', () => _updateSummary(container, deps));
    deps.$batchConfig?.addEventListener('change', () => _updateSummary(container, deps));

    _updateSummary(container, deps);
}

function _setDefaultLaunchStatus(container, ready, detail) {
    const statusEl = container.querySelector('#ls-launch-status');
    if (!statusEl) return;
    const activeState = statusEl.dataset.launchState || '';
    if (['checking', 'preflight', 'launching'].includes(activeState)) return;
    statusEl.dataset.launchState = ready ? 'ready' : 'blocked';
    statusEl.className = `ls-launch-status ${ready ? 'ls-launch-ready' : 'ls-launch-blocked'}`;
    statusEl.innerHTML = ready
        ? `<span class="ls-launch-status-kicker">Ready for preflight</span><span class="ls-launch-status-detail">${esc(detail)}</span>`
        : `<span class="ls-launch-status-kicker">Launch blocked</span><span class="ls-launch-status-detail">${esc(detail)}</span>`;
}

function _updateSummary(container, deps) {
    const { $infrastructure, $batchConfig, modelProfiles } = deps;

    const modelCbs = $batchConfig
        ? Array.from($batchConfig.querySelectorAll('.bv2-model-cb:checked'))
        : [];
    const modelNames = modelCbs.map(cb => cb.value);
    const localModelNames = modelCbs
        .filter(cb => cb.dataset.executionKind !== 'harness')
        .map(cb => cb.value);
    const localModelCount = localModelNames.length;
    const cloudModelCount = modelCbs.length - localModelCount;

    // Execution target
    const host = $infrastructure ? getSelectedHost($infrastructure) : null;
    const executionTargetReady = !!host || (localModelCount === 0 && cloudModelCount > 0);
    const hostCol = container.querySelector('#ls-host .ls-val');
    if (hostCol) {
        if (host) {
            const name = host.displayName || host.name || host.hostname || '?';
            const gpu = host.gpu?.model || _vramLabel(host.gpu?.vramTotalMiB) || '';
            const tps = host.baseline?.tokensPerSec
                ? `${Number(host.baseline.tokensPerSec).toFixed(1)} tok/s` : '';
            hostCol.innerHTML = `<strong>${esc(name)}</strong><br>`
                + `<span class="ls-dim">${esc(gpu)}${tps ? ` \u00B7 ${tps}` : ''}</span>`
                + (cloudModelCount > 0
                    ? `<br><span class="ls-dim">+ ${cloudModelCount} isolated cloud target${cloudModelCount === 1 ? '' : 's'}</span>`
                    : '');
        } else if (executionTargetReady) {
            hostCol.innerHTML = '<strong>Cloud harnesses</strong><br>'
                + `<span class="ls-dim">${cloudModelCount} isolated target${cloudModelCount === 1 ? '' : 's'}</span>`;
        } else {
            hostCol.textContent = '\u2014 Select an execution target';
        }
    }

    // Models
    const modelsCol = container.querySelector('#ls-models .ls-val');
    if (modelsCol) {
        if (modelNames.length) {
            const display = modelNames.length <= 3
                ? modelNames.join(', ')
                : `${modelNames.slice(0, 2).join(', ')} +${modelNames.length - 2}`;
            modelsCol.innerHTML = `<strong>${modelNames.length} selected</strong><br>`
                + `<span class="ls-dim">${esc(display)}</span>`;
        } else {
            modelsCol.textContent = '\u2014 Select models';
        }
    }

    // Judge
    const judge = $batchConfig ? getSelectedJudge($batchConfig) : {};
    const judgeCol = container.querySelector('#ls-judge .ls-val');
    if (judgeCol) {
        if (judge.model) {
            const judgeHostShort = (judge.host || '').replace(/^https?:\/\//, '').replace(/:11434$/, '') || '?';
            const execHostUrl = host?.hostUrl || host?.url || '';
            const sameHost = !!(judge.host && execHostUrl && judge.host === execHostUrl);
            const sameHostBadge = sameHost
                ? '<span class="ls-judge-warn" title="Judge runs on the same host as generation \u2014 they will share GPU.">\u26A0 same host as exec</span>'
                : '';
            judgeCol.innerHTML = `<strong>${esc(judge.model)}</strong><br>`
                + `<span class="ls-judge-host">on <strong>${esc(judgeHostShort)}</strong></span>`
                + (sameHostBadge ? `<br>${sameHostBadge}` : '');
        } else {
            judgeCol.textContent = '\u2014 Select a judge';
        }
    }

    // Tests
    const depthRadios = $batchConfig
        ? $batchConfig.querySelectorAll('.bv2-depth-radio:checked') : [];
    let totalPrompts = 0;
    depthRadios.forEach(r => {
        const level = parseInt(r.dataset.level, 10);
        const depth = r.dataset.depth;
        if (depth === 'single') totalPrompts += 1;
        else if (depth === 'light') totalPrompts += (LEVEL_CATS[level] || 7);
        else if (depth === 'full') totalPrompts += (LEVEL_PROMPTS[level] || 7);
    });
    const testCount = totalPrompts * modelNames.length;
    const testsCol = container.querySelector('#ls-tests .ls-val');
    if (testsCol) {
        testsCol.innerHTML = totalPrompts > 0
            ? `<strong style="color:var(--r-active)">~${testCount} tests</strong><br>`
              + `<span class="ls-dim">${totalPrompts} prompts \u00D7 ${modelNames.length} models</span>`
            : '\u2014 Configure depth';
    }

    // Warnings (unprofiled models)
    const warningsEl = container.querySelector('#ls-warnings');
    if (warningsEl && host) {
        const hostId = host.hostId || '';
        const profileMap = new Map(
            (modelProfiles || []).map(p => [normModel(p.modelName || p.name), p])
        );
        const unprofiled = localModelNames.filter(m => {
            // localModelNames hold the raw Ollama tag (may include `slekrem/`-style
            // namespace); profileMap is keyed by the normalized form.
            const profile = profileMap.get(normModel(m));
            const readiness = profile?.readiness instanceof Map
                ? profile.readiness.get(hostId)
                : profile?.readiness?.[hostId];
            return !readiness || readiness.stage === 'available';
        });
        warningsEl.innerHTML = unprofiled.length
            ? `<div class="ls-warn-msg">\u26A0 ${unprofiled.length} model${unprofiled.length !== 1 ? 's' : ''} not profiled \u2014 results may vary</div>`
            : '';
    } else if (warningsEl) {
        warningsEl.innerHTML = '';
    }

    // Estimated time
    const estTimeEl = container.querySelector('#ls-est-time');
    if (estTimeEl) {
        if (testCount > 0) {
            const estMin = Math.ceil(testCount * 30 / 60); // ~30s per test rough
            estTimeEl.textContent = `Est. ~${estMin} min`;
        } else {
            estTimeEl.textContent = '';
        }
    }

    // Worst-case manual ceiling for explicitly selected paid targets. The
    // broker still revalidates pricing and requires a one-batch SpendGrant.
    const repeats = Math.max(1, Math.min(5, Number($batchConfig?.querySelector('#bv2-adv-exec_repeats')?.value) || 1));
    const judgeAttempts = Math.max(1, Math.min(6, Number($batchConfig?.querySelector('#bv2-adv-max_retries')?.value ?? 2) + 1));
    const outputTokensPerCall = Math.max(1, Number($batchConfig?.querySelector('#bv2-adv-response_max_tokens')?.value) || 32_000);
    const inputTokensPerCall = 32_000;
    const callsPerCandidate = totalPrompts * repeats;
    const paidCandidateInputs = modelCbs.filter((input) => input.dataset.paid === 'true');
    const paidJudge = $batchConfig?.querySelector('input[name="bv2-cloud-judge"]:checked[data-paid="true"]') || null;
    const paidUnits = [
        ...paidCandidateInputs.map((input) => ({ input, calls: callsPerCandidate })),
        ...(paidJudge ? [{ input: paidJudge, calls: modelNames.length * callsPerCandidate * judgeAttempts }] : []),
    ];
    const maxCalls = paidUnits.reduce((sum, unit) => sum + unit.calls, 0);
    const maxCostNanodollars = paidUnits.reduce((sum, { input, calls }) => (
        sum
        + calls * Number(input.dataset.callNanodollars || 0)
        + calls * Math.ceil(inputTokensPerCall * Number(input.dataset.inputNanodollars || 0) / 1_000_000)
        + calls * Math.ceil(outputTokensPerCall * Number(input.dataset.outputNanodollars || 0) / 1_000_000)
    ), 0);
    const costEl = container.querySelector('#ls-est-cost');
    if (costEl) {
        costEl.classList.toggle('ls-est-cost-paid', maxCalls > 0);
        costEl.textContent = maxCalls > 0
            ? `Paid ceiling · ${maxCalls} calls · ${(maxCalls * (inputTokensPerCall + outputTokensPerCall)).toLocaleString()} tokens · ~US$${(maxCostNanodollars / 1e9).toFixed(6)} manual`
            : paidUnits.length
                ? 'Paid target selected · configure test depth to calculate the ceiling'
                : 'No paid targets selected';
    }

    // Enable/disable launch
    const btn = container.querySelector('#ls-launch-btn');
    if (btn) {
        const ready = executionTargetReady && modelNames.length > 0 && judge.model && testCount > 0;
        btn.disabled = !ready;
        let blockedReason = '';
        if (modelNames.length === 0) blockedReason = 'Select at least one model.';
        else if (!executionTargetReady) blockedReason = 'Select an execution host for local models.';
        else if (!judge.model) blockedReason = 'Choose a judge model.';
        else if (testCount <= 0) blockedReason = 'Enable at least one test level.';
        _setDefaultLaunchStatus(
            container,
            ready,
            ready
                ? (host && cloudModelCount > 0
                    ? 'Preflight will check host reachability and revalidate the attested harness targets, selected models, judge, prompts, and active batch locks before launch.'
                    : host
                        ? 'Preflight will check host reachability, selected models, judge availability, prompts, and active batch locks before launch.'
                        : 'Preflight will revalidate the attested harness targets, judge, prompt contract, and active batch locks before launch.')
                : blockedReason
        );
    }
}
