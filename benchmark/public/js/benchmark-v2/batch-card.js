// batch-card.js — LIVE state compact batch summary card (benchmark-v2)
// Exports: renderBatchCard(container, batch), updateBatchCard(container, batch)
// CSS classes: .batch-card, .bc-row, .bc-group, .bc-icon, .bc-label, .bc-val,
//              .bc-dim, .bc-sep, .bc-counters, .bc-c, .bc-ci, .bc-cv, .bc-level-badges

import { levelBadge } from '../components/level-badge.js';
import { rerunInvalidRows } from './api.js';
import { showToast } from '../components/toast.js';

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Initial render of the running batch card.
 *
 * @param {HTMLElement} container — the .batch-card element (or a wrapper)
 * @param {object}      batch     — batch data object from fetchBatchProgress()
 */
export function renderBatchCard(container, batch) {
    container.innerHTML = _buildCard(batch);
    _wireInvalidRerun(container, batch);
}

/**
 * Update the card in place without a full re-render.
 * Replaces counter strip and status-sensitive values.
 *
 * @param {HTMLElement} container
 * @param {object}      batch
 */
export function updateBatchCard(container, batch) {
    const rowEl      = container.querySelector('.bc-row');
    const countersEl = container.querySelector('.bc-counters');

    if (!rowEl || !countersEl) {
        // Fallback: full re-render
        renderBatchCard(container, batch);
        return;
    }

    rowEl.innerHTML      = _buildRow(batch);
    countersEl.innerHTML = _buildCounters(batch);
    _wireInvalidRerun(container, batch);
}

// ── Internal builders ──────────────────────────────────────────────────────────

function _buildCard(batch) {
    return `
    <div class="bc-row">${_buildRow(batch)}</div>
    <div class="bc-counters">${_buildCounters(batch)}</div>
  `;
}

function _buildRow(batch) {
    const parts = [];

    // Batch name
    const name = batch.run_name || batch.name || batch._id || 'Batch';
    parts.push(`
    <div class="bc-group">
      <span class="bc-icon">&#9654;</span>
      <span class="bc-val">${_esc(name)}</span>
    </div>`);

    parts.push('<div class="bc-sep"></div>');

    // Execution host + GPU
    const host    = _resolveHost(batch);
    const hostName = host.name;
    const gpu      = host.gpu;
    parts.push(`
    <div class="bc-group">
      <span class="bc-icon">&#128421;</span>
      <span class="bc-label">Execution</span>
      <span class="bc-val">${_esc(hostName)}</span>
      ${gpu ? `<span class="bc-dim">${_esc(gpu)}</span>` : ''}
    </div>`);

    parts.push('<div class="bc-sep"></div>');

    // Models — count + pill list
    const models = _resolveModels(batch);
    const modelPills = models.slice(0, 6).map(m =>
        `<span class="bc-dim" style="background:rgba(79,195,247,0.08);padding:0.05rem 0.3rem;border-radius:3px;">${_esc(m)}</span>`
    ).join(' ');
    const moreLabel = models.length > 6 ? `<span class="bc-dim">+${models.length - 6} more</span>` : '';
    parts.push(`
    <div class="bc-group" style="flex-wrap:wrap;gap:0.35rem;">
      <span class="bc-icon">&#129302;</span>
      <span class="bc-label">Models</span>
      <span class="bc-val">${models.length}</span>
      ${modelPills}
      ${moreLabel}
    </div>`);

    parts.push('<div class="bc-sep"></div>');

    // Workload summary
    const totalPrompts = _resolvePromptCount(batch);
    const totalTests = _resolveTotalTests(batch);
    parts.push(`
    <div class="bc-group">
      <span class="bc-icon">&#128196;</span>
      <span class="bc-label">Workload</span>
      <span class="bc-val">${totalPrompts} prompt${totalPrompts === 1 ? '' : 's'}</span>
      <span class="bc-dim">&middot; ${models.length} model${models.length === 1 ? '' : 's'}</span>
      <span class="bc-dim">&middot; ${totalTests} test${totalTests === 1 ? '' : 's'}</span>
    </div>`);

    parts.push('<div class="bc-sep"></div>');

    // Level badges
    const levels = _resolveLevels(batch);
    const levelBadges = levels.length
        ? `<div class="bc-level-badges">${levels.map(l => levelBadge(l)).join('')}</div>`
        : '<span class="bc-dim">—</span>';
    parts.push(`
    <div class="bc-group">
      <span class="bc-icon">&#127775;</span>
      <span class="bc-label">Levels</span>
      ${levelBadges}
    </div>`);

    parts.push('<div class="bc-sep"></div>');

    // Judge model + method + host
    const jc = batch.judge_config || {};
    const judgeModel  = jc.model || batch.judge_model || batch.judgeModel || '—';
    const judgeMethod = _resolveJudgeMethod(batch);
    const judgeHost   = _resolveJudgeHost(batch);
    parts.push(`
    <div class="bc-group">
      <span class="bc-icon">&#9878;</span>
      <span class="bc-label">Judge</span>
      <span class="bc-val">${_esc(judgeModel)}</span>
      <span class="bc-dim">${_esc(judgeMethod)}</span>
      ${judgeHost ? `<span class="bc-dim">host ${_esc(judgeHost)}</span>` : ''}
    </div>`);

    return parts.join('');
}

function _buildCounters(batch) {
    const s = _resolveStats(batch);

    const counters = [
        { cls: 'c-ok',   icon: '&#10003;', label: 'scored',        val: s.scored },
        { cls: 'c-gen',  icon: '&#9654;',  label: 'running',       val: s.running },
        { cls: 'c-jdg',  icon: '&#9878;',  label: 'judge pending', val: s.judgePending },
        { cls: 'c-warn', icon: '&#9888;',  label: 'review',        val: s.anomalies },
        { cls: 'c-invalid', icon: '&#8856;', label: 'invalid',      val: s.invalid },
        { cls: 'c-err',  icon: '&#10007;', label: 'failed',        val: s.failed },
        { cls: 'c-wait', icon: '&#9711;',  label: 'remaining',     val: s.remaining },
    ];

    let counterHTML = counters.map(({ cls, icon, label, val }) => `
    <div class="bc-c ${_esc(cls)}">
      <span class="bc-ci">${icon}</span>
      <span class="bc-cv">${val}</span>
      <span class="bc-ci">${_esc(label)}</span>
    </div>`).join('');

    // Dual-queue pipeline activity strip
    const pa = batch.pipeline_activity;
    if (pa && pa.executing) {
        const judgePending = pa.judging?.pending ?? s.judgePending;
        const judgeStatus = batch.judge_status || 'none';
        const judgeText = judgeStatus === 'running'
            ? `Judge: ${judgePending} pending`
            : (judgePending > 0 ? 'Judge: waiting for generation' : 'Judge: idle');
        counterHTML += `
        <div class="bc-pipeline-strip">
          <span class="bc-ps-exec">&#9654; Exec: ${_esc(pa.executing.model || '—')}</span>
          <span class="bc-ps-sep">|</span>
          <span class="bc-ps-judge">&#9878; ${_esc(judgeText)}</span>
        </div>`;
    }

    if (s.invalid > 0 && batch.status === 'completed') {
        counterHTML += `
        <button type="button" class="bc-rerun-invalid" data-batch-id="${_esc(batch._id || batch.id || '')}">
          Rerun invalid
        </button>`;
    }

    return counterHTML;
}

function _wireInvalidRerun(container, batch) {
    const btn = container.querySelector('.bc-rerun-invalid');
    if (!btn || btn.dataset.bound === 'true') return;
    btn.dataset.bound = 'true';
    btn.addEventListener('click', async () => {
        const batchId = btn.dataset.batchId || batch._id || batch.id;
        if (!batchId) return;
        btn.disabled = true;
        const oldText = btn.textContent;
        btn.textContent = 'Checking...';
        try {
            const preview = await rerunInvalidRows(batchId, { launch: false });
            const data = preview?.data || preview;
            const tests = data?.would_run_tests ?? '?';
            const invalid = data?.invalid_rows ?? '?';
            const exact = data?.exact_rectangular_rerun === true;
            const proceed = window.confirm(
                exact
                    ? `Rerun ${invalid} invalid row(s) as ${tests} corrected test(s)?`
                    : `Invalid rows would require a ${tests}-test superset rerun. Launch anyway?`
            );
            if (!proceed) return;
            btn.textContent = 'Launching...';
            await rerunInvalidRows(batchId, { launch: true, allow_superset: !exact });
            showToast('Corrected invalid-row rerun launched.', 'success');
        } catch (err) {
            showToast(`Invalid-row rerun failed: ${err.message}`, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = oldText;
        }
    });
}

// ── Data resolution helpers ────────────────────────────────────────────────────

function _resolveHost(batch) {
    // Try nested exec_hosts first, then flat fields
    const execHosts = batch.exec_hosts || batch.execHosts;
    if (Array.isArray(execHosts) && execHosts.length) {
        const h = execHosts[0];
        return {
            name: h.name || _shortUrl(h.exec_host || h.host || ''),
            gpu:  h.gpu || h.gpu_spec || '',
        };
    }

    const hostUrl  = batch.host || batch.exec_host || '';
    const hostName = batch.host_name || batch.hostName || _shortUrl(hostUrl);
    const gpu      = batch.gpu || batch.gpu_spec || '';
    return { name: hostName, gpu };
}

function _resolveModels(batch) {
    const models = batch.models || batch.selected_models || [];
    if (Array.isArray(models)) return models.map(m => _normalizeModel(String(m)));

    // Might be grouped by host
    if (typeof models === 'object') {
        return Object.values(models).flat().map(m => _normalizeModel(String(m)));
    }
    return [];
}

function _resolvePromptCount(batch) {
    if (typeof batch.plan?.total_prompts === 'number') return batch.plan.total_prompts;
    if (typeof batch.total_prompts === 'number') return batch.total_prompts;
    if (typeof batch.prompt_count  === 'number') return batch.prompt_count;
    if (typeof batch.totalPrompts  === 'number') return batch.totalPrompts;

    const totalTests = _resolveTotalTests(batch);
    const models = _resolveModels(batch).length;
    if (totalTests > 0 && models > 0) {
        return Math.ceil(totalTests / models);
    }

    // Last-resort derive from results
    const results = batch.results || [];
    return Array.isArray(results) ? results.length : 0;
}

function _resolveTotalTests(batch) {
    if (typeof batch.total_tests === 'number') return batch.total_tests;
    if (typeof batch.totalTests === 'number') return batch.totalTests;

    const planHosts = batch.plan?.exec_hosts;
    if (Array.isArray(planHosts) && planHosts.length) {
        return planHosts.reduce((sum, host) => sum + Number(host.tests || 0), 0);
    }

    return 0;
}

function _resolveLevels(batch) {
    if (Array.isArray(batch.levels)) return batch.levels.map(Number).filter(n => n >= 1 && n <= 5);

    // Infer from depth_matrix or results
    const dm = batch.depth_matrix || batch.depthMatrix;
    if (dm && typeof dm === 'object') {
        const activeLevels = new Set();
        Object.values(dm).forEach(row => {
            if (Array.isArray(row)) {
                row.forEach((val, li) => {
                    if (Number(val) > 0) activeLevels.add(li + 1);
                });
            }
        });
        if (activeLevels.size) return Array.from(activeLevels).sort((a, b) => a - b);
    }

    // Fall back to result levels
    const results = Array.isArray(batch.results) ? batch.results : [];
    const levelSet = new Set(results.map(r => Number(r.prompt_level || r.level)).filter(n => n >= 1 && n <= 5));
    return Array.from(levelSet).sort((a, b) => a - b);
}

function _resolveJudgeMethod(batch) {
    const raw = batch.multi_judge
        || batch.multiJudge
        || batch.multi_judge_rule
        || batch.judge_config?.multi_judge
        || null;

    if (raw && typeof raw === 'object') {
        if (raw.enabled === false) return 'single';
        const rule = raw.rule || 'custom';
        const judgeCount = Array.isArray(raw.judges) ? raw.judges.length : 0;
        const tag = judgeCount >= 2 ? `${judgeCount}-judge` : 'multi';
        switch (rule) {
            case 'l4l5':           return `${tag} L4–L5`;
            case 'low_confidence': return `${tag} low-conf`;
            case 'always':         return `${tag} always`;
            case 'custom':         return `${tag} custom`;
            default:               return tag;
        }
    }

    const rule = typeof raw === 'string' ? raw : 'off';
    switch (rule) {
        case 'off':
        case 'none':            return 'single';
        case 'l4l5':            return 'multi L4–L5';
        case 'all':
        case 'always':          return 'multi all';
        case 'low_confidence':  return 'multi low-conf';
        default:                return rule ? String(rule) : 'single';
    }
}

function _resolveJudgeHost(batch) {
    const jc = batch.judge_config || {};
    if (jc.host) return _shortUrl(jc.host);

    // Try plan exec_hosts judge_host
    const planHosts = batch.plan?.exec_hosts;
    if (Array.isArray(planHosts) && planHosts.length) {
        const jh = planHosts[0].judge_host;
        if (jh) return _shortUrl(jh);
    }

    return '';
}

function _resolveStats(batch) {
    const judgeCompleted = _num(batch.judge_completed ?? batch.judge_stats?.completed);
    const judgeTotal = _num(batch.judge_total ?? batch.judge_stats?.total ?? 0);
    const judgePending = _num(batch.judge_stats?.pending ?? Math.max(0, judgeTotal - judgeCompleted));
    const anomalies = _num(batch.anomaly_count ?? 0);
    const invalid = _num(batch.invalid_count ?? (Array.isArray(batch.results) ? batch.results.filter(r => r.excluded_from_leaderboard).length : 0));
    const failed = _num(batch.failed ?? batch.failed_count ?? batch.error_count ?? 0);
    const total = _resolveTotalTests(batch);
    const completed = _num(batch.completed);
    const running = batch.pipeline_activity?.executing ? 1 : 0;
    const remaining = Math.max(0, total - completed);

    return {
        scored: judgeCompleted,
        running,
        judgePending,
        anomalies,
        invalid,
        failed,
        remaining
    };
}

// ── Tiny utilities ─────────────────────────────────────────────────────────────

function _num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function _shortUrl(url) {
    return String(url || '')
        .replace(/^https?:\/\//, '')
        .replace(/:11434$/, '');
}

function _normalizeModel(name) {
    return String(name || '').trim().replace(/:latest$/i, '');
}

function _esc(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
