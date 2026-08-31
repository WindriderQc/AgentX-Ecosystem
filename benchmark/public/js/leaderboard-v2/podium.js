// podium.js — renders the top-3 medal podium for The Trophy Case

import { scoreColor } from '../components/score-color.js';

function _shortHost(url) {
    return String(url || '').replace(/^https?:\/\//, '').replace(/:11434$/, '');
}

const MEDALS = ['🥈', '🥇', '🥉'];
const MEDAL_LABELS = ['Silver', 'Gold', 'Bronze'];
const MEDAL_COLORS = ['#cfcfcf', '#ffd54f', '#cd7f32'];
const POD_TITLES = ['Runner up', 'Champion', 'Third place'];

const CATEGORIES = ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'];
const CAT_LABELS = {
    coding: 'Coding', reasoning: 'Reasoning', math: 'Math', knowledge: 'Knowledge',
    instruction: 'Instruction', creative: 'Creative', translation: 'Translation'
};
// Compact lane labels for the chips
const CAT_SHORT = {
    coding: 'Code', reasoning: 'Reason', math: 'Math', knowledge: 'Know',
    instruction: 'Instr', creative: 'Create', translation: 'Transl'
};
// Uniform ultra-short labels printed under each lane bar (full name in tooltip)
const CAT_TINY = {
    coding: 'Code', reasoning: 'Reas', math: 'Math', knowledge: 'Know',
    instruction: 'Inst', creative: 'Crea', translation: 'Tran'
};

/** Per-category 0–10 scores for one entry, keyed by category (null where untested). */
function laneScores(entry) {
    const avgs = entry.categoryAverages || {};
    const out = {};
    CATEGORIES.forEach(cat => {
        const v = avgs[cat];
        out[cat] = v != null && Number.isFinite(Number(v)) ? Number(v) / 10 : null;
    });
    return out;
}

function hasFullScopeEvidence(entry) {
    if (entry.fullScopeEligible === false || entry.evidenceStatus === 'partial_scope') return false;
    return entry.fullScopeEligible === true || entry.evidenceStatus === 'full_scope';
}

function podiumTitle(entry, medalIdx, opts = {}) {
    if (opts.provisional) return `Evidence ${opts.provisionalRank || 1}`;
    return POD_TITLES[medalIdx];
}

function categoryHighlights(entry) {
    const lanes = laneScores(entry);
    const scored = CATEGORIES
        .map(cat => ({ cat, score: lanes[cat] }))
        .filter(item => Number.isFinite(item.score));
    if (scored.length === 0) return { best: null, watch: null };
    const sorted = [...scored].sort((a, b) => b.score - a.score);
    return { best: sorted[0], watch: sorted[sorted.length - 1] };
}

/**
 * Field reference across the podium top-3:
 *   laneMax / laneAvg — per category (drive the leader tick + pack ghost bar)
 *   genMax            — best generalist score (drives the gauge headroom tick)
 */
function fieldStats(entries) {
    const laneMax = {}, laneAvg = {}, laneSum = {}, laneCount = {};
    CATEGORIES.forEach(cat => { laneMax[cat] = null; laneSum[cat] = 0; laneCount[cat] = 0; });
    let genMax = null, ttftBest = null;
    entries.forEach(entry => {
        const lanes = laneScores(entry);
        CATEGORIES.forEach(cat => {
            const s = lanes[cat];
            if (s == null) return;
            if (laneMax[cat] == null || s > laneMax[cat]) laneMax[cat] = s;
            laneSum[cat] += s; laneCount[cat] += 1;
        });
        if (entry.generalistScore != null) {
            const g = entry.generalistScore / 10;
            if (genMax == null || g > genMax) genMax = g;
        }
        if (entry.hostTtft != null && (ttftBest == null || entry.hostTtft < ttftBest)) {
            ttftBest = entry.hostTtft;
        }
    });
    CATEGORIES.forEach(cat => {
        laneAvg[cat] = laneCount[cat] ? laneSum[cat] / laneCount[cat] : null;
    });
    return { laneMax, laneAvg, genMax, ttftBest };
}

function formatLatency(ms) {
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.round(ms)}ms`;
}

/**
 * Plain-language profile *shape* — not jargon to decode. The best/weak chips
 * already name the lanes, so this only adds the shape, and only when notable.
 */
function signature(entry) {
    const lanes = CATEGORIES.map(cat => ({ cat, s: laneScores(entry)[cat] }))
        .filter(l => Number.isFinite(l.s));
    if (lanes.length < 2) return '';
    const mean = lanes.reduce((a, b) => a + b.s, 0) / lanes.length;
    const sorted = [...lanes].sort((a, b) => b.s - a.s);
    const top = sorted[0];
    const spread = sorted[0].s - sorted[sorted.length - 1].s;
    if (spread < 0.8) return 'Even across lanes';
    if (top.s - mean > 0.9) return 'One standout lane';
    return '';
}

/** Tier the 95% CI half-width (already on the 0–10 score scale). */
function confidenceTier(margin) {
    if (margin <= 0.3) return 'tight';
    if (margin <= 0.6) return 'moderate';
    return 'wide';
}

/** Map warmed-host TTFT to a 0–1 speed factor (300ms → 1.0, 1800ms → 0.0). */
function speedFactor(ttft) {
    return Math.max(0, Math.min(1, 1 - (ttft - 300) / 1500));
}

/** Radial score gauge with a headroom tick at the podium-leading generalist score. */
function scoreGauge(score, color, genMax) {
    const r = 42, C = 2 * Math.PI * r;
    const frac = Math.max(0, Math.min(1, score / 10));
    const off = (C * (1 - frac)).toFixed(1);
    let tick = '';
    // Only when there's headroom — on the field leader the tick would sit on its
    // own score and read as noise.
    if (genMax != null && genMax > score + 0.001) {
        const tf = Math.max(0, Math.min(1, genMax / 10));
        const a = (-90 + tf * 360) * Math.PI / 180;
        const x1 = (50 + 37 * Math.cos(a)).toFixed(1), y1 = (50 + 37 * Math.sin(a)).toFixed(1);
        const x2 = (50 + 47 * Math.cos(a)).toFixed(1), y2 = (50 + 47 * Math.sin(a)).toFixed(1);
        tick = `<line class="pod-gauge-tick" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    }
    return `<div class="pod-gauge-stack">
        <div class="pod-gauge-glow" style="--glow:${color}"></div>
        <svg class="pod-gauge" viewBox="0 0 100 100" aria-hidden="true">
            <circle class="pod-gauge-track" cx="50" cy="50" r="${r}"/>
            <circle class="pod-gauge-arc" cx="50" cy="50" r="${r}" stroke="${color}"
                stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${C.toFixed(1)}"
                transform="rotate(-90 50 50)" style="--gauge-to:${off}"/>
            ${tick}
            <text class="pod-gauge-num" x="50" y="48" text-anchor="middle" fill="${color}">${score.toFixed(2)}</text>
            <text class="pod-gauge-scale" x="50" y="64" text-anchor="middle">/ 10</text>
        </svg>
    </div>`;
}

/** The 7-lane bar strip: bar = score, ghost = pack average, tick = podium leader. */
function laneStrip(entry, field) {
    const lanes = laneScores(entry);
    const bars = CATEGORIES.map((cat, idx) => {
        const s = lanes[cat];
        const tiny = CAT_TINY[cat] || cat;
        if (s == null) {
            const evidence = entry.categoryEvidence?.[cat];
            const unavailableReason = evidence === 'attempted_unscored'
                ? 'attempted; score unavailable'
                : 'not tested';
            return `<div class="pod-lane pod-lane-empty" title="${CAT_LABELS[cat]}: ${unavailableReason}">
                <div class="pod-lane-track"></div>
                <span class="pod-lane-val">–</span>
                <span class="pod-lane-lbl">${tiny}</span>
            </div>`;
        }
        const color = scoreColor(s);
        const laneMax = field.laneMax[cat];
        const laneAvg = field.laneAvg[cat];
        const leads = laneMax != null && s >= laneMax - 0.001;
        const ghost = laneAvg != null
            ? `<div class="pod-lane-ghost" style="height:${(laneAvg / 10 * 100).toFixed(1)}%"></div>` : '';
        const tickEl = laneMax != null
            ? `<span class="pod-lane-tick" style="top:${(100 - laneMax / 10 * 100).toFixed(1)}%"></span>` : '';
        const titleAvg = laneAvg != null ? ` · pack avg ${laneAvg.toFixed(1)}` : '';
        return `<div class="pod-lane${leads ? ' pod-lane-leader' : ''}" title="${CAT_LABELS[cat]}: ${s.toFixed(1)} / 10${titleAvg}${leads ? ' · lane leader' : ''}">
            <div class="pod-lane-track">
                ${ghost}
                ${tickEl}
                <div class="pod-lane-fill" style="--lane-h:${(s / 10 * 100).toFixed(1)}%;animation-delay:${(0.12 + idx * 0.05).toFixed(2)}s;background:linear-gradient(180deg,color-mix(in srgb,${color} 88%,#fff),${color} 30%,color-mix(in srgb,${color} 70%,#000));${leads ? `box-shadow:0 0 0 1px ${color},0 0 9px ${color}55` : ''}"></div>
            </div>
            <span class="pod-lane-val">${s.toFixed(1)}</span>
            <span class="pod-lane-lbl">${tiny}</span>
        </div>`;
    }).join('');
    return `<div class="pod-lanes" role="img" aria-label="Per-category scores against the podium field">${bars}</div>`;
}

/** Slim responsiveness meter — time-to-first-reply, with a fastest-in-podium tick. */
function speedLane(entry, field) {
    if (entry.hostTtft == null) return '';
    const sp = speedFactor(entry.hostTtft);
    const cls = sp > 0.66 ? 'fast' : sp > 0.4 ? 'mid' : 'slow';
    const ttftBest = field && field.ttftBest != null ? field.ttftBest : null;
    const tick = ttftBest != null
        ? `<span class="pod-speed-tick" style="left:${(speedFactor(ttftBest) * 100).toFixed(0)}%"></span>` : '';
    return `<div class="pod-speed pod-speed-${cls}" title="How long until the model starts replying on the warmed host (TTFT). Lower is faster; white tick = fastest on the podium.">
        <div class="pod-speed-head"><span>⚡ speed</span><span class="pod-speed-val">${formatLatency(entry.hostTtft)} to first reply</span></div>
        <div class="pod-speed-track">${tick}<div class="pod-speed-fill" style="--speed-w:${(sp * 100).toFixed(0)}%"></div></div>
    </div>`;
}

/** Named best/weak lane chips + a sub-100% success flag when relevant. */
function laneChips(entry) {
    const { best, watch } = categoryHighlights(entry);
    const success = entry.successRate != null ? Number(entry.successRate) : null;
    const chips = [];
    if (best) {
        chips.push(`<span class="pod-chip pod-chip-best" title="Strongest lane">
            <span class="pod-chip-tag">Best</span>
            <span>${CAT_LABELS[best.cat] || best.cat}</span>
            <strong>${best.score.toFixed(1)}</strong>
        </span>`);
    }
    if (watch && watch.score < 7 && (!best || watch.cat !== best.cat)) {
        chips.push(`<span class="pod-chip pod-chip-weak" title="Weakest lane">
            <span class="pod-chip-tag">Weak</span>
            <span>${CAT_LABELS[watch.cat] || watch.cat}</span>
            <strong>${watch.score.toFixed(1)}</strong>
        </span>`);
    }
    if (success != null && success < 100) {
        chips.push(`<span class="pod-chip pod-chip-fail" title="Some benchmark runs failed or returned empty">
            <span class="pod-chip-tag">⚠</span>
            <span>${success}% ran clean</span>
        </span>`);
    }
    return chips.length ? `<div class="pod-chips">${chips.join('')}</div>` : '';
}

function podMeta(entry) {
    const rawMargin = entry.confidenceMargin != null ? Number(entry.confidenceMargin) : null;
    // confidenceMargin is emitted on the 0–100 category scale; the card score is 0–10.
    const margin = rawMargin != null ? rawMargin / 10 : null;
    const tests = entry.totalTests || 0;
    const confidenceSamples = entry.confidenceSampleSize || 0;
    const confidenceRepeats = entry.confidenceRepeatCount || tests;
    // Sample size and ±confidence are one story: n graded answers → how much the
    // score could swing. (Lane count is dropped — it just repeats the bar strip.)
    const confEl = margin != null
        ? `<span class="pod-conf pod-conf-${confidenceTier(margin)}" title="Weighted 95% interval from ${confidenceSamples} independent prompt means across categories (${confidenceRepeats} total attempts)">
            ±${margin.toFixed(2)} <span class="pod-conf-word">${confidenceTier(margin)}</span>
        </span>`
        : '';
    const evidenceEl = tests
        ? `<span class="pod-meta-counts" title="Each answer is scored by the judge; the lane scores are averaged over this many">from ${tests} graded answers</span>`
        : '';
    return `<div class="pod-meta">
        ${confEl}
        ${evidenceEl}
    </div>`;
}

function podCard(entry, medalIdx, opts = {}) {
    const field = opts.field || { laneMax: {}, laneAvg: {}, genMax: null };
    const provisional = opts.provisional === true;
    const scoreVal = entry.generalistScore != null ? entry.generalistScore / 10 : null;
    const color = scoreVal != null ? scoreColor(scoreVal) : '#888';

    const hostDisplay = entry.hostName || _shortHost(entry.host);
    const hostBits = [];
    if (hostDisplay) hostBits.push(`<span class="pod-host-bit"><span class="pod-host-ico">🖥️</span>${hostDisplay}</span>`);
    if (entry.host_available === false) hostBits.push(`<span class="pod-host-bit pod-host-gone">deleted model</span>`);

    const accentColor = provisional ? color : MEDAL_COLORS[medalIdx];
    const posClass = MEDAL_LABELS[medalIdx].toLowerCase();
    const rank = medalIdx === 1 ? 1 : medalIdx === 0 ? 2 : 3;
    const sig = signature(entry);

    const gaugeEl = scoreVal != null
        ? scoreGauge(scoreVal, color, field.genMax)
        : `<div class="pod-gauge-empty">—</div>`;

    return `<div class="r-pod ${posClass}" style="--pod-accent:${accentColor};--pod-score:${color}">
        <div class="pod-accent-bar"></div>
        <div class="pod-header">
            ${provisional ? '' : `<div class="r-pod-medal" aria-label="${MEDAL_LABELS[medalIdx]}">${MEDALS[medalIdx]}</div>`}
            <div class="r-pod-label">${podiumTitle(entry, medalIdx, opts)}</div>
            ${sig ? `<div class="pod-signature" title="Derived from category profile">${sig}</div>` : ''}
        </div>
        <div class="pod-topline">
            <div class="pod-gauge-wrap">${gaugeEl}</div>
            <div class="pod-id">
                <div class="r-pod-name">${entry.model}</div>
                ${hostBits.length ? `<div class="r-pod-host">${hostBits.join('')}</div>` : ''}
                ${speedLane(entry, field)}
            </div>
        </div>
        <div class="pod-div"></div>
        ${laneStrip(entry, field)}
        ${laneChips(entry)}
        <div class="pod-div"></div>
        ${podMeta(entry)}
        ${provisional ? '' : `<div class="pod-stage" aria-label="Rank ${rank} pedestal"></div>`}
    </div>`;
}

/** Always-visible key — decodes the card's glyphs so nothing relies on hover. */
function podiumLegend() {
    return `<div class="pod-legend" aria-label="How to read a podium card">
        <span class="pod-legend-title">How to read a card</span>
        <span class="pod-legend-item">
            <span class="pod-legend-bar"><span class="pl-ghost"></span><span class="pl-fill"></span></span>
            bar = this model's score
        </span>
        <span class="pod-legend-item"><span class="pod-legend-dash"></span> dashed = podium average</span>
        <span class="pod-legend-item"><span class="pod-legend-tick"></span> white line = best on the podium</span>
        <span class="pod-legend-item"><span class="pod-legend-arc"></span> gauge tick = score to beat for #1</span>
        <span class="pod-legend-item"><span class="pod-legend-conf">±0.4</span> = how much the score could swing</span>
    </div>`;
}

function emptyState() {
    return `<div class="r-empty" style="text-align:center;padding:2rem;">
        <div style="font-size:2rem;margin-bottom:0.5rem;">🏁</div>
        <p>No rankings yet — launch a benchmark to populate the podium.</p>
        <a href="/" class="r-nav-btn r-primary" style="display:inline-block;margin-top:0.5rem;">Launch a Benchmark</a>
    </div>`;
}

/**
 * Render the top-3 podium into container.
 */
export function renderPodium(container, rankings, opts = {}) {
    const visible = (rankings || []).filter(r => !r.filtered);
    const fullScope = visible.filter(hasFullScopeEvidence);
    // Phase 0 exposes observations only. Its consumer trust projection cannot
    // mint the later immutable qualification receipt, even if a caller forges
    // qualified-looking fields in the browser payload.
    const provisional = true;
    // Partial evidence remains inspectable, but it never receives a medal or
    // displaces a full-scope model from the actual podium.
    const top = (provisional ? visible : fullScope).slice(0, 3);

    if (top.length === 0) {
        container.innerHTML = emptyState();
        return;
    }

    const field = fieldStats(top);
    const cardOpts = { ...opts, field, provisional };

    let order;
    if (top.length === 1) {
        order = [{ entry: top[0], medalIdx: 1, provisionalRank: 1 }];
    } else if (top.length === 2) {
        order = [
            { entry: top[0], medalIdx: 1, provisionalRank: 1 },
            { entry: top[1], medalIdx: 0, provisionalRank: 2 }
        ];
    } else {
        order = [
            { entry: top[1], medalIdx: 0, provisionalRank: 2 },
            { entry: top[0], medalIdx: 1, provisionalRank: 1 },
            { entry: top[2], medalIdx: 2, provisionalRank: 3 }
        ];
    }

    const trustState = opts.trustVerdict?.state || 'inconclusive';
    const provisionalMessage = fullScope.length === 0
        ? 'No result covers the full required scope. These records are inspectable evidence, not medal positions or a champion.'
        : trustState === 'exploratory'
            ? 'Top exploratory observations are inspectable evidence, not medal positions or a qualified winner.'
            : trustState === 'stale'
                ? 'This evidence is stale. It cannot produce medal positions or a qualified winner.'
                : 'No exact qualification receipt is present. These observations are not medal positions or a qualified winner.';
    const provisionalHeader = provisional
        ? `<div class="r-sec-head"><span class="r-sec-icon">◇</span><span class="r-sec-title r-t-cyan">Evidence observations</span></div><p class="r-empty" style="margin:0 0 1rem;">${provisionalMessage}</p>`
        : '';
    container.innerHTML = `${provisionalHeader}<div class="r-podium${provisional ? ' r-podium-provisional' : ''}">
        ${order.map(({ entry, medalIdx, provisionalRank }) => podCard(entry, medalIdx, { ...cardOpts, provisionalRank })).join('')}
    </div>${provisional ? '' : podiumLegend()}`;
}
