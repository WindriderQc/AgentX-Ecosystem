// discrimination.js — Question Discrimination section for courthouse-v2
// Exports renderDiscrimination(container, data).
// Data is pre-computed server-side via GET /api/benchmark/question-discrimination.

import { fetchDiscrimination } from './api.js';
import { escHtml } from '../utils/format.js';

// ─── Classification helpers ───────────────────────────────────────────────────

/**
 * Classify a discrimination item by pass rate.
 * @param {number} passRate - 0–1 fraction
 * @returns {{ cls: string, label: string }}
 */
function classify(passRate) {
    if (passRate > 0.9) return { cls: 'disc-easy', label: 'too easy' };
    if (passRate < 0.2) return { cls: 'disc-hard', label: 'too hard' };
    return { cls: 'disc-ok', label: 'ok' };
}

// ─── Fill bar gradient ────────────────────────────────────────────────────────

/**
 * Build the gradient fill for a discrimination bar based on pass rate.
 * High pass rate → orange ("too easy"), low pass rate → red ("too hard"),
 * mid range → green.
 */
function barGradient(passRate) {
    if (passRate > 0.9) return 'var(--r-anomaly)';
    if (passRate < 0.2) return 'var(--r-error)';
    return 'var(--r-good)';
}

// ─── Single row ──────────────────────────────────────────────────────────────

function renderRow(item) {
    const fullText = item.question || item.prompt_text || item.prompt || item.prompt_name || '';
    const promptText = fullText.length > 80 ? fullText.slice(0, 80) + '…' : (fullText || '—');
    const category = item.category || item.prompt_category || '';
    const passRate = item.pass_rate ?? item.passRate ?? 0;
    const pct = Math.max(0, Math.min(1, passRate));
    const { cls, label } = classify(pct);
    const fillColor = barGradient(pct);
    const displayPct = Math.round(pct * 100) + '%';

    return `<div class="disc-row">
        <span class="disc-q" title="${escHtml(fullText)}">${escHtml(promptText)}</span>
        <span class="disc-cat">${escHtml(category)}</span>
        <div class="disc-bar">
            <div class="disc-fill" style="width:${Math.round(pct * 100)}%;background:${fillColor};"></div>
        </div>
        <span class="disc-rate">${displayPct}</span>
        <span class="disc-flag ${cls}">${label}</span>
    </div>`;
}

// ─── Section header ───────────────────────────────────────────────────────────

function sectionHeader(flaggedCount) {
    return `<div class="r-sec-head">
        <span class="r-sec-icon">🎯</span>
        <span class="r-sec-title r-t-green">Question Discrimination</span>
        <span class="r-sec-count">${flaggedCount} flagged</span>
        <span class="r-sec-toggle">▼</span>
    </div>`;
}

// ─── Normalise API response ───────────────────────────────────────────────────

function normaliseItems(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.data)) return data.data;
    if (data && Array.isArray(data.items)) return data.items;
    if (data && Array.isArray(data.questions)) return data.questions;
    return [];
}

// ─── Public export ────────────────────────────────────────────────────────────

/**
 * Render the Question Discrimination section into container.
 * Data comes from fetchDiscrimination() — pre-computed server-side.
 *
 * @param {HTMLElement} container - #discrimination element
 * @param {object|Array} data     - response from fetchDiscrimination()
 */
export function renderDiscrimination(container, data) {
    const items = normaliseItems(data);

    if (!items.length) {
        container.innerHTML = `
            ${sectionHeader(0)}
            <div class="r-empty ch-muted-state">No discrimination data available.</div>`;
        return;
    }

    // Separate flagged (too easy or too hard) from ok items
    const flagged = items.filter(item => {
        const rate = item.pass_rate ?? item.passRate ?? 0;
        return rate > 0.9 || rate < 0.2;
    });

    let showAll = false;

    function buildContent() {
        const displayItems = showAll ? items : flagged;

        if (!displayItems.length) {
            return '<div class="ch-muted-state">No flagged questions — all questions are well-calibrated.</div>';
        }

        const rows = displayItems.map(renderRow).join('');
        const toggleLabel = showAll
            ? `Show flagged only (${flagged.length})`
            : `Show all (${items.length})`;

        return `
            <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.4rem;font-size:0.62rem;">
                <span class="ch-muted-meta">${displayItems.length} question${displayItems.length !== 1 ? 's' : ''}</span>
                <button class="rq-chip disc-toggle" style="margin-left:auto;">${toggleLabel}</button>
            </div>
            <div class="disc-list">${rows}</div>`;
    }

    function render() {
        container.innerHTML = `${sectionHeader(flagged.length)}<div class="disc-body">${buildContent()}</div>`;

        container.querySelector('.disc-toggle')?.addEventListener('click', () => {
            showAll = !showAll;
            container.querySelector('.disc-body').innerHTML = buildContent();
            container.querySelector('.disc-toggle')?.addEventListener('click', toggleHandler);
        });
    }

    function toggleHandler() {
        showAll = !showAll;
        container.querySelector('.disc-body').innerHTML = buildContent();
        // Re-wire after re-render
        container.querySelector('.disc-toggle')?.addEventListener('click', toggleHandler);
    }

    render();
}
