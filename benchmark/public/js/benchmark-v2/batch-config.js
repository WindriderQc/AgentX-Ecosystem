// batch-config.js — IDLE state batch configuration form (benchmark-v2)
// Exports: renderBatchConfig(container, { host, modelProfiles, prompts, config, judgeRoster, lastBatch, onLaunch })
//
// Flow: Host selected externally (infrastructure.js) → models for that host appear
// → configure judge → set depth matrix.  Launch is handled by launch-summary.js.
// Matches POST /api/benchmark/batch contract: { host, models, levels, judge_config, depth_config }

import { preflight, fetchTemplates, saveTemplate, deleteTemplate, useTemplate } from './api.js';
import { buildJudgeRoster, wireJudgeRoster, getSelectedJudge } from './judge-roster.js';
import { save, load, loadObj, loadSet, loadArr, normModel, esc } from './helpers.js';
import { showToast } from '../components/toast.js';
import { fetchActiveProfilingState, findProfilingForHost, formatProfilingLockout } from './profiling-lockout.js';
import {
    SK_DEPTH, SK_JUDGE, SK_MODELS, SK_HOST, SK_THINK, SK_ADVANCED,
    _parseParamSize, _emptyMsg, _slug,
} from './batch-config-constants.js';
import {
    _buildCloudJudgePicker,
    _buildHarnessChecklist,
    _buildModelChecklist,
    _buildModelPickerToolbar,
    _buildSelectionBasket,
} from './batch-config-models.js';
import {
    _loadAdvancedSettings,
    _buildAdvancedSettings,
    _wireAdvancedSettings,
    _updateAdvancedSummary,
    _readAdvancedSettings,
} from './batch-config-advanced.js';
import {
    _buildMultiJudgeCard,
    _wireMultiJudgeCard,
    _readMultiJudgeFromUI,
} from './batch-config-multijudge.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const LEVELS = [1, 2, 3, 4, 5];

const DEPTH_OPTIONS = ['off', 'single', 'light', 'full'];
const DEPTH_LABELS  = { off: 'Off', single: '1 prompt', light: '1 per category', full: 'All prompts' };
const DEPTH_COLORS  = { off: 'var(--r-error)', single: 'var(--r-text-muted)', light: 'var(--r-active)', full: 'var(--r-good)' };
const DEFAULT_LEVEL_DEPTH = { 1: 'full', 2: 'full', 3: 'full', 4: 'full', 5: 'full' };

const LEVEL_NAMES = { 1: 'Basic', 2: 'Intermediate', 3: 'Advanced', 4: 'Expert', 5: 'Master' };
const LEVEL_DESCS = {
    1: 'Simple factual, short responses',
    2: 'Moderate complexity, basic reasoning',
    3: 'Advanced reasoning, longer responses',
    4: 'Complex multi-step, deep understanding',
    5: 'State-of-art, specialized knowledge',
};
const LEVEL_LABELS = { 1: 'L1', 2: 'L2', 3: 'L3', 4: 'L4', 5: 'L5' };
const LEVEL_COLORS = { 1: '#66bb6a', 2: '#a0d468', 3: '#f6bb42', 4: '#e9573f', 5: '#da4453' };

const LEVEL_PROMPTS = { 1: 14, 2: 21, 3: 21, 4: 21, 5: 7 };
const LEVEL_CATS    = { 1: 7,  2: 7,  3: 7,  4: 7,  5: 7 };

const DEPTH_PRESETS = {
    smoke:    { 1: 'single', 2: 'single', 3: 'off', 4: 'off', 5: 'off' },
    standard: { 1: 'full',   2: 'full',   3: 'full', 4: 'light', 5: 'off' },
    deep:     { 1: 'full',   2: 'full',   3: 'full', 4: 'full',  5: 'full' },
};

/** Module-level refs */
let _lastBatch = null;
let _currentHost = null;
let _modelProfiles = [];
let _benchmarkedModelSet = new Set();
let _harnessTargetMap = new Map();
let _harnessCatalogEnabled = false;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {HTMLElement} container
 * @param {object}      opts
 * @param {object}      opts.host — currently selected host (from infrastructure section)
 * @param {Array}       opts.modelProfiles — ModelProfile[] with readiness maps
 * @param {Array}       opts.benchmarkedModels — base model names with successful benchmark history
 */
export function renderBatchConfig(container, { host = null, modelProfiles = [], benchmarkedModels = [], prompts = [], config = {}, judgeRoster = null, harnessTargets = [], harnessCatalogEnabled = false, harnessCatalogMeta = {}, lastBatch = null, onLaunch }) {
    _lastBatch = lastBatch;
    _currentHost = host;
    _modelProfiles = modelProfiles;
    _benchmarkedModelSet = new Set((benchmarkedModels || []).map(normModel).filter(Boolean));
    _harnessTargetMap = new Map((harnessTargets || []).map((target) => [target.id, target]));
    _harnessCatalogEnabled = harnessCatalogEnabled === true;
    const onlineHosts = host ? [host] : [];
    container.innerHTML = _buildForm(host, config, judgeRoster, onlineHosts, harnessTargets, _harnessCatalogEnabled, harnessCatalogMeta);

    _wireModelTools(container.querySelector('#bv2-model-checklist'), host);
    _wireDepthPersist(container);
    _wireThinkPersist(container);
    _wireAdvancedSettings(container);
    wireJudgeRoster(container);
    _wireMultiJudgeCard(container);
    _wireSubmit(container, host, onLaunch);
    _wirePersistenceUI(container, onlineHosts, config, judgeRoster, onLaunch);

    // Inject per-host readiness badges
    const hostId = host?.hostId || '';
    _injectReadinessBadges(container, hostId);

    // Event delegation for checkbox changes in model cards
    const checklistEl = container.querySelector('#bv2-model-checklist');
    if (checklistEl) {
        checklistEl.addEventListener('change', e => {
            if (e.target.classList.contains('bv2-model-cb')) {
                const card = e.target.closest('.mc-card');
                if (card) card.classList.toggle('selected', e.target.checked);
                _saveSelectedModels(container);
                _updateDepthSummary(container, _readLevelDepth(container));
                _updateModelSelectionBasket(container);
                container.dispatchEvent(new CustomEvent('config-changed', { bubbles: true }));
            }
        });
    }

    _updateModelSelectionBasket(container);
}

/** Inject per-host readiness badges into model cards */
function _injectReadinessBadges(container, hostId) {
    if (!_modelProfiles?.length || !hostId) return;

    const profileMap = new Map(_modelProfiles.map(p => [normModel(p.modelName || p.name), p]));

    container.querySelectorAll('.mc-card[data-model]').forEach(card => {
        // data-model is the raw Ollama tag; profileMap keys are normalized.
        const modelName = card.dataset.modelNorm || normModel(card.dataset.model);
        const profile = profileMap.get(modelName);
        // readiness may be a Map or plain object depending on serialization
        const readiness = profile?.readiness instanceof Map
            ? profile.readiness.get(hostId)
            : profile?.readiness?.[hostId];
        const stage = readiness?.stage || 'available';
        const isStale = readiness?.stale === true;

        const nameEl = card.querySelector('.mc-card-name');
        if (!nameEl) return;
        nameEl.querySelectorAll('.ax-profile-readiness, .ax-benchmark-readiness').forEach(el => el.remove());

        nameEl.insertAdjacentHTML('beforeend', _readinessBadge(isStale ? 'stale' : stage, 'ax-profile-readiness'));

        const hasBenchmarkHistory = _benchmarkedModelSet.has(modelName);
        card.dataset.benchmarked = hasBenchmarkHistory ? 'true' : 'false';
        card.classList.toggle('mc-not-benchmarked', !hasBenchmarkHistory);
        nameEl.insertAdjacentHTML('beforeend', _benchmarkBadge(hasBenchmarkHistory));

        const notReady = stage === 'available' || isStale;
        if (notReady) {
            card.classList.add('mc-not-profiled');
            // Disable checkbox — model must be profiled before benchmarking
            const cb = card.querySelector('.bv2-model-cb');
            if (cb) {
                cb.checked = false;
                cb.disabled = true;
                card.classList.remove('selected');
            }
            // Add "profile first" link
            if (!card.querySelector('.mc-profile-link')) {
                const link = document.createElement('a');
                link.className = 'mc-profile-link';
                link.href = '/profiler#models';
                link.textContent = 'Profile first \u2192';
                link.style.cssText = 'font-size:0.62rem;color:var(--r-active,#58a6ff);text-decoration:none;margin-left:auto;';
                const body = card.querySelector('.mc-card-body');
                if (body) body.appendChild(link);
            }
        } else {
            card.classList.remove('mc-not-profiled');
        }
    });
}

function _readinessBadge(stage, extraClass = '') {
    const cfg = {
        profiled:    { text: 'Profiled',     cls: 'ax-good' },
        benchmarked: { text: 'Benchmarked',  cls: 'ax-good' },
        stale:       { text: 'Stale',        cls: 'ax-warn' },
        available:   { text: 'Not Profiled', cls: 'ax-warn' },
    };
    const c = cfg[stage] || cfg.available;
    return ` <span class="ax-readiness ${c.cls} ${extraClass}">${c.text}</span>`;
}

function _benchmarkBadge(hasBenchmarkHistory) {
    return hasBenchmarkHistory
        ? ' <span class="ax-readiness ax-good ax-benchmark-readiness">Benchmarked</span>'
        : ' <span class="ax-readiness ax-info ax-benchmark-readiness">Not Benchmarked</span>';
}

// ── Form scaffold ─────────────────────────────────────────────────────────────

function _buildForm(host, config, judgeRoster, onlineHosts, harnessTargets = [], harnessCatalogEnabled = false, harnessCatalogMeta = {}) {
    const hostName = host?.displayName || host?.name || host?.hostname || 'No host selected';
    const modelCount = host?.models?.length || host?.modelCount || host?._modelCount || 0;
    const cloudCandidates = (harnessTargets || []).filter((target) => target?.mode === 'isolated_model' && target?.capabilities?.candidate && target?.available !== false);
    const cloudCandidateCount = cloudCandidates.length;
    const modelAvailability = host
        ? `on <strong style="color:var(--r-active)">${esc(hostName)}</strong> \u2014 ${modelCount} local${cloudCandidateCount ? ` + ${cloudCandidateCount} cloud` : ''} available`
        : cloudCandidateCount
            ? `via <strong style="color:var(--r-active)">Cloud harnesses</strong> \u2014 ${cloudCandidateCount} available`
            : 'no execution target available';
    return `
    <form id="bv2-batch-form" class="batch-form" novalidate>

      <!-- ② Models -->
      <div class="bf-section-header">
        <span class="bf-section-num">\u2461</span>
        <span class="bf-section-title">Models</span>
        <span class="bf-section-context">${modelAvailability}</span>
      </div>

      <div class="bf-field">
        <div id="bv2-model-checklist" class="model-checklist">
          ${_buildModelPickerToolbar(host, harnessTargets, harnessCatalogMeta)}
          ${host ? _buildModelChecklist(host) : cloudCandidateCount ? '' : _emptyMsg('Select an execution host above.')}
          ${_buildHarnessChecklist(harnessTargets, harnessCatalogEnabled)}
          <div id="bv2-model-filter-empty" class="mc-filter-empty" hidden>No models match these filters.</div>
        </div>
        ${_buildSelectionBasket()}
      </div>

      <!-- ③ Judge & Tests -->
      <div class="bf-section-header">
        <span class="bf-section-num">\u2462</span>
        <span class="bf-section-title">Judge & Tests</span>
        <span class="bf-section-context">Configure scoring and test depth</span>
      </div>

      <!-- Judge + options two-column -->
      <div class="bf-field bf-judge-tests-grid">
        <div class="bf-judge-col">
          <div id="bv2-judge-roster">
            ${buildJudgeRoster(judgeRoster, config, onlineHosts)}
            ${_buildCloudJudgePicker(harnessTargets, harnessCatalogEnabled)}
          </div>
        </div>
        <div class="bf-options-col">
          <div class="bf-options-card">
            ${_buildMultiJudgeCard(judgeRoster)}
            <label class="bf-field-mini">
              <span>Thinking Policy <span style="color:var(--r-text-muted);font-size:0.65rem">(execution models)</span></span>
              <select id="bv2-think">
                <option value="auto" ${(!load(SK_THINK) || load(SK_THINK) === 'auto') ? 'selected' : ''}>Auto from profile</option>
                <option value="false" ${load(SK_THINK) === 'false' ? 'selected' : ''}>Force off control</option>
                <option value="true" ${load(SK_THINK) === 'true' ? 'selected' : ''}>Force on A/B</option>
              </select>
            </label>
            ${_buildAdvancedSettings()}
          </div>
        </div>
      </div>

      <!-- Level depth -->
      <div class="bf-field">
        <div class="depth-matrix">
          ${_buildLevelDepth()}
        </div>
        <div id="bv2-depth-summary" class="bf-depth-summary"></div>
      </div>

      <!-- Validation message -->
      <div id="bv2-form-error" style="display:none;color:var(--r-error);font-size:0.68rem;padding:0.3rem 0;"></div>

      <!-- Persistence disclosure -->
      <div class="bf-persist-strip">
        <span class="bf-persist-dot"></span>
        <span class="bf-persist-text">Config auto-saved to this browser</span>
        <div class="bf-persist-links">
          <button type="button" class="bf-link-btn" id="bv2-reset-defaults">Reset defaults</button>
          <button type="button" class="bf-link-btn" id="bv2-export-config">Export</button>
          <button type="button" class="bf-link-btn" id="bv2-import-config">Import</button>
          <input type="file" id="bv2-import-file" accept=".json" class="hidden">
          <button type="button" class="bf-link-btn" id="bv2-save-template">Save Template</button>
          <button type="button" class="bf-link-btn" id="bv2-load-template">Load Template</button>
        </div>
      </div>

    </form>`;
}

// ── Execution host (selected externally via infrastructure.js) ───────────────

function _wireModelTools(checklistEl, host) {
    if (!checklistEl) return;

    const form = checklistEl.closest('form') || checklistEl;
    const notifySelectionChanged = () => {
        _saveSelectedModels(form);
        _updateDepthSummary(form, _readLevelDepth(form));
        _updateModelSelectionBasket(form);
        form.dispatchEvent(new CustomEvent('config-changed', { bubbles: true }));
    };

    const applyFilters = () => {
        const query = (checklistEl.querySelector('#bv2-model-search')?.value || '').toLowerCase().trim();
        const source = checklistEl.querySelector('.mc-source-btn.is-active')?.dataset.sourceFilter || 'all';
        const activeFilters = new Set(
            Array.from(checklistEl.querySelectorAll('.mc-filter-chip[aria-pressed="true"]'))
                .map((button) => button.dataset.pickerFilter)
        );
        let visible = 0;
        Array.from(checklistEl.querySelectorAll('.mc-card'))
            .filter((card) => card.querySelector('.bv2-model-cb'))
            .forEach((card) => {
            const sourceMatches = source === 'all' || card.dataset.source === source;
            const queryMatches = !query || (card.dataset.filterText || '').includes(query);
            const filterMatches = [...activeFilters].every((filter) => {
                if (filter === 'ready') return card.dataset.ready === 'true';
                if (filter === 'free') return card.dataset.paid !== 'true';
                if (filter === 'paid') return card.dataset.paid === 'true';
                if (filter === 'judge') return card.dataset.judge === 'true';
                return true;
            });
            const show = sourceMatches && queryMatches && filterMatches;
            card.hidden = !show;
            if (show) visible += 1;
        });
        checklistEl.querySelectorAll('.mc-tier-group').forEach((group) => {
            const cards = Array.from(group.querySelectorAll('.mc-card'))
                .filter((card) => card.querySelector('.bv2-model-cb'));
            if (cards.length) group.hidden = cards.every((card) => card.hidden);
        });
        const empty = checklistEl.querySelector('#bv2-model-filter-empty');
        if (empty) empty.hidden = visible > 0;
    };

    // Search filter
    const search = checklistEl.querySelector('#bv2-model-search');
    if (search) search.addEventListener('input', applyFilters);

    checklistEl.querySelectorAll('.mc-source-btn').forEach((button) => {
        button.addEventListener('click', () => {
            checklistEl.querySelectorAll('.mc-source-btn').forEach((candidate) => {
                const selected = candidate === button;
                candidate.classList.toggle('is-active', selected);
                candidate.setAttribute('aria-pressed', String(selected));
            });
            applyFilters();
        });
    });

    checklistEl.querySelectorAll('.mc-filter-chip').forEach((button) => {
        button.addEventListener('click', () => {
            button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
            applyFilters();
        });
    });

    const paidOptIn = checklistEl.querySelector('#bv2-allow-paid');
    if (paidOptIn) {
        paidOptIn.addEventListener('change', () => {
            const allowPaid = paidOptIn.checked;
            form.querySelectorAll('input[data-paid-lock="true"]').forEach((input) => {
                input.disabled = !allowPaid;
                if (!allowPaid) input.checked = false;
                const card = input.closest('.mc-card');
                card?.classList.toggle('mc-paid-locked', !allowPaid);
                const note = card?.querySelector('[data-paid-note]');
                if (note) note.textContent = allowPaid
                    ? 'Unlocked for manual selection. SpendGrant still required at launch.'
                    : 'Enable paid models, then select manually.';
            });
            if (!allowPaid) {
                const localJudge = form.querySelector('input[name="bv2-cloud-judge"][value=""]');
                if (localJudge) {
                    localJudge.checked = true;
                    localJudge.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
            notifySelectionChanged();
        });
    }

    // Preset buttons (global + per-tier)
    checklistEl.querySelectorAll('.mc-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            _applyPreset(checklistEl, host, btn.dataset.preset);
            notifySelectionChanged();
        });
    });
    checklistEl.querySelectorAll('.mc-tier-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tier = btn.dataset.tier;
            const action = btn.dataset.action; // 'select' or 'clear'
            const cards = checklistEl.querySelectorAll(`.mc-card[data-size-tier="${tier}"]`);
            cards.forEach(card => {
                const cb = card.querySelector('.bv2-model-cb');
                if (cb && !cb.disabled) { cb.checked = action === 'select'; card.classList.toggle('selected', cb.checked); }
            });
            notifySelectionChanged();
        });
    });

    applyFilters();
}

function _applyPreset(checklistEl, host, preset) {
    const details = Array.isArray(host?.modelDetails) ? host.modelDetails : [];
    const detailMap = new Map(details.map(d => [normModel(d.name), d]));
    const allCbs = Array.from(checklistEl.querySelectorAll('.bv2-model-cb'));
    // Recipes are deliberately non-paid. Paid targets always require a manual click.
    const cbs = allCbs.filter((cb) => !cb.disabled && cb.dataset.paid !== 'true');
    const localCbs = cbs.filter((cb) => cb.dataset.executionKind !== 'harness');
    const freeCloudCbs = cbs.filter((cb) => cb.dataset.executionKind === 'harness');
    const hasLastBatchSelection = (Array.isArray(_lastBatch?.models) && _lastBatch.models.length > 0)
        || (Array.isArray(_lastBatch?.targets) && _lastBatch.targets.length > 0);
    if (preset === 'lastbatch' && !hasLastBatchSelection) return;

    allCbs.forEach((cb) => { cb.checked = false; });

    if (preset === 'quick') {
        const sorted = localCbs
            .map(cb => ({ cb, size: _parseParamSize(detailMap.get(normModel(cb.value))?.parameterSize) || 999 }))
            .sort((a, b) => a.size - b.size);
        sorted.slice(0, 3).forEach(({ cb }) => { cb.checked = true; });
    } else if (preset === 'balanced') {
        const smallestLocal = localCbs
            .map(cb => ({ cb, size: _parseParamSize(detailMap.get(normModel(cb.value))?.parameterSize) || 999 }))
            .sort((a, b) => a.size - b.size)[0]?.cb;
        if (smallestLocal) smallestLocal.checked = true;
        if (freeCloudCbs[0]) freeCloudCbs[0].checked = true;
    } else if (preset === 'free-cloud') {
        freeCloudCbs.forEach((cb) => { cb.checked = true; });
    } else if (preset === 'recommended') {
        const tiers = { small: null, medium: null, large: null };
        const sorted = localCbs
            .map(cb => ({ cb, size: _parseParamSize(detailMap.get(normModel(cb.value))?.parameterSize) || 0 }))
            .sort((a, b) => a.size - b.size);
        for (const { cb, size } of sorted) {
            if (size > 0 && size <= 4 && !tiers.small) tiers.small = cb;
            else if (size > 4 && size <= 10 && !tiers.medium) tiers.medium = cb;
            else if (size > 10 && !tiers.large) tiers.large = cb;
        }
        Object.values(tiers).filter(Boolean).forEach(cb => { cb.checked = true; });
    } else if (preset === 'unbenchmarked') {
        localCbs.forEach(cb => {
            const card = cb.closest('.mc-card');
            cb.checked = card?.dataset.benchmarked === 'false';
        });
    } else if (preset === 'lastbatch') {
        const lastModels = Array.isArray(_lastBatch?.models) ? _lastBatch.models : [];
        const lastTargets = Array.isArray(_lastBatch?.targets) ? _lastBatch.targets : [];
        const lastSet = new Set([
            ...lastModels.map((model) => normModel(typeof model === 'string' ? model : model?.model || model?.name || '')),
            ...lastTargets.map((target) => typeof target === 'string' ? target : target?.id || target?.targetId || ''),
        ].filter(Boolean));
        cbs.forEach(cb => {
            cb.checked = lastSet.has(cb.value) || lastSet.has(normModel(cb.value));
        });
    } else if (preset === 'filtered') {
        Array.from(checklistEl.querySelectorAll('.mc-card'))
            .filter((card) => card.querySelector('.bv2-model-cb'))
            .forEach(card => {
            if (card.hidden) return;
            const cb = card.querySelector('.bv2-model-cb');
            if (cb && !cb.disabled && cb.dataset.paid !== 'true') cb.checked = true;
        });
    }

    // Update card selected visuals
    checklistEl.querySelectorAll('.mc-card').forEach(card => {
        const cb = card.querySelector('.bv2-model-cb');
        card.classList.toggle('selected', cb?.checked || false);
    });

    _updateModelSelectionBasket(checklistEl.closest('form') || checklistEl);
}

function _updateModelSelectionBasket(container) {
    const selected = Array.from(container.querySelectorAll('.bv2-model-cb:checked'));
    const local = selected.filter((input) => input.dataset.executionKind !== 'harness').length;
    const cloud = selected.length - local;
    const paid = selected.filter((input) => input.dataset.paid === 'true').length;
    const count = container.querySelector('[data-basket-count]');
    const detail = container.querySelector('[data-basket-detail]');
    if (count) count.textContent = `${selected.length} contender${selected.length === 1 ? '' : 's'}`;
    if (detail) detail.textContent = selected.length
        ? `${local} local · ${cloud} cloud · ${paid} paid`
        : 'Choose ready local or cloud models.';
    Array.from(container.querySelectorAll('.mc-card'))
        .filter((card) => card.querySelector('.bv2-model-cb'))
        .forEach((card) => {
        card.classList.toggle('selected', card.querySelector('.bv2-model-cb')?.checked === true);
    });
}

// ── Level depth (off / single / light / full per level) ───────────────────────

function _estimateCount(level, depth) {
    const n = LEVEL_PROMPTS[level] || 7;
    const c = LEVEL_CATS[level] || 7;
    if (depth === 'off')    return 0;
    if (depth === 'single') return 1;
    if (depth === 'light')  return c;
    return n; // full
}

function _buildLevelDepth() {
    const saved = loadObj(SK_DEPTH);
    const cfg = { ...DEFAULT_LEVEL_DEPTH, ...saved };

    // Depth presets bar
    let html = `<div class="dm-presets">
      <button type="button" class="dm-preset-btn" data-dpreset="smoke" title="Smoke Test: Quick validation on basic prompts only (L1-L2, 1 prompt each). Good for checking if a model loads and responds. Est. ~2 tests across 2 levels.">\uD83D\uDD25 Smoke Test</button>
      <button type="button" class="dm-preset-btn" data-dpreset="standard" title="Standard Eval: Balanced coverage across difficulties (L1-L3 full, L4 light, L5 off). Recommended for most comparisons. Est. ~63 tests across 4 levels.">\uD83D\uDCCA Standard Eval</button>
      <button type="button" class="dm-preset-btn" data-dpreset="deep" title="Deep Dive: Full coverage including hardest prompts (all levels, all prompts). Best for thorough evaluation. Est. ~84 tests across 5 levels.">\uD83D\uDD2C Deep Dive</button>
      <button type="button" class="dm-preset-btn mc-preset-accent" data-dpreset="lastbatch" title="Restore depth settings from your previous benchmark run.">\uD83D\uDD01 Last Batch</button>
      <span class="dm-col-hint">Click column headers to set all levels</span>
    </div>`;

    // Table
    html += '<table class="dm-table"><thead><tr><th class="dm-cat">Level</th>';
    DEPTH_OPTIONS.forEach(d => {
        html += `<th class="dm-col-header" data-col-depth="${d}" style="color:${DEPTH_COLORS[d]};cursor:pointer" title="Click to set all levels to ${DEPTH_LABELS[d]}">${DEPTH_LABELS[d]}</th>`;
    });
    html += '<th class="dm-est-header">Est.</th></tr></thead><tbody>';

    LEVELS.forEach((l, i) => {
        const current = cfg[l] || 'full';
        const est = _estimateCount(l, current);
        const altClass = i % 2 === 0 ? ' dm-row-alt' : '';
        html += `<tr class="${altClass}">`;
        html += `<td class="dm-cat dm-level-label">
          <div class="dm-level-top">
            <span class="dm-level-badge" style="color:${LEVEL_COLORS[l]};font-weight:700">${LEVEL_LABELS[l]}</span>
            <span class="dm-level-name">${LEVEL_NAMES[l]}</span>
            <span class="dm-level-counts">${LEVEL_PROMPTS[l]} prompts \u00B7 ${LEVEL_CATS[l]} cats</span>
          </div>
          <div class="dm-level-desc">${LEVEL_DESCS[l]}</div>
        </td>`;
        DEPTH_OPTIONS.forEach(d => {
            const checked = d === current ? 'checked' : '';
            const radioLabel = `${LEVEL_LABELS[l]} ${LEVEL_NAMES[l]}: ${DEPTH_LABELS[d]} depth`;
            html += `<td class="dm-radio-cell">
              <input type="radio" name="bv2-depth-${l}" class="bv2-depth-radio"
                data-level="${l}" data-depth="${d}" aria-label="${esc(radioLabel)}" ${checked}>
            </td>`;
        });
        html += `<td class="dm-est" id="bv2-est-${l}">${est}</td></tr>`;
    });

    html += '</tbody></table>';
    return html;
}

function _wireDepthPersist(container) {
    // Radio changes
    container.addEventListener('change', e => {
        if (!e.target.classList.contains('bv2-depth-radio')) return;
        const cfg = _readLevelDepth(container);
        save(SK_DEPTH, JSON.stringify(cfg));
        _updateDepthSummary(container, cfg);
        const level = parseInt(e.target.dataset.level, 10);
        const depth = e.target.dataset.depth;
        const estEl = container.querySelector(`#bv2-est-${level}`);
        if (estEl) estEl.textContent = _estimateCount(level, depth);
    });

    // Clickable column headers
    container.addEventListener('click', e => {
        const colHeader = e.target.closest('.dm-col-header');
        if (!colHeader) return;
        const depth = colHeader.dataset.colDepth;
        if (!depth) return;
        LEVELS.forEach(l => {
            const radio = container.querySelector(`input[name="bv2-depth-${l}"][data-depth="${depth}"]`);
            if (radio) radio.checked = true;
            const estEl = container.querySelector(`#bv2-est-${l}`);
            if (estEl) estEl.textContent = _estimateCount(l, depth);
        });
        const cfg = _readLevelDepth(container);
        save(SK_DEPTH, JSON.stringify(cfg));
        _updateDepthSummary(container, cfg);
        _notifyConfigChanged(container);
    });

    // Depth presets
    container.querySelectorAll('.dm-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.dpreset;
            let presetCfg;
            if (key === 'lastbatch') {
                if (!_lastBatch?.depth_config) return;
                presetCfg = _lastBatch.depth_config;
                // Also restore advanced settings from last batch
                _applyLastBatchAdvancedSettings(container, _lastBatch);
            } else {
                presetCfg = DEPTH_PRESETS[key];
                if (key === 'smoke') {
                    _applySmokeExecutionPreset(container);
                }
            }
            if (!presetCfg) return;
            _applyDepthPreset(container, presetCfg);
            // Toggle active indicator
            container.querySelectorAll('.dm-preset-btn').forEach(b => b.classList.remove('dm-preset-active'));
            btn.classList.add('dm-preset-active');
            _notifyConfigChanged(container);
        });
    });

    // Initial summary
    _updateDepthSummary(container, _readLevelDepth(container));
}

function _notifyConfigChanged(container) {
    container.dispatchEvent(new CustomEvent('config-changed', { bubbles: true }));
}

function _wireThinkPersist(container) {
    const select = container.querySelector('#bv2-think');
    if (!select) return;
    select.addEventListener('change', () => save(SK_THINK, select.value || 'auto'));
}

function _applyLastBatchAdvancedSettings(container, lastBatch) {
    if (!lastBatch) return;
    const current = _loadAdvancedSettings();
    // Restore judge behavior from last batch's judge_config
    if (lastBatch.judge_config && typeof lastBatch.judge_config === 'object') {
        const jc = lastBatch.judge_config;
        const judgeKeys = ['temperature', 'num_predict', 'num_ctx', 'max_retries', 'timeout', 'voting_count', 'think'];
        judgeKeys.forEach(k => { if (jc[k] !== undefined) current[k] = jc[k]; });
    }
    // Restore pipeline timeouts from last batch's execution_config
    if (lastBatch.execution_config && typeof lastBatch.execution_config === 'object') {
        const ec = lastBatch.execution_config;
        const pipelineKeys = ['response_max_tokens', 'per_test_timeout_ms', 'warmup_timeout_cold', 'warmup_timeout_loaded', 'judge_drain_timeout_ms', 'judge_stall_timeout_ms', 'answer_contract_mode', 'include_length_hint', 'length_hint_template', 'custom_hint'];
        pipelineKeys.forEach(k => { if (ec[k] !== undefined) current[k] = ec[k]; });
        if (ec.think !== undefined) save(SK_THINK, String(ec.think));
        // Fairness keys: server uses unprefixed names (temperature/top_p/...);
        // local UI prefixes them as exec_* to avoid clashing with judge.temperature.
        if (ec.force_num_ctx !== undefined) current.force_num_ctx = ec.force_num_ctx;
        if (ec.temperature !== undefined) current.exec_temperature = ec.temperature;
        if (ec.top_p !== undefined) current.exec_top_p = ec.top_p;
        if (ec.top_k !== undefined) current.exec_top_k = ec.top_k;
        if (ec.repeat_penalty !== undefined) current.exec_repeat_penalty = ec.repeat_penalty;
        if (ec.seed !== undefined) current.exec_seed = ec.seed;
        if (ec.repeats !== undefined) current.exec_repeats = ec.repeats;
    }
    save(SK_ADVANCED, JSON.stringify(current));
    container.querySelectorAll('[data-adv-key]').forEach(el => {
        const k = el.dataset.advKey;
        if (el.type === 'checkbox') {
            el.checked = !!current[k];
        } else if (el.tagName === 'SELECT') {
            el.value = String(current[k]);
        } else {
            el.value = current[k];
        }
    });
    _updateAdvancedSummary(container, current);
}

function _applySmokeExecutionPreset(container) {
    const current = _loadAdvancedSettings();
    current.response_max_tokens = 400;
    current.per_test_timeout_ms = 120000;
    save(SK_ADVANCED, JSON.stringify(current));
    container.querySelectorAll('[data-adv-key]').forEach(el => {
        const k = el.dataset.advKey;
        if (!(k in current)) return;
        if (el.type === 'checkbox') {
            el.checked = !!current[k];
        } else if (el.tagName === 'SELECT') {
            el.value = String(current[k]);
        } else {
            el.value = current[k];
        }
    });
    _updateAdvancedSummary(container, current);
}

function _applyDepthPreset(container, presetCfg) {
    LEVELS.forEach(l => {
        const depth = presetCfg[l] || 'off';
        const radio = container.querySelector(`input[name="bv2-depth-${l}"][data-depth="${depth}"]`);
        if (radio) radio.checked = true;
        const estEl = container.querySelector(`#bv2-est-${l}`);
        if (estEl) estEl.textContent = _estimateCount(l, depth);
    });
    const cfg = _readLevelDepth(container);
    save(SK_DEPTH, JSON.stringify(cfg));
    _updateDepthSummary(container, cfg);
}

function _readLevelDepth(container) {
    const cfg = { ...DEFAULT_LEVEL_DEPTH };
    container.querySelectorAll('.bv2-depth-radio:checked').forEach(r => {
        const level = parseInt(r.dataset.level, 10);
        cfg[level] = r.dataset.depth;
    });
    return cfg;
}

function _updateDepthSummary(container, cfg) {
    const el = container.querySelector('#bv2-depth-summary');
    if (!el) return;
    const activeLevels = LEVELS.filter(l => cfg[l] !== 'off');
    const total = LEVELS.reduce((s, l) => s + _estimateCount(l, cfg[l] || 'off'), 0);
    const modelsChecked = container.querySelectorAll('.bv2-model-cb:checked').length;
    const testCount = total * modelsChecked;
    const estMin = Math.ceil(testCount * 30 / 60); // rough ~30s/test heuristic
    const timeStr = estMin > 0 ? ` \u00B7 est. ~${estMin}min` : '';
    el.innerHTML = `<span class="dm-summary-levels">${activeLevels.length} level${activeLevels.length !== 1 ? 's' : ''} active</span> \u00B7 ~${total} prompts \u00D7 ${modelsChecked} model${modelsChecked !== 1 ? 's' : ''} = <span class="dm-summary-tests">~${testCount} tests</span>${timeStr}`;
}

function _deriveLevels(cfg) {
    return LEVELS.filter(l => cfg[l] && cfg[l] !== 'off');
}

// ── Preflight display helpers ─────────────────────────────────────────────────

function _setLaunchSummaryStatus(state, message, detail = '') {
    const statusEl = document.getElementById('ls-launch-status');
    if (!statusEl) return;

    statusEl.dataset.launchState = state;
    statusEl.className = `ls-launch-status ls-launch-${state}`;
    statusEl.innerHTML = `
      <span class="ls-launch-status-kicker">${esc(message)}</span>
      ${detail ? `<span class="ls-launch-status-detail">${esc(detail)}</span>` : ''}`;
}

function _publishLaunchStatus(container, state, message, detail = '') {
    _setLaunchSummaryStatus(state, message, detail);
    container.dispatchEvent(new CustomEvent('benchmark-launch-status', {
        bubbles: true,
        detail: { state, message, detail }
    }));
}

function _resetLaunchButton() {
    const btn = document.querySelector('#ls-launch-btn');
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = 'Launch Benchmark';
    btn.style.opacity = '';
}

/** Extract warnings from the nested preflight checks object */
function _collectPreflightWarnings(pf) {
    if (!pf?.checks) return [];
    const warnings = [];
    // Top-level warnings (dedication, etc.)
    if (Array.isArray(pf.warnings)) warnings.push(...pf.warnings);
    const c = pf.checks;
    if (Array.isArray(c.hosts)) {
        c.hosts.forEach(h => {
            if (Array.isArray(h.warnings)) warnings.push(...h.warnings);
            if (h.host_ok === false) warnings.push(`Host ${h.host || 'unknown'}: ${h.error || 'unreachable'}`);
        });
    }
    if (c.judge) {
        if (Array.isArray(c.judge.warnings)) warnings.push(...c.judge.warnings);
        if (Array.isArray(c.judge.blockers)) warnings.push(...c.judge.blockers);
    }
    if (c.prompts) {
        if (Array.isArray(c.prompts.warnings)) warnings.push(...c.prompts.warnings);
        if (Array.isArray(c.prompts.blockers)) warnings.push(...c.prompts.blockers);
    }
    if (c.dedication?.warnings?.length) {
        warnings.push(...c.dedication.warnings);
    }
    return warnings;
}

/** Show a preflight issues/warnings banner above the launch button */
function _showPreflightBanner(container, errors, warnings, isBlocking) {
    _clearPreflightBanner(container);
    if (!errors.length && !warnings.length) return;
    const banner = document.createElement('div');
    banner.id = 'bv2-preflight-banner';
    banner.style.cssText = `margin:0.5rem 0;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.72rem;line-height:1.5;border:1px solid ${isBlocking ? 'rgba(239,83,80,0.3)' : 'rgba(210,153,34,0.3)'};background:${isBlocking ? 'rgba(239,83,80,0.08)' : 'rgba(210,153,34,0.08)'};color:${isBlocking ? 'var(--r-error,#f85149)' : 'var(--r-warn,#d29922)'}`;
    const title = isBlocking ? 'Preflight errors (launch blocked):' : 'Preflight warnings:';
    let html = `<div style="font-weight:600;margin-bottom:0.25rem;">${esc(title)}</div><ul style="margin:0;padding-left:1.2rem;">`;
    for (const e of errors)   html += `<li>${esc(e)}</li>`;
    for (const w of warnings) html += `<li>${esc(w)}</li>`;
    html += '</ul>';
    banner.innerHTML = html;
    const errEl = container.querySelector('#bv2-form-error');
    if (errEl) errEl.parentNode.insertBefore(banner, errEl);
    else container.appendChild(banner);
}

/** Remove preflight banner if present */
function _clearPreflightBanner(container) {
    const existing = container.querySelector('#bv2-preflight-banner');
    if (existing) existing.remove();
}

// ── Form submit / launch ──────────────────────────────────────────────────────

function _wireSubmit(container, host, onLaunch) {
    const form = container.querySelector('#bv2-batch-form');
    if (!form) return;

    form.addEventListener('submit', async e => {
        e.preventDefault();
        await _handleLaunch(container, host, onLaunch);
    });
}

async function _handleLaunch(container, host, onLaunch) {
    const errEl = container.querySelector('#bv2-form-error');
    const btn   = document.querySelector('#ls-launch-btn');

    function showErr(msg) { if (errEl) { errEl.textContent = msg; errEl.style.display = ''; } }
    function clearErr()   { if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; } }

    clearErr();
    _clearPreflightBanner(container);
    _publishLaunchStatus(
        container,
        'checking',
        'Checking launch inputs',
        'Validating host, models, judge, and selected prompt depth.'
    );

    // 1. Execution host — from infrastructure selection, not a dropdown
    const execHostUrl = _currentHost?.hostUrl || _currentHost?.url || '';
    const selectedCandidateCbs = Array.from(container.querySelectorAll('.bv2-model-cb:checked'));
    const needsOllamaHost = selectedCandidateCbs.some((cb) => cb.dataset.executionKind !== 'harness');
    if (!execHostUrl && needsOllamaHost) {
        const message = 'Select an execution host in the Infrastructure section above.';
        showErr(message);
        _publishLaunchStatus(container, 'blocked', 'Launch blocked', message);
        _resetLaunchButton();
        return;
    }

    try {
        if (execHostUrl && needsOllamaHost) {
        _publishLaunchStatus(
            container,
            'checking',
            'Checking profiler activity',
            'Confirming the selected host is not busy with profiling.'
        );
            const profilingState = await fetchActiveProfilingState();
            const activeProfiling = findProfilingForHost(_currentHost || execHostUrl, profilingState);
            if (activeProfiling.length) {
                const message = `${formatProfilingLockout(activeProfiling)}. Wait for profiling to finish or cancel it before launching a benchmark.`;
                showErr(message);
                _publishLaunchStatus(container, 'blocked', 'Launch blocked by profiler', message);
                _resetLaunchButton();
                return;
            }
        }
    } catch (err) {
        const message = `Could not verify profiler activity: ${err.message}`;
        showErr(message);
        _publishLaunchStatus(container, 'blocked', 'Profiler check failed', message);
        _resetLaunchButton();
        return;
    }

    // 2. Selected models
    const modelCbs = selectedCandidateCbs;
    if (!modelCbs.length) {
        const message = 'Select at least one model.';
        showErr(message);
        _publishLaunchStatus(container, 'blocked', 'Launch blocked', message);
        _resetLaunchButton();
        return;
    }
    const localModelCbs = modelCbs.filter((cb) => cb.dataset.executionKind !== 'harness');
    const cloudModelCbs = modelCbs.filter((cb) => cb.dataset.executionKind === 'harness');
    const models = localModelCbs.map(cb => cb.value);
    const targets = [
        ...localModelCbs.map((cb) => ({ host: cb.dataset.host || execHostUrl, model: cb.value })),
        ...cloudModelCbs.map((cb) => _harnessTargetMap.get(cb.dataset.targetId)).filter(Boolean)
    ];

    // 3. Judge config (from roster or fallback)
    const judge = getSelectedJudge(container);
    const cloudJudgeTarget = judge.targetId ? _harnessTargetMap.get(judge.targetId) : null;
    if (!judge.model) {
        const message = 'Select a judge model.';
        showErr(message);
        _publishLaunchStatus(container, 'blocked', 'Launch blocked', message);
        _resetLaunchButton();
        return;
    }
    if (!judge.host && !cloudJudgeTarget)  {
        const message = 'Select a judge host.';
        showErr(message);
        _publishLaunchStatus(container, 'blocked', 'Launch blocked', message);
        _resetLaunchButton();
        return;
    }

    // 4. Level depth
    const depthConfig = _readLevelDepth(container);
    const levels      = _deriveLevels(depthConfig);
    if (!levels.length) {
        const message = 'All levels are Off — enable at least one.';
        showErr(message);
        _publishLaunchStatus(container, 'blocked', 'Launch blocked', message);
        _resetLaunchButton();
        return;
    }
    const advSettings = _readAdvancedSettings(container);

    // 5. Preflight — surface errors and warnings before launch
    if (btn) { btn.disabled = true; btn.textContent = '\u27F3 Preflight\u2026'; }
    _publishLaunchStatus(
        container,
        'preflight',
        'Running preflight checks',
        'Checking host reachability, selected models, judge availability, prompts, and batch locks.'
    );

    let preflightResult;
    try {
        const hasHarnessExecution = cloudModelCbs.length > 0 || !!cloudJudgeTarget;
        const pfRes = hasHarnessExecution ? { data: {
            ready: true,
            issues: [],
            checks: { harness_catalog: { ready: true, server_revalidates_before_each_cell: true } }
        } } : await preflight({
            targets: models.map(model => ({ host: execHostUrl, model })),
            judge_config: {
                model: judge.model,
                host: judge.host,
                temperature: advSettings.temperature,
                num_predict: advSettings.num_predict,
                num_ctx: advSettings.num_ctx,
                max_retries: advSettings.max_retries,
                timeout: advSettings.timeout,
                voting_count: advSettings.voting_count,
                think: advSettings.think
            },
            levels,
            execution_config: {
                response_max_tokens: advSettings.response_max_tokens,
                answer_contract_mode: advSettings.answer_contract_mode,
                include_length_hint: !!advSettings.include_length_hint,
                length_hint_template: advSettings.length_hint_template,
                custom_hint: advSettings.custom_hint,
                think: container.querySelector('#bv2-think')?.value || 'auto'
            }
        });
        preflightResult = pfRes?.data || pfRes;
    } catch (err) {
        const message = `Preflight failed: ${err.message}`;
        showErr(message);
        _publishLaunchStatus(container, 'blocked', 'Preflight failed', message);
        _resetLaunchButton();
        return;
    }

    // Collect warnings from the checks object
    const pfWarnings = _collectPreflightWarnings(preflightResult);

    // If preflight has blocking issues, show them and abort
    if (preflightResult && preflightResult.ready === false) {
        const issues = preflightResult.issues || [];
        const detail = issues.length ? issues.map(i => '\u2022 ' + i).join('\n') : 'Unknown preflight error';
        showErr('Preflight blocked:\n' + detail);
        _showPreflightBanner(container, issues, pfWarnings, true);
        _publishLaunchStatus(
            container,
            'blocked',
            'Preflight blocked launch',
            issues.length ? issues.join(' • ') : 'Unknown preflight error'
        );
        _resetLaunchButton();
        return;
    }

    // If there are warnings but preflight passed, show them but allow launch
    if (pfWarnings.length > 0) {
        _showPreflightBanner(container, [], pfWarnings, false);
    } else {
        _clearPreflightBanner(container);
    }

    // 6. Build payload — merge advanced settings into judge_config and execution_config
    const think = container.querySelector('#bv2-think')?.value || 'auto';
    const selectedPromptCount = LEVELS.reduce((sum, level) => sum + _estimateCount(level, depthConfig[level] || 'off'), 0);
    const repeats = Math.max(1, Math.min(5, Number(advSettings.exec_repeats) || 1));
    const paidCandidateTargets = targets.filter((target) => target?.tier === 'paid_cloud');
    const callsPerCandidate = selectedPromptCount * repeats;
    let maxCalls = paidCandidateTargets.length * callsPerCandidate;
    const judgeAttempts = Math.max(1, Math.min(6, Number(advSettings.max_retries ?? 2) + 1));
    if (cloudJudgeTarget?.tier === 'paid_cloud') maxCalls += targets.length * callsPerCandidate * judgeAttempts;
    const paidUnits = [
        ...paidCandidateTargets.map((target) => ({ target, calls: callsPerCandidate })),
        ...(cloudJudgeTarget?.tier === 'paid_cloud' ? [{ target: cloudJudgeTarget, calls: targets.length * callsPerCandidate * judgeAttempts }] : [])
    ];
    const inputTokensPerCall = 32_000;
    const outputTokensPerCall = Math.max(1, Number(advSettings.response_max_tokens) || 32_000);
    const maxCostNanodollars = paidUnits.reduce((sum, { target, calls }) => {
        const price = target.pricing || {};
        return sum + calls * Number(price.callNanodollars || 0)
            + calls * Math.ceil(inputTokensPerCall * Number(price.inputNanodollarsPerMillion || 0) / 1_000_000)
            + calls * Math.ceil(outputTokensPerCall * Number(price.outputNanodollarsPerMillion || 0) / 1_000_000);
    }, 0);
    let paidApproval = null;
    if (maxCalls > 0) {
        const estimatedUsd = (maxCostNanodollars / 1e9).toFixed(6);
        if (!window.confirm(`Paid cloud execution\n\nWorst-case manual estimate: US$${estimatedUsd}\nCalls: ${maxCalls}\nTokens: ${maxCalls * (inputTokensPerCall + outputTokensPerCall)}\n\nApprove this one batch?`)) {
            _publishLaunchStatus(container, 'blocked', 'Paid execution not approved', 'No provider call was made.');
            _resetLaunchButton();
            return;
        }
        paidApproval = {
            confirmed: true,
            maxCalls,
            maxTokens: maxCalls * (inputTokensPerCall + outputTokensPerCall),
            maxCostNanodollars
        };
    }
    const batchConfig = {
        host: execHostUrl || 'harness',
        models,
        targets,
        levels,
        depth_config: depthConfig,
        judge_config: {
            model: judge.model,
            host: judge.host,
            ...(cloudJudgeTarget ? { target: cloudJudgeTarget } : {}),
            temperature: advSettings.temperature,
            num_predict: advSettings.num_predict,
            num_ctx: advSettings.num_ctx,
            max_retries: advSettings.max_retries,
            timeout: advSettings.timeout,
            voting_count: advSettings.voting_count,
            think: advSettings.think
        },
        multi_judge:  _readMultiJudgeFromUI(container),
        execution_config: {
            think,
            response_max_tokens: advSettings.response_max_tokens,
            per_test_timeout_ms: advSettings.per_test_timeout_ms,
            warmup_timeout_cold: advSettings.warmup_timeout_cold,
            warmup_timeout_loaded: advSettings.warmup_timeout_loaded,
            judge_drain_timeout_ms: advSettings.judge_drain_timeout_ms,
            judge_stall_timeout_ms: advSettings.judge_stall_timeout_ms,
            answer_contract_mode: advSettings.answer_contract_mode,
            include_length_hint: !!advSettings.include_length_hint,
            length_hint_template: advSettings.length_hint_template,
            custom_hint: advSettings.custom_hint,
            // Fairness — undefined means "use server default", null means "explicitly off"
            force_num_ctx: (advSettings.force_num_ctx === '' || advSettings.force_num_ctx === undefined)
                ? null : Number(advSettings.force_num_ctx) || null,
            temperature: advSettings.exec_temperature,
            top_p: advSettings.exec_top_p,
            top_k: advSettings.exec_top_k,
            repeat_penalty: advSettings.exec_repeat_penalty,
            seed: (advSettings.exec_seed === '' || advSettings.exec_seed === undefined || advSettings.exec_seed === null)
                ? null : Number(advSettings.exec_seed),
            repeats
        },
        paid_approval: paidApproval,
    };

    if (btn) { btn.textContent = 'Launching\u2026'; }
    _publishLaunchStatus(
        container,
        'launching',
        'Launching benchmark',
        `${models.length} model${models.length === 1 ? '' : 's'} across ${levels.length} active level${levels.length === 1 ? '' : 's'}.`
    );

    if (typeof onLaunch === 'function') {
        try {
            await onLaunch(batchConfig);
        } finally {
            // A failed start leaves the form in place. Restore the primary
            // action so the operator can adjust the inputs and retry.
            _resetLaunchButton();
        }
    }
}

// ── Persistence UI (export / import / reset) ─────────────────────────────────

function _wirePersistenceUI(container, onlineHosts, config, judgeRoster, onLaunch) {
    // Reset
    const resetBtn = container.querySelector('#bv2-reset-defaults');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            [SK_DEPTH, SK_JUDGE, SK_MODELS, SK_HOST, SK_THINK, SK_ADVANCED].forEach(k => {
                try { localStorage.removeItem(k); } catch (_) {}
            });
            // Re-render
            renderBatchConfig(container.closest('#batch-config') || container, {
                host: _currentHost, prompts: [], config, judgeRoster,
                harnessTargets: [..._harnessTargetMap.values()], harnessCatalogEnabled: _harnessCatalogEnabled, lastBatch: _lastBatch,
                onLaunch,
            });
        });
    }

    // Export
    const exportBtn = container.querySelector('#bv2-export-config');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            const data = {
                version: 1,
                execHost: load(SK_HOST) || '',
                selectedModels: loadArr(SK_MODELS),
                judgeConfig: loadObj(SK_JUDGE),
                depthMatrix: loadObj(SK_DEPTH),
                advancedSettings: loadObj(SK_ADVANCED),
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `benchmark-config-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    // Import
    const importBtn = container.querySelector('#bv2-import-config');
    const importFile = container.querySelector('#bv2-import-file');
    if (importBtn && importFile) {
        importBtn.addEventListener('click', () => importFile.click());
        importFile.addEventListener('change', async () => {
            const file = importFile.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                if (data.version !== 1) throw new Error('Unsupported config version');
                if (data.execHost) save(SK_HOST, data.execHost);
                if (data.selectedModels) save(SK_MODELS, JSON.stringify(data.selectedModels));
                if (data.judgeConfig) save(SK_JUDGE, JSON.stringify(data.judgeConfig));
                if (data.depthMatrix) save(SK_DEPTH, JSON.stringify(data.depthMatrix));
                if (data.advancedSettings) save(SK_ADVANCED, JSON.stringify(data.advancedSettings));
                // Re-render
                renderBatchConfig(container.closest('#batch-config') || container, {
                    host: _currentHost, prompts: [], config, judgeRoster,
                    harnessTargets: [..._harnessTargetMap.values()], harnessCatalogEnabled: _harnessCatalogEnabled, lastBatch: _lastBatch,
                    onLaunch,
                });
            } catch (err) {
                console.warn('[bv2] Import failed:', err.message);
            }
        });
    }

    // Save Template
    const saveTemplateBtn = container.querySelector('#bv2-save-template');
    if (saveTemplateBtn) {
        saveTemplateBtn.addEventListener('click', async () => {
            const name = prompt('Template name:');
            if (!name || !name.trim()) return;
            try {
                const config = {
                    host: load(SK_HOST) || '',
                    models: loadArr(SK_MODELS),
                    levels: loadObj(SK_DEPTH)
                        ? Object.entries(loadObj(SK_DEPTH)).filter(([, v]) => v !== 'off').map(([k]) => Number(k))
                        : LEVELS,
                    judge_config: loadObj(SK_JUDGE) || {},
                    execution_config: { ...(loadObj(SK_ADVANCED) || {}), think: load(SK_THINK) || 'auto' },
                    depth_config: loadObj(SK_DEPTH) || null,
                    execution_mode: loadObj(SK_ADVANCED)?.execution_mode || 'latency'
                };
                await saveTemplate({ name: name.trim(), config });
                showToast('Template saved', 'success');
            } catch (err) {
                showToast(err.message || 'Failed to save template', 'error');
            }
        });
    }

    // Load Template
    const loadTemplateBtn = container.querySelector('#bv2-load-template');
    if (loadTemplateBtn) {
        loadTemplateBtn.addEventListener('click', async () => {
            try {
                const res = await fetchTemplates();
                const templates = res.data || res;
                if (!templates.length) { showToast('No saved templates', 'info'); return; }

                // Build a quick picker overlay
                const overlay = document.createElement('div');
                overlay.className = 'ax-modal-overlay';
                overlay.innerHTML = `<div class="ax-modal-content" style="max-width:420px;">
                    <button class="ax-modal-close">&times;</button>
                    <h3 style="margin:0 0 0.75rem">Load Template</h3>
                    <ul style="list-style:none;padding:0;margin:0;max-height:320px;overflow-y:auto;">
                        ${templates.map(t => `<li style="padding:0.4rem 0;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--ax-border,#333);">
                            <button class="bf-link-btn bv2-tpl-pick" data-id="${esc(t._id)}" style="text-align:left;flex:1;">
                                <strong>${esc(t.name)}</strong>
                                <span style="opacity:0.6;font-size:0.75rem;margin-left:0.5rem">${t.config?.models?.length || 0} models</span>
                            </button>
                            <button class="bf-link-btn bv2-tpl-del" data-id="${esc(t._id)}" style="color:var(--r-error,#e55);font-size:0.7rem;">✕</button>
                        </li>`).join('')}
                    </ul>
                </div>`;

                const close = () => overlay.remove();
                overlay.querySelector('.ax-modal-close').addEventListener('click', close);
                overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

                overlay.addEventListener('click', async (e) => {
                    const pickBtn = e.target.closest('.bv2-tpl-pick');
                    const delBtn = e.target.closest('.bv2-tpl-del');
                    if (pickBtn) {
                        const tpl = templates.find(t => t._id === pickBtn.dataset.id);
                        if (!tpl) return;
                        const c = tpl.config || {};
                        if (c.host) save(SK_HOST, c.host);
                        if (c.models?.length) save(SK_MODELS, JSON.stringify(c.models));
                        if (c.judge_config) save(SK_JUDGE, JSON.stringify(c.judge_config));
                        if (c.depth_config) save(SK_DEPTH, JSON.stringify(c.depth_config));
                        if (c.execution_config) {
                            const { think: executionThink, ...executionAdvanced } = c.execution_config;
                            if (executionThink !== undefined) save(SK_THINK, String(executionThink));
                            save(SK_ADVANCED, JSON.stringify(executionAdvanced));
                        }
                        // Record usage
                        useTemplate(tpl._id).catch(() => {});
                        close();
                        renderBatchConfig(container.closest('#batch-config') || container, {
                            host: _currentHost, prompts: [], config, judgeRoster,
                            harnessTargets: [..._harnessTargetMap.values()], harnessCatalogEnabled: _harnessCatalogEnabled, lastBatch: _lastBatch,
                            onLaunch,
                        });
                        showToast(`Loaded "${tpl.name}"`, 'success');
                    }
                    if (delBtn) {
                        const template = templates.find(t => t._id === delBtn.dataset.id);
                        const expectedConfirmation = `DELETE TEMPLATE ${delBtn.dataset.id}`;
                        const confirmation = window.prompt(
                            `Delete template "${template?.name || 'Unnamed template'}"?\n\n`
                            + `Type ${expectedConfirmation} to confirm:`
                        );
                        if (confirmation !== expectedConfirmation) return;
                        try {
                            await deleteTemplate(delBtn.dataset.id, confirmation);
                            delBtn.closest('li').remove();
                            showToast('Template deleted', 'success');
                        } catch (err) {
                            showToast('Delete failed', 'error');
                        }
                    }
                });

                document.body.appendChild(overlay);
            } catch (err) {
                showToast(err.message || 'Failed to load templates', 'error');
            }
        });
    }
}

// ── Persistence helpers ───────────────────────────────────────────────────────

function _saveSelectedModels(container) {
    const checked = Array.from(container.querySelectorAll('.bv2-model-cb:checked')).map(cb => cb.value);
    save(SK_MODELS, JSON.stringify(checked));
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _isOnline(h)   { return h.available === true || h.status === 'online' || h.online === true; }
