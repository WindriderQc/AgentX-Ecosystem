import { showToast } from '../components/toast.js';

/**
 * scoring-profile.js — Scoring Profile Panel
 *
 * Self-contained module for the scoring profile modal.
 *
 * Sections:
 *   1. Category Weights   — generalist score per-category contribution
 *   2. Ranking Formula    — coverage penalty, consistency bonus, empty filter
 *
 * API:
 *   GET  /api/benchmark/scoring-profile
 *   PUT  /api/benchmark/scoring-profile
 *   POST /api/benchmark/scoring-profile/reset
 */

const CATEGORIES = ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'];
const CAT_LABELS = {
    coding: 'Coding', reasoning: 'Reasoning', math: 'Math',
    knowledge: 'Knowledge', instruction: 'Instruction',
    creative: 'Creative', translation: 'Translation'
};

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchProfile() {
    const res = await fetch('/api/benchmark/scoring-profile');
    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.error || 'Failed to load profile');
    return json.data;
}

async function saveProfile(overrides) {
    const res = await fetch('/api/benchmark/scoring-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(overrides)
    });
    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.error || 'Save failed');
    return json;
}

async function resetProfile() {
    const res = await fetch('/api/benchmark/scoring-profile/reset', { method: 'POST' });
    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.error || 'Reset failed');
    return json;
}

// ---------------------------------------------------------------------------
// Form helpers
// ---------------------------------------------------------------------------

function pct(v) { return (Number(v) * 100).toFixed(1); }

function sum(values) {
    return Object.values(values).reduce((s, v) => s + (Number(v) || 0), 0);
}

function weightRow(prefix, key, label, value, step = '0.01') {
    return `<div class="sp-row">
        <label class="sp-label" for="${prefix}-${key}">${label}</label>
        <input class="sp-input" type="number" id="${prefix}-${key}"
               name="${key}" value="${Number(value).toFixed(4)}"
               min="0" max="1" step="${step}">
        <span class="sp-pct">${pct(value)}%</span>
    </div>`;
}

function helpBox(text) {
    return `<div class="sp-help">${text}</div>`;
}

function parseLevels(value) {
    return [...new Set(String(value || '')
        .split(',')
        .map(v => Number(v.trim()))
        .filter(v => Number.isFinite(v) && v >= 1 && v <= 5)
        .map(v => Math.round(v)))]
        .sort((a, b) => a - b);
}

function sectionHeader(id, title) {
    return `<div class="sp-section-header" data-target="${id}">
        <span class="sp-section-arrow">&#9654;</span>
        <strong>${title}</strong>
    </div>`;
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderCategoryWeightsSection(profile) {
    const w = profile.categoryWeights || {};
    let rows = CATEGORIES.map(cat => weightRow('catw', cat, CAT_LABELS[cat], w[cat] || 0)).join('');
    const total = sum(w);
    const totalClass = Math.abs(total - 1.0) > 0.001 ? 'sp-total sp-total-error' : 'sp-total';
    rows += `<div class="${totalClass}" id="catw-total">Total: ${pct(total)}%</div>`;
    return `<div class="sp-section-body" id="sec-catweights">
        ${helpBox('These weights determine how much each evaluation category contributes to a model\'s overall generalist score. Higher weight = more influence on final ranking. All weights must sum to 100%.')}
        <div class="sp-grid" id="catw-grid">${rows}</div>
    </div>`;
}

function renderFormulaSection(profile) {
    const g = profile.generalist || {};

    function numRow(id, label, value, min, max, step = '1', help = '') {
        return `<div class="sp-row sp-row-formula">
            <div class="sp-row-labels">
                <label class="sp-label" for="${id}">${label}</label>
                <span class="sp-field-help">${help}</span>
            </div>
            <input class="sp-input sp-input-sm" type="number" id="${id}"
                   value="${value}" min="${min}" max="${max}" step="${step}">
        </div>`;
    }

    return `<div class="sp-section-body" id="sec-formula">
        ${helpBox('These parameters control the generalist leaderboard formula. Changes apply to the next leaderboard calculation — existing batch scores are not retroactively recalculated.')}
        <div class="sp-row sp-row-formula">
            <div class="sp-row-labels">
                <label class="sp-label" for="gp-confidenceWeighting">Weight composite by judge confidence</label>
                <span class="sp-field-help">When on, each category's avg quality is multiplied by its avg judge_confidence (0–1) before feeding the weighted composite. Rows with missing confidence count as 0.5. Off = legacy behavior (raw quality only).</span>
            </div>
            <input class="sp-input sp-input-sm" type="checkbox" id="gp-confidenceWeighting"
                   ${g.confidenceWeighting ? 'checked' : ''}>
        </div>
        ${numRow('gp-coveragePenaltyMax', 'Coverage Penalty Max (pts)',
            g.coveragePenaltyMax || 20, 0, 100, 1,
            'Points deducted per missing category (multiplied by category weight). Higher = stricter requirement for broad testing.')}
        ${numRow('gp-difficultyPenaltyMax', 'Hard-Level Penalty Max (pts)',
            g.difficultyPenaltyMax || 20, 0, 100, 1,
            'Points deducted when scored categories lack L4+ full-scope evidence. Higher = stricter separation between foundation and hard-suite results.')}
        ${numRow('gp-fullScopeMinLevel', 'Full-Scope Min Level',
            g.fullScopeMinLevel || 4, 1, 5, 1,
            'Prompt level that counts as hard evidence for full-scope generalist ranking. Default L4.')}
        <div class="sp-row sp-row-formula">
            <div class="sp-row-labels">
                <label class="sp-label" for="gp-requiredPromptLevels">Required Prompt Levels</label>
                <span class="sp-field-help">Comma-separated levels required before a row is treated as a full-scope leader. Default: 4,5.</span>
            </div>
            <input class="sp-input sp-input-sm" type="text" id="gp-requiredPromptLevels"
                   value="${(g.requiredPromptLevels || [4, 5]).join(',')}">
        </div>
        ${numRow('gp-minFullScopeResults', 'Min Full-Scope Results',
            g.minFullScopeResults || 28, 0, 1000, 1,
            'Minimum scored rows required before a model/host can rank as full-scope. Default 28 = 7 categories x L4/L5 evidence.')}
        ${numRow('gp-minConsistencyResults', 'Min Consistency-Bonus Results',
            g.minConsistencyResults || 42, 0, 1000, 1,
            'Minimum scored rows required before low variance earns the consistency bonus. Prevents tiny complete sweeps from getting over-rewarded.')}
        ${numRow('gp-evidenceConfidenceTarget', 'Evidence Confidence Target (0-1)',
            g.evidenceConfidenceTarget || 0.75, 0, 1, 0.05,
            'Average judge confidence target before the evidence-confidence penalty disappears.')}
        ${numRow('gp-evidenceConfidencePenaltyMax', 'Evidence Confidence Penalty Max (pts)',
            g.evidenceConfidencePenaltyMax || 8, 0, 100, 1,
            'Maximum points deducted when judge confidence is weak. Disabled when confidence weighting is turned on.')}
        ${numRow('gp-consistencyBonus', 'Consistency Bonus (pts)',
            g.consistencyBonus || 5, 0, 50, 1,
            'Bonus points for models that perform consistently across categories (low standard deviation).')}
        ${numRow('gp-consistencyStddevThreshold', 'Consistency Stddev Threshold',
            g.consistencyStddevThreshold || 15, 1, 100, 1,
            'Maximum within-category stddev (0-100 scale) to qualify for the consistency bonus.')}
        ${numRow('gp-minQualityForBonus', 'Min Quality for Bonus (0-100)',
            g.minQualityForBonus || 10, 0, 100, 1,
            'Models below this weighted quality score are ineligible for the consistency bonus.')}
        ${numRow('gp-emptyResponseFilterThreshold', 'Empty Response Filter (0-1)',
            g.emptyResponseFilterThreshold || 0.5, 0, 1, 0.05,
            'Models with more than this fraction of empty/failed responses are excluded from the leaderboard entirely.')}
    </div>`;
}

// ---------------------------------------------------------------------------
// Collect form values
// ---------------------------------------------------------------------------

function collectCategoryWeights(panel) {
    const result = {};
    CATEGORIES.forEach(cat => {
        const el = panel.querySelector(`#catw-${cat}`);
        if (el) result[cat] = parseFloat(el.value) || 0;
    });
    return result;
}

function collectGeneralistParams(panel) {
    return {
        coveragePenaltyMax: parseFloat(panel.querySelector('#gp-coveragePenaltyMax')?.value) || 20,
        difficultyPenaltyMax: parseFloat(panel.querySelector('#gp-difficultyPenaltyMax')?.value) || 20,
        fullScopeMinLevel: parseFloat(panel.querySelector('#gp-fullScopeMinLevel')?.value) || 4,
        requiredPromptLevels: parseLevels(panel.querySelector('#gp-requiredPromptLevels')?.value || '4,5'),
        minFullScopeResults: parseFloat(panel.querySelector('#gp-minFullScopeResults')?.value) || 28,
        minConsistencyResults: parseFloat(panel.querySelector('#gp-minConsistencyResults')?.value) || 42,
        evidenceConfidenceTarget: parseFloat(panel.querySelector('#gp-evidenceConfidenceTarget')?.value) || 0.75,
        evidenceConfidencePenaltyMax: parseFloat(panel.querySelector('#gp-evidenceConfidencePenaltyMax')?.value) || 8,
        consistencyBonus: parseFloat(panel.querySelector('#gp-consistencyBonus')?.value) || 5,
        consistencyStddevThreshold: parseFloat(panel.querySelector('#gp-consistencyStddevThreshold')?.value) || 15,
        minQualityForBonus: parseFloat(panel.querySelector('#gp-minQualityForBonus')?.value) || 10,
        emptyResponseFilterThreshold: parseFloat(panel.querySelector('#gp-emptyResponseFilterThreshold')?.value) || 0.5,
        confidenceWeighting: !!panel.querySelector('#gp-confidenceWeighting')?.checked
    };
}

// ---------------------------------------------------------------------------
// Live validation updates
// ---------------------------------------------------------------------------

function updateCategoryTotal(panel) {
    const vals = collectCategoryWeights(panel);
    const total = Object.values(vals).reduce((s, v) => s + v, 0);
    const el = panel.querySelector('#catw-total');
    if (!el) return;
    el.textContent = `Total: ${(total * 100).toFixed(1)}%`;
    el.className = Math.abs(total - 1.0) > 0.001 ? 'sp-total sp-total-error' : 'sp-total';
    // update pct labels
    CATEGORIES.forEach(cat => {
        const inp = panel.querySelector(`#catw-${cat}`);
        const pctEl = inp?.nextElementSibling;
        if (inp && pctEl) pctEl.textContent = `${(parseFloat(inp.value) * 100).toFixed(1)}%`;
    });
}

// ---------------------------------------------------------------------------
// Render panel HTML
// ---------------------------------------------------------------------------

function renderPanel(profile) {
    return `<div class="sp-panel" id="sp-panel" role="dialog" aria-label="Scoring Profile" aria-modal="true">
    <div class="sp-panel-inner">
        <div class="sp-panel-header">
            <strong>Scoring Profile</strong>
            <button class="sp-close" id="sp-close" title="Close">&times;</button>
        </div>
        <div class="sp-panel-body">
            ${sectionHeader('sec-catweights', '1. Category Weights')}
            ${renderCategoryWeightsSection(profile)}
            ${sectionHeader('sec-formula', '2. Ranking Formula')}
            ${renderFormulaSection(profile)}
            <div class="sp-note">Changes apply to future leaderboard calculations. Existing batch scores are not retroactively recalculated.</div>
        </div>
        <div class="sp-panel-footer">
            <button class="sp-btn sp-btn-secondary" id="sp-cancel">Cancel</button>
            <button class="sp-btn sp-btn-danger" id="sp-reset">Reset to Defaults</button>
            <button class="sp-btn sp-btn-primary" id="sp-save">Save</button>
        </div>
    </div>
</div>
<div class="sp-backdrop" id="sp-backdrop"></div>`;
}

// ---------------------------------------------------------------------------
// Wire panel interactions
// ---------------------------------------------------------------------------

function wirePanel(panel, currentProfile, onClose) {
    // Section collapse
    panel.querySelectorAll('.sp-section-header').forEach(hdr => {
        hdr.addEventListener('click', () => {
            const targetId = hdr.dataset.target;
            const body = panel.querySelector(`#${targetId}`);
            if (!body) return;
            const open = body.classList.toggle('open');
            hdr.querySelector('.sp-section-arrow').style.transform = open ? 'rotate(90deg)' : '';
        });
    });

    // Live validation — category weights
    panel.querySelector('#catw-grid')?.addEventListener('input', () => updateCategoryTotal(panel));

    // Close
    const close = () => onClose();
    panel.querySelector('#sp-close')?.addEventListener('click', close);
    panel.querySelector('#sp-cancel')?.addEventListener('click', close);
    document.getElementById('sp-backdrop')?.addEventListener('click', close);

    // Reset
    panel.querySelector('#sp-reset')?.addEventListener('click', async () => {
        if (!confirm('Reset all scoring parameters to defaults?')) return;
        try {
            await resetProfile();
            showToast('Scoring profile reset to defaults.');
            close();
        } catch (err) {
            showToast(`Reset failed: ${err.message}`, 'error');
        }
    });

    // Save
    panel.querySelector('#sp-save')?.addEventListener('click', async () => {
        const catWeights = collectCategoryWeights(panel);
        const generalist = collectGeneralistParams(panel);

        // Validate before sending
        const errors = [];
        const catSum = Object.values(catWeights).reduce((s, v) => s + v, 0);
        if (Math.abs(catSum - 1.0) > 0.001) {
            errors.push(`Category weights sum to ${(catSum * 100).toFixed(1)}%, expected 100%`);
        }

        if (errors.length > 0) {
            showToast(errors[0], 'error');
            return;
        }

        try {
            await saveProfile({ categoryWeights: catWeights, generalist });
            showToast('Scoring profile saved.');
            close();
        } catch (err) {
            showToast(`Save failed: ${err.message}`, 'error');
        }
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let _panelMounted = false;

function closePanel() {
    const panel = document.getElementById('sp-panel');
    const backdrop = document.getElementById('sp-backdrop');
    if (panel) panel.remove();
    if (backdrop) backdrop.remove();
    _panelMounted = false;
}

export async function openScoringProfilePanel() {
    if (_panelMounted) return;
    _panelMounted = true;

    let profile;
    try {
        profile = await fetchProfile();
    } catch (err) {
        showToast(`Could not load scoring profile: ${err.message}`, 'error');
        _panelMounted = false;
        return;
    }

    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderPanel(profile);
    document.body.appendChild(wrapper.children[0]); // panel
    if (wrapper.children[0]) document.body.appendChild(wrapper.children[0]); // backdrop

    // Also append any remaining children
    while (wrapper.firstChild) {
        document.body.appendChild(wrapper.firstChild);
    }

    const panel = document.getElementById('sp-panel');
    // Open first section by default
    const firstBody = panel?.querySelector('.sp-section-body');
    if (firstBody) {
        firstBody.classList.add('open');
        const firstArrow = panel?.querySelector('.sp-section-arrow');
        if (firstArrow) firstArrow.style.transform = 'rotate(90deg)';
    }

    wirePanel(panel, profile, closePanel);

    // ESC to close
    const onKey = (e) => {
        if (e.key === 'Escape') { closePanel(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
}
