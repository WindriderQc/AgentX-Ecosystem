// detail-panel.js — immersive analytics drill-down panel for courthouse-v2
// Exports renderDetailPanel(containerEl, result, allResults) and closeDetailPanel(containerEl).

import { levelBadge } from '../components/level-badge.js';
import { scoreColor } from '../components/score-color.js';
import { showToast } from '../components/toast.js';
import { renderRawCuratedJudgePanes, wireRawCuratedJudgePanes } from '../components/raw-response.js';
import {
    fetchResult,
    submitReview,
    promoteGroundTruth,
    fetchQualityBreakdown,
    fetchTrends,
    fetchJudgeCalibration,
    fetchDimensionBreakdown,
    fetchSamePromptResults,
    fetchHostNames,
} from './api.js';
import { escHtml, fmtNum, fmtMs, fmtPct } from '../utils/format.js';
import { evidenceProvenance, evidenceBadge } from './evidence-provenance.js';
import { isJudgeReady, judgeBlockedReason } from './readiness-state.js';

// ─── Utilities ───────────────────────────────────────────────────────────────

function scoreClass(score) {
    if (score === null || score === undefined) return '';
    if (score >= 8) return 'h';
    if (score >= 5) return 'm';
    return 'l';
}

function shortModel(m) {
    return (m || '').replace(/:latest$/, '');
}

function shortHost(url) {
    return String(url || '').replace(/^https?:\/\//, '').replace(/:11434$/, '');
}

// ─── Section builders ────────────────────────────────────────────────────────

// ── 1. Score hero ────────────────────────────────────────────────────────────

function renderScoreHero(r) {
    const score = r.quality_score ?? r.composite_score;
    const cls = scoreClass(score);
    const color = score != null ? scoreColor(score) : 'var(--r-text-muted)';
    const scoreDisplay = score != null ? score.toFixed(1) : 'n/a';
    const conf = r.judge_confidence;
    const method = r.scoring_method || r.judging_method || 'auto';
    const consensus = r.judge_consensus;
    const divergence = r.judge_divergence;
    const evidence = evidenceProvenance(r);

    const confBar = conf != null
        ? `<div class="dp-conf-bar"><div class="dp-conf-fill" style="width:${Math.round(conf * 100)}%;background:${conf >= 0.8 ? 'var(--r-good)' : conf >= 0.5 ? '#eab308' : 'var(--r-error)'}"></div></div>
           <span class="dp-mini-label">${fmtPct(conf)} confidence</span>`
        : '';

    const divBadge = divergence != null
        ? `<span class="dp-mini-pill ${divergence > 3 ? 'dp-pill-warn' : 'dp-pill-ok'}">${fmtNum(divergence)} div</span>`
        : '';

    const consBadge = consensus
        ? `<span class="dp-mini-pill dp-pill-info">${consensus.replace(/_/g, ' ')}</span>`
        : '';

    // Semantic vs format dual scoring
    const semantic = r.semantic_score;
    const format = r.format_score;
    const dualRow = (semantic != null || format != null)
        ? `<div class="dp-dual-scores">
            ${semantic != null ? `<span class="dp-mini-label">Semantic <strong class="${scoreClass(semantic)}">${fmtNum(semantic)}</strong></span>` : ''}
            ${format != null ? `<span class="dp-mini-label">Format <strong class="${scoreClass(format)}">${fmtNum(format)}</strong></span>` : ''}
           </div>`
        : '';

    // Task 0198: deterministic vs subjective decomposition.
    // Shows where the score came from when the new fields are populated.
    // Pre-0198 results have these as null and the row is hidden so the
    // existing UI layout is unchanged for legacy data.
    const det = r.deterministic_score;
    const detPass = r.deterministic_pass;
    const subj = r.subjective_score;
    const formula = r.composite_formula;
    const provenanceRow = (det != null || subj != null || formula)
        ? `<div class="dp-provenance-row">
            ${det != null
                ? `<span class="dp-mini-pill dp-prov-det" title="Deterministic check (regex / json-match / reference) ${detPass === true ? 'passed' : detPass === false ? 'failed' : ''}">
                    Deterministic <strong class="${scoreClass(det)}">${fmtNum(det)}</strong>${detPass === false ? ' ✗' : detPass === true ? ' ✓' : ''}
                   </span>`
                : ''}
            ${subj != null
                ? `<span class="dp-mini-pill dp-prov-judge" title="LLM judge subjective score">
                    Judge <strong class="${scoreClass(subj)}">${fmtNum(subj)}</strong>
                   </span>`
                : ''}
            ${formula
                ? `<span class="dp-mini-pill dp-prov-formula" title="Which formula produced quality_score">${escHtml(formula)}</span>`
                : ''}
           </div>`
        : '';

    return `<div class="dp-score-hero">
        <div class="dp-score-ring ${cls}" style="--score-color:${color}">
            <span class="dp-score-big">${scoreDisplay}</span>
            <span class="dp-score-max">/10</span>
        </div>
        <div class="dp-score-meta">
            ${evidenceBadge(r)}
            <span class="dp-evidence-copy">${escHtml(evidence.description)}</span>
            <span class="dp-method-badge">${escHtml(method)}</span>
            ${consBadge}${divBadge}
            ${confBar}
            ${dualRow}
            ${provenanceRow}
        </div>
    </div>`;
}

// ── 2. Decomposed breakdown ──────────────────────────────────────────────────

function extractDimensions(r) {
    // 1. Structured decomposed_score array
    if (Array.isArray(r.decomposed_score) && r.decomposed_score.length)
        return r.decomposed_score.map(d => ({
            name: d.dimension || d.name || 'Dimension',
            question: d.question || d.criterion || '',
            passed: d.passed ?? (d.score >= 1),
            score: d.score ?? null,
        }));
    // 2. judging_details.breakdown array
    const bd = r.judging_details?.breakdown;
    if (Array.isArray(bd) && bd.length)
        return bd.map(d => ({
            name: d.dimension || d.name || 'Dimension',
            question: d.question || d.criterion || '',
            passed: d.passed ?? (d.score >= 1),
            score: d.score ?? null,
        }));
    // 3. quality_breakdown as flat object: { accuracy: 10, clarity: 8 }
    const qb = r.quality_breakdown;
    if (qb && typeof qb === 'object' && !Array.isArray(qb)) {
        const entries = Object.entries(qb);
        if (entries.length > 0 && entries.every(([, v]) => typeof v === 'number'))
            return entries.map(([name, val]) => ({
                name, question: '',
                passed: val >= 5,
                score: val,
            }));
    }
    // 4. criteria_scores object
    const cr = r.criteria_scores;
    if (cr && typeof cr === 'object')
        return Object.entries(cr).map(([name, val]) => ({
            name, question: '',
            passed: typeof val === 'boolean' ? val : (val >= 1),
            score: typeof val === 'number' ? val : null,
        }));
    return [];
}

function renderBreakdown(r) {
    const dims = extractDimensions(r);
    if (!dims.length) return `<div class="dp-card">
        <div class="dp-card-head">
            <span class="dp-card-icon">📐</span>
            <span class="dp-card-title">Scoring Dimensions</span>
        </div>
        <div class="dp-decomp"><div class="dp-decomp-empty" style="color:var(--r-text-dim);font-size:0.7rem;padding:0.5rem;">No dimension data available.</div></div>
    </div>`;

    const passCount = dims.filter(d => d.passed).length;
    const rows = dims.map(d => {
        const vc = d.passed ? 'dp-yes' : 'dp-no';
        const scoreLabel = d.score != null ? d.score.toFixed(1) : (d.passed ? 'YES' : 'NO');
        const barPct = d.score != null ? Math.round((d.score / 10) * 100) : (d.passed ? 100 : 0);
        const barColor = d.score != null ? scoreColor(d.score) : (d.passed ? 'var(--r-good)' : 'var(--r-error)');
        return `<div class="dp-dim">
            <span class="dd-name">${escHtml(d.name)}</span>
            <span class="dd-q">${escHtml(d.question)}</span>
            <div class="dd-bar"><div class="dd-bar-fill" style="width:${barPct}%;background:${barColor}"></div></div>
            <span class="dp-verdict ${vc}">${scoreLabel}</span>
        </div>`;
    }).join('');

    return `<div class="dp-card">
        <div class="dp-card-head">
            <span class="dp-card-icon">📐</span>
            <span class="dp-card-title">Scoring Dimensions</span>
            <span class="dp-card-badge">${passCount}/${dims.length}</span>
        </div>
        <div class="dp-decomp">${rows}</div>
    </div>`;
}

// ── 3. Performance metrics ───────────────────────────────────────────────────

function renderPerformance(r, hostName) {
    const latency = r.latency;
    const tps = r.tokens_per_sec;
    const tokens = r.tokens;
    const hw = r.hardware_snapshot || {};
    const pb = r.performance_baseline || {};
    const scoringTime = r.scoring_time_ms;

    const hostDisplay = hostName || shortHost(r.host) || '—';

    const baselineCompare = (pb.tokensPerSec && tps)
        ? ((tps / pb.tokensPerSec) * 100 - 100).toFixed(0)
        : null;
    const baselineLabel = baselineCompare != null
        ? `<span class="dp-mini-pill ${Number(baselineCompare) >= 0 ? 'dp-pill-ok' : 'dp-pill-warn'}">${Number(baselineCompare) >= 0 ? '+' : ''}${baselineCompare}% vs baseline</span>`
        : '';

    const vramPct = (pb.vramUsedMiB && pb.vramTotalMiB)
        ? Math.round((pb.vramUsedMiB / pb.vramTotalMiB) * 100)
        : null;

    return `<div class="dp-card">
        <div class="dp-card-head">
            <span class="dp-card-icon">⚡</span>
            <span class="dp-card-title">Performance</span>
            ${baselineLabel}
        </div>
        <div class="dp-metrics-grid">
            <div class="dp-metric">
                <span class="dp-metric-val">${fmtMs(latency)}</span>
                <span class="dp-metric-label">Latency</span>
            </div>
            <div class="dp-metric">
                <span class="dp-metric-val">${tps != null ? fmtNum(tps) : '—'}</span>
                <span class="dp-metric-label">tok/s</span>
            </div>
            <div class="dp-metric">
                <span class="dp-metric-val">${tokens ?? '—'}</span>
                <span class="dp-metric-label">Tokens</span>
            </div>
            <div class="dp-metric">
                <span class="dp-metric-val">${fmtMs(scoringTime)}</span>
                <span class="dp-metric-label">Judge time</span>
            </div>
        </div>
        <div class="dp-hw-row">
            <span class="dp-hw-item">🖥 ${escHtml(hostDisplay)}</span>
            ${hw.backend ? `<span class="dp-hw-item">⚙ ${escHtml(hw.backend)}</span>` : ''}
            ${hw.quantization ? `<span class="dp-hw-item">📦 ${escHtml(hw.quantization)}</span>` : ''}
            ${hw.vram_usage_mb ? `<span class="dp-hw-item">🎮 ${Math.round(hw.vram_usage_mb)}MB VRAM</span>` : ''}
            ${vramPct != null ? `<span class="dp-hw-item dp-vram-bar"><span class="dp-vram-fill" style="width:${vramPct}%"></span>${vramPct}%</span>` : ''}
        </div>
    </div>`;
}

// ── 4. Multi-judge consensus ─────────────────────────────────────────────────

function renderJudgeConsensus(r) {
    const judges = r.judge_scores;
    // If no judge_scores array but we have judge metadata, show single-judge card
    if (!Array.isArray(judges) || judges.length < 1) {
        const judgeModel = r.judge_model || r.judgeModel;
        if (!judgeModel) return '';
        const score = r.quality_score ?? r.composite_score;
        const color = score != null ? scoreColor(score) : 'var(--r-text-muted)';
        const conf = r.judge_confidence;
        return `<div class="dp-card">
            <div class="dp-card-head">
                <span class="dp-card-icon">⚖</span>
                <span class="dp-card-title">Judge</span>
                <span class="dp-card-badge">single</span>
            </div>
            <div class="dp-judge-row">
                <span class="dp-judge-num">#1</span>
                <span class="dp-judge-model">${escHtml(shortModel(judgeModel))}</span>
                <span class="dp-judge-score" style="color:${color}">${score != null ? fmtNum(score) : '—'}</span>
                ${conf != null ? `<span class="dp-mini-label">${fmtPct(conf)}</span>` : ''}
            </div>
        </div>`;
    }

    const rows = judges.map((j, i) => {
        const s = j.quality_score;
        const color = s != null ? scoreColor(s) : 'var(--r-text-muted)';
        const time = j.scoring_time_ms ? fmtMs(j.scoring_time_ms) : '';
        return `<div class="dp-judge-row">
            <span class="dp-judge-num">#${i + 1}</span>
            <span class="dp-judge-model">${escHtml(shortModel(j.judge_model))}</span>
            <div class="dp-judge-bar-track">
                <div class="dp-judge-bar-fill" style="width:${(s || 0) * 10}%;background:${color}"></div>
            </div>
            <span class="dp-judge-score" style="color:${color}">${s != null ? s.toFixed(1) : '—'}</span>
            ${time ? `<span class="dp-mini-label">${time}</span>` : ''}
        </div>`;
    }).join('');

    const avg = (judges || []).reduce((sum, j) => sum + (j.quality_score || 0), 0) / (judges || []).length;
    const spread = judges.length > 1
        ? Math.max(...judges.map(j => j.quality_score || 0)) - Math.min(...judges.map(j => j.quality_score || 0))
        : 0;

    return `<div class="dp-card">
        <div class="dp-card-head">
            <span class="dp-card-icon">⚖️</span>
            <span class="dp-card-title">Judge Consensus</span>
            <span class="dp-card-badge">${judges.length} judge${judges.length > 1 ? 's' : ''}</span>
        </div>
        ${rows}
        ${judges.length > 1 ? `<div class="dp-judge-summary">
            <span>avg ${fmtNum(avg)}</span>
            <span>spread ${fmtNum(spread)}</span>
            ${r.judge_tiebreaker_used ? '<span class="dp-mini-pill dp-pill-warn">tiebreaker</span>' : ''}
            ${r.judge_escalated ? '<span class="dp-mini-pill dp-pill-warn">escalated</span>' : ''}
        </div>` : ''}
    </div>`;
}

// ── 5. Judge transparency ────────────────────────────────────────────────────

function renderJudgeTransparency(r) {
    const jp = r.judge_prompt;
    const jr = r.judge_raw_response;
    const expl = r.quality_explanation;
    if (!jp && !jr && !expl) return '';

    return `<div class="dp-card dp-collapsible" data-collapsed="true">
        <button type="button" class="dp-card-head dp-toggle-head" aria-expanded="false" aria-controls="dp-judge-transparency-body">
            <span class="dp-card-icon" aria-hidden="true">🔍</span>
            <span class="dp-card-title">Judge Transparency</span>
            <span class="dp-toggle-arrow" aria-hidden="true">▶</span>
        </button>
        <div id="dp-judge-transparency-body" class="dp-collapse-body" hidden>
            ${expl ? `<div class="dp-trans-section">
                <div class="dp-trans-label">Explanation</div>
                <div class="dp-trans-text">${escHtml(expl)}</div>
            </div>` : ''}
            ${jp ? `<div class="dp-trans-section">
                <div class="dp-trans-label">Judge Prompt</div>
                <pre class="dp-trans-pre">${escHtml(jp)}</pre>
            </div>` : ''}
            ${jr ? `<div class="dp-trans-section">
                <div class="dp-trans-label">Raw Judge Response</div>
                <pre class="dp-trans-pre">${escHtml(jr)}</pre>
            </div>` : ''}
        </div>
    </div>`;
}

// ── 6. Thinking / reasoning extraction ───────────────────────────────────────

function renderThinking(r) {
    if (!r.thinking) return '';
    return `<div class="dp-card dp-collapsible" data-collapsed="true">
        <button type="button" class="dp-card-head dp-toggle-head" aria-expanded="false" aria-controls="dp-model-reasoning-body">
            <span class="dp-card-icon" aria-hidden="true">🧠</span>
            <span class="dp-card-title">Model Reasoning</span>
            <span class="dp-mini-label">${r.thinking.length} chars</span>
            <span class="dp-toggle-arrow" aria-hidden="true">▶</span>
        </button>
        <div id="dp-model-reasoning-body" class="dp-collapse-body" hidden>
            <pre class="dp-thinking-pre">${escHtml(r.thinking)}</pre>
        </div>
    </div>`;
}

// ── 7. Truncation warnings ───────────────────────────────────────────────────

function renderTruncation(r) {
    const t = r.truncation;
    if (!t) return '';

    const flags = [];
    if (t.response_truncated) flags.push({ label: 'Response truncated', detail: `${t.response_tokens || '?'}/${t.response_limit || '?'} tokens`, cls: 'dp-pill-warn' });
    if (t.input_to_judge_truncated) flags.push({ label: 'Judge input truncated', detail: `${t.input_sent_chars || '?'}/${t.input_original_chars || '?'} chars`, cls: 'dp-pill-warn' });
    if (t.judge_truncated) flags.push({ label: 'Judge response truncated', detail: `${t.judge_tokens || '?'} tokens`, cls: 'dp-pill-warn' });
    if (t.done_reason && t.done_reason !== 'stop') flags.push({ label: `Stop reason: ${t.done_reason}`, detail: '', cls: 'dp-pill-info' });

    if (!flags.length) return '';

    const items = flags.map(f =>
        `<div class="dp-trunc-flag ${f.cls}">
            <span class="dp-trunc-label">⚠ ${escHtml(f.label)}</span>
            ${f.detail ? `<span class="dp-trunc-detail">${escHtml(f.detail)}</span>` : ''}
        </div>`
    ).join('');

    return `<div class="dp-card dp-card-warn">
        <div class="dp-card-head">
            <span class="dp-card-icon">✂️</span>
            <span class="dp-card-title">Truncation Warnings</span>
        </div>
        ${items}
    </div>`;
}

// ── 8. Ground truth box ──────────────────────────────────────────────────────

function renderGroundTruth(r) {
    const gt = r.ground_truth || r.judge_ground_truth;
    if (!gt) return '';
    const expertScore = gt.expert_score ?? gt.score;
    if (expertScore == null) return '';
    const scoreVal = r.quality_score ?? r.composite_score;
    const delta = scoreVal != null ? Math.abs(scoreVal - expertScore).toFixed(1) : null;
    const rangeMin = gt.score_range_min ?? (expertScore - 1.5);
    const rangeMax = gt.score_range_max ?? (expertScore + 1.5);
    const withinRange = scoreVal != null && scoreVal >= rangeMin && scoreVal <= rangeMax;

    return `<div class="dp-card dp-card-gt">
        <div class="dp-card-head">
            <span class="dp-card-icon">🎯</span>
            <span class="dp-card-title">Ground Truth</span>
            <span class="dp-mini-pill ${withinRange ? 'dp-pill-ok' : 'dp-pill-warn'}">${withinRange ? 'within range' : 'out of range'}</span>
        </div>
        <div class="dp-gt-content">
            <div class="dp-metric">
                <span class="dp-metric-val">${fmtNum(expertScore)}</span>
                <span class="dp-metric-label">Expert</span>
            </div>
            ${delta != null ? `<div class="dp-metric">
                <span class="dp-metric-val ${withinRange ? 'dp-gt-close' : 'dp-gt-far'}">Δ${delta}</span>
                <span class="dp-metric-label">Delta</span>
            </div>` : ''}
            <div class="dp-metric">
                <span class="dp-metric-val">${fmtNum(rangeMin)}–${fmtNum(rangeMax)}</span>
                <span class="dp-metric-label">Range</span>
            </div>
        </div>
    </div>`;
}

// ── 9. Cross-model comparison (enriched) ─────────────────────────────────────

function renderCrossModel(r, compResults) {
    if (!compResults || compResults.length < 1) return '';

    // De-dupe by model, keep best score
    const byModel = new Map();
    for (const cr of compResults) {
        const model = cr.model || 'unknown';
        const score = cr.quality_score ?? cr.composite_score;
        if (score == null) continue;
        const existing = byModel.get(model);
        if (!existing || score > (existing.quality_score ?? -1)) byModel.set(model, cr);
    }
    if (byModel.size < 2) return '';

    const entries = [...byModel.entries()]
        .map(([model, cr]) => ({
            model,
            score: cr.quality_score ?? cr.composite_score,
            latency: cr.latency,
            tokens_per_sec: cr.tokens_per_sec,
            isCurrent: cr._id === r._id || model === r.model,
        }))
        .sort((a, b) => b.score - a.score);

    const rows = entries.map(e => {
        const pct = Math.round((e.score / 10) * 100);
        const color = scoreColor(e.score);
        const modelLabel = shortModel(e.model);
        const curCls = e.isCurrent ? ' current' : '';
        return `<div class="dp-cm-row">
            <span class="dp-cm-model${curCls}" title="${escHtml(e.model)}">${escHtml(modelLabel)}</span>
            <div class="dp-cm-bar"><div class="dp-cm-fill" style="width:${pct}%;background:${color}"></div></div>
            <span class="dp-cm-score" style="color:${color}">${e.score.toFixed(1)}</span>
            ${e.latency != null ? `<span class="dp-mini-label">${fmtMs(e.latency)}</span>` : ''}
        </div>`;
    }).join('');

    return `<div class="dp-card">
        <div class="dp-card-head">
            <span class="dp-card-icon">🏁</span>
            <span class="dp-card-title">Cross-Model Comparison</span>
            <span class="dp-card-badge">${byModel.size} models</span>
        </div>
        ${rows}
    </div>`;
}

// ── 10. Quality trend sparkline (from /trends API) ───────────────────────────

function renderTrendChart(trendData) {
    if (!trendData || !Array.isArray(trendData) || trendData.length < 1) return '';

    // API uses avg_quality, fall back to avg_score/score
    const getScore = t => Number(t.avg_quality ?? t.avg_score ?? t.score ?? 0);

    // Single data point: show value card instead of sparkline
    if (trendData.length === 1) {
        const val = getScore(trendData[0]);
        const color = scoreColor(val);
        return `<div class="dp-card">
            <div class="dp-card-head">
                <span class="dp-card-icon">📈</span>
                <span class="dp-card-title">Quality Trend</span>
                <span class="dp-mini-pill dp-pill-info">1 day</span>
            </div>
            <div style="text-align:center;padding:0.4rem;">
                <span style="font-size:1.4rem;font-weight:700;color:${color}">${fmtNum(val)}</span>
                <span class="dp-mini-label" style="margin-left:0.3rem">/10 avg</span>
            </div>
        </div>`;
    }

    const maxScore = 10;
    const w = 200, h = 40;
    const points = trendData.map((t, i) => {
        const x = (i / (trendData.length - 1)) * w;
        const y = h - (getScore(t) / maxScore) * h;
        return `${x},${y}`;
    });
    const polyline = points.join(' ');
    const last = trendData[trendData.length - 1];
    const first = trendData[0];
    const delta = getScore(last) - getScore(first);
    const trendDir = delta > 0.2 ? 'up' : delta < -0.2 ? 'down' : 'flat';
    const trendCls = trendDir === 'up' ? 'dp-pill-ok' : trendDir === 'down' ? 'dp-pill-warn' : 'dp-pill-info';

    return `<div class="dp-card">
        <div class="dp-card-head">
            <span class="dp-card-icon">📈</span>
            <span class="dp-card-title">Quality Trend</span>
            <span class="dp-mini-pill ${trendCls}">${delta > 0 ? '+' : ''}${fmtNum(delta)} over ${trendData.length}d</span>
        </div>
        <div class="dp-sparkline-wrap">
            <svg viewBox="0 0 ${w} ${h}" class="dp-sparkline">
                <polyline points="${polyline}" fill="none" stroke="var(--r-active)" stroke-width="1.5" />
                <circle cx="${points[points.length - 1].split(',')[0]}" cy="${points[points.length - 1].split(',')[1]}" r="2.5" fill="var(--r-active)" />
            </svg>
        </div>
    </div>`;
}

// ── 11. Category performance context (from /quality-breakdown API) ───────────

function renderCategoryContext(breakdownData, currentCategory) {
    if (!breakdownData || typeof breakdownData !== 'object') return '';

    const cats = breakdownData.categories || breakdownData;
    if (!cats || typeof cats !== 'object') return '';

    const entries = Object.entries(cats).map(([cat, data]) => {
        // Handle: plain number, { avg_quality: "9.9" }, { avg_score: 7 }, { average: 6 }
        let avg;
        if (typeof data === 'number') avg = data;
        else if (data != null && typeof data === 'object') {
            avg = data.avg_quality ?? data.avg_score ?? data.average ?? null;
            if (avg != null) avg = Number(avg);
        }
        if (avg == null || isNaN(avg)) return null;
        return { cat, avg, isCurrent: cat.toLowerCase() === (currentCategory || '').toLowerCase() };
    }).filter(Boolean).sort((a, b) => b.avg - a.avg);

    if (!entries.length) return '';

    const rows = entries.map(e => {
        const pct = Math.round((e.avg / 10) * 100);
        const color = scoreColor(e.avg);
        return `<div class="dp-cat-row ${e.isCurrent ? 'dp-cat-current' : ''}">
            <span class="dp-cat-name">${escHtml(e.cat)}</span>
            <div class="dp-cat-bar"><div class="dp-cat-fill" style="width:${pct}%;background:${color}"></div></div>
            <span class="dp-cat-score" style="color:${color}">${fmtNum(e.avg)}</span>
        </div>`;
    }).join('');

    return `<div class="dp-card">
        <div class="dp-card-head">
            <span class="dp-card-icon">📊</span>
            <span class="dp-card-title">Category Performance</span>
        </div>
        ${rows}
    </div>`;
}

// ── 12. Review info ──────────────────────────────────────────────────────────

function renderReviewInfo(r) {
    // Always show — this is the primary action banner
    const score = r.quality_score ?? r.composite_score;
    const scoreDisplay = score != null ? score.toFixed(1) : '—';
    const cls = scoreClass(score);
    const color = score != null ? scoreColor(score) : 'var(--r-text-muted)';

    let statusIcon, statusLabel, statusCls;
    if (r.human_review_status === 'rejected') {
        statusIcon = '✕';
        statusLabel = 'REJECTED';
        statusCls = 'dp-review-needed';
    } else if (r.human_review_status === 'approved') {
        statusIcon = '✓';
        statusLabel = 'APPROVED';
        statusCls = 'dp-review-reviewed';
    } else if (r.human_review_status === 'overridden') {
        statusIcon = '✎';
        statusLabel = 'OVERRIDDEN';
        statusCls = 'dp-review-reviewed';
    } else if (r.human_score != null) {
        statusIcon = '✓';
        statusLabel = 'REVIEWED';
        statusCls = 'dp-review-reviewed';
    } else if (r.needs_review || r.review_reason) {
        statusIcon = '⚠';
        statusLabel = 'NEEDS REVIEW';
        statusCls = 'dp-review-needed';
    } else {
        statusIcon = '◉';
        statusLabel = 'PENDING REVIEW';
        statusCls = 'dp-review-pending';
    }

    const reasonHTML = r.review_reason
        ? `<span class="dp-review-reason-big">${escHtml(r.review_reason)}</span>`
        : '';

    const humanHTML = r.human_score != null
        ? `<div class="dp-review-human">
            <span class="dp-review-human-label">${r.human_review_status === 'approved' ? 'Approved Score:' : 'Human Score:'}</span>
            <span class="dp-review-human-score">${fmtNum(r.human_score)}</span>
            ${r.human_reviewer ? `<span class="dp-review-by">by ${escHtml(r.human_reviewer)}</span>` : ''}
           </div>`
        : '';

    const notesHTML = r.human_notes
        ? `<div class="dp-review-notes-big">"${escHtml(r.human_notes)}"</div>`
        : '';

    return `<div class="dp-review-bar ${statusCls}">
        <div class="dp-review-hero">
            <span class="dp-review-icon">${statusIcon}</span>
            <span class="dp-review-label">${statusLabel}</span>
        </div>
        <div class="dp-review-score-preview">
            <span class="dp-review-score-val ${cls}" style="color:${color}">${scoreDisplay}</span>
            <span class="dp-review-score-slash">/10</span>
        </div>
        ${reasonHTML}
        ${humanHTML}
        ${notesHTML}
    </div>`;
}

// ── 13. Prompt & Response ────────────────────────────────────────────────────

function renderPromptResponse(r) {
    const promptText = r.prompt || r.prompt_text || '';
    const level = r.prompt_level || 1;
    const category = r.category || r.prompt_category || '';
    const promptName = r.prompt_name || '';

    // Three-pane raw / curated / judge-raw view (task 0172). Lets the operator
    // see the full Ollama output (curated + thinking re-stitched) alongside the
    // text the judge actually consumed and the judge's own raw output. Tab
    // wiring is attached in renderDetailPanel after the markup is mounted.
    const triPaneHTML = renderRawCuratedJudgePanes(r, { idPrefix: 'dp-rrp' });

    return `<div class="dp-card">
        <div class="dp-card-head">
            <span class="dp-card-icon">💬</span>
            <span class="dp-card-title">Prompt</span>
            ${levelBadge(level)}
            ${category ? `<span class="dp-mini-pill dp-pill-info">${escHtml(category)}</span>` : ''}
            ${promptName ? `<span class="dp-mini-label">${escHtml(promptName)}</span>` : ''}
        </div>
        <div class="dp-prompt-box">${escHtml(promptText)}</div>
        <div class="dp-card-head" style="margin-top:0.4rem;">
            <span class="dp-card-icon">💡</span>
            <span class="dp-card-title">Response</span>
        </div>
        ${triPaneHTML}
    </div>`;
}

// ── 14. Execution settings ───────────────────────────────────────────────────

function renderExecutionSettings(r) {
    const es = r.execution_settings;
    const warmup = r.warmup;
    if (!es && !warmup) return '';

    const items = [];
    if (es?.num_predict) items.push(`<span class="dp-hw-item">🔢 num_predict: ${es.num_predict}</span>`);
    if (es?.hint_applied) items.push(`<span class="dp-hw-item">💡 Hint: ${escHtml(es.hint_text || 'applied')}</span>`);
    if (warmup?.already_loaded) items.push(`<span class="dp-hw-item">🔥 Pre-loaded</span>`);
    else if (warmup?.latency_ms) items.push(`<span class="dp-hw-item">🔥 Warmup: ${fmtMs(warmup.latency_ms)}</span>`);

    if (!items.length) return '';

    return `<div class="dp-exec-bar">${items.join('')}</div>`;
}

// ─── Action buttons ──────────────────────────────────────────────────────────

function renderActions(result) {
    const provenance = evidenceProvenance(result);
    const ready = isJudgeReady();
    const approveLabel = provenance.kind === 'deterministic-only'
        ? '✓ Verify deterministic evidence'
        : '✓ Approve';
    const approveTitle = provenance.kind === 'deterministic-only'
        ? 'Human-verify this deterministic score. No LLM judge score is being approved.'
        : "Accept the judge's score as-is. The result is marked as human-reviewed and removed from the review queue.";
    const rejudgeTitle = ready
        ? 'Send this result back to the selected ready judge for re-scoring.'
        : `${judgeBlockedReason()} Choose an installed judge in The Bench, then retry readiness.`;
    return `<div class="dp-actions-bar">
        <button class="dp-act approve"  data-dp-action="approve" title="${escHtml(approveTitle)}">${approveLabel}</button>
        <button class="dp-act override" data-dp-action="override" title="Replace the judge's score with your own (0–10). The human score will be used for leaderboard ranking and judge calibration.">✎ Override</button>
        <button class="dp-act rejudge"  data-dp-action="rejudge" data-judge-required="true" title="${escHtml(rejudgeTitle)}"${ready ? '' : ' disabled aria-disabled="true"'}>⟳ Re-judge${ready ? '' : ' · unavailable'}</button>
        <button class="dp-act reject"   data-dp-action="reject" title="Flag this result as invalid (bad prompt, broken response, etc.). It will be excluded from leaderboard aggregation. You can add a rejection reason.">✕ Reject</button>
        <button class="dp-act promote"  data-dp-action="promote" title="Save this prompt+response+score as a calibration reference. The more ground truth samples you have, the better you can measure judge accuracy.">📌 Ground Truth</button>
    </div>`;
}

function syncJudgeActionAvailability() {
    const button = document.querySelector('[data-dp-action="rejudge"][data-judge-required="true"]');
    if (!button) return;
    const ready = isJudgeReady();
    button.disabled = !ready;
    button.setAttribute('aria-disabled', ready ? 'false' : 'true');
    button.textContent = ready ? '⟳ Re-judge' : '⟳ Re-judge · unavailable';
    button.title = ready
        ? 'Send this result back to the selected ready judge for re-scoring.'
        : `${judgeBlockedReason()} Choose an installed judge in The Bench, then retry readiness.`;
}

if (typeof document !== 'undefined') {
    document.addEventListener('judge-readiness-changed', syncJudgeActionAvailability);
}

// ─── Panel HTML (full assembly) ──────────────────────────────────────────────

function buildPanelHTML(r, compResults, trendData, breakdownData, hostName) {
    const model = shortModel(r.model);
    const level = r.prompt_level || 1;
    const category = r.category || r.prompt_category || '';
    const ts = r.timestamp ? new Date(r.timestamp).toLocaleString() : '';

    return `<div class="detail-panel dp-immersive" id="courthouse-detail-panel" role="region" aria-label="Result details" tabindex="-1">
        <div class="dp-header">
            ${levelBadge(level)}
            <span class="dp-label">${escHtml(model)}</span>
            ${category ? `<span class="dp-mini-pill dp-pill-info">${escHtml(category)}</span>` : ''}
            ${ts ? `<span class="dp-mini-label">${ts}</span>` : ''}
            <button type="button" class="dp-close" title="Close panel" aria-label="Close result details" data-dp-close>✕</button>
        </div>

        ${renderReviewInfo(r)}

        <div class="dp-body">
            <!-- Top strip: Score hero + performance + truncation -->
            <div class="dp-top-strip">
                ${renderScoreHero(r)}
                ${renderPerformance(r, hostName)}
                ${renderTruncation(r)}
            </div>

            <!-- Analytics grid -->
            <div class="dp-analytics-grid">
                <div class="dp-col-left">
                    ${renderBreakdown(r)}
                    ${renderJudgeConsensus(r)}
                    ${renderGroundTruth(r)}
                    ${renderJudgeTransparency(r)}
                </div>
                <div class="dp-col-right">
                    ${renderCrossModel(r, compResults)}
                    ${renderTrendChart(trendData)}
                    ${renderCategoryContext(breakdownData, category)}
                    ${renderThinking(r)}
                </div>
            </div>

            <!-- Prompt & response (full width) -->
            ${renderPromptResponse(r)}
            ${renderExecutionSettings(r)}

            <!-- Action buttons -->
            ${renderActions(r)}
        </div>
    </div>`;
}

// ─── Action handlers ─────────────────────────────────────────────────────────

async function handleAction(containerEl, resultId, action) {
    // Promote is handled separately — it doesn't close the panel
    if (action === 'promote') {
        await handlePromote(containerEl, resultId);
        return;
    }

    if (action === 'rejudge' && !isJudgeReady()) {
        showToast(`Re-judge unavailable: ${judgeBlockedReason()}`, 'error');
        return;
    }

    let data = {};

    if (action === 'override') {
        const input = prompt('Enter override score (0–10):');
        if (input === null) return;
        const score = parseFloat(input);
        if (isNaN(score) || score < 0 || score > 10) {
            showToast('Invalid score. Enter a number between 0 and 10.', 'error');
            return;
        }
        data.human_score = score;
    } else if (action === 'approve') {
        data.notes = 'Approved in courthouse';
    } else if (action === 'reject') {
        const notes = prompt('Rejection reason (optional):');
        if (notes === null) return;
        if (notes) data.notes = notes;
    }

    try {
        await submitReview(resultId, action, data);
    } catch (err) {
        console.error('[detail-panel] submitReview error:', err);
        showToast(`Action failed: ${err.message}`, 'error');
        return;
    }

    const reviewQueue = document.getElementById('review-queue');
    if (reviewQueue) {
        const item = reviewQueue.querySelector(`[data-id="${resultId}"]`);
        if (item) item.remove();
    }

    closeDetailPanel(containerEl);

    containerEl.dispatchEvent(new CustomEvent('detail-action-complete', {
        bubbles: true,
        detail: { resultId, action },
    }));
}

async function handlePromote(containerEl, resultId) {
    // Resolve the effective score from the rendered panel
    const panel = containerEl.querySelector('#courthouse-detail-panel');
    const scoreBig = panel?.querySelector('.dp-score-big');
    const parsedScore = scoreBig ? parseFloat(scoreBig.textContent) : NaN;
    const expert_score = isNaN(parsedScore) ? null : parsedScore;

    if (expert_score === null) {
        showToast('Cannot promote: no score available for this result.', 'error');
        return;
    }

    const rationale = prompt('Why is this score correct? (brief rationale)');
    if (rationale === null) return; // user cancelled

    const btn = panel?.querySelector('[data-dp-action="promote"]');
    if (btn) btn.textContent = '⏳ Saving…';

    try {
        await promoteGroundTruth(resultId, expert_score, rationale || '');
        if (btn && btn.isConnected) {
            btn.textContent = '✓ Saved';
            btn.disabled = true;
        }
    } catch (err) {
        console.error('[detail-panel] promoteGroundTruth error:', err);
        if (btn && btn.isConnected) btn.textContent = '📌 Ground Truth';
        showToast(`Promote failed: ${err.message}`, 'error');
    }
}

// ─── Wire panel interactions ─────────────────────────────────────────────────

function wirePanel(containerEl, resultId) {
    const panel = containerEl.querySelector('#courthouse-detail-panel');
    if (!panel) return;

    // Wire Raw / Curated / Judge-raw tab toggles (task 0172).
    // wireRawCuratedJudgePanes is idempotent and listens for clicks on its
    // own tab buttons only, so it does not collide with the panel-wide
    // click handler below.
    wireRawCuratedJudgePanes(panel);

    panel.addEventListener('click', async e => {
        if (e.target.closest('[data-dp-close]')) {
            closeDetailPanel(containerEl);
            return;
        }

        // Collapsible toggle
        const toggleHead = e.target.closest('.dp-toggle-head');
        if (toggleHead) {
            const card = toggleHead.closest('.dp-collapsible');
            if (card) {
                const isCollapsed = card.dataset.collapsed === 'true';
                card.dataset.collapsed = isCollapsed ? 'false' : 'true';
                toggleHead.setAttribute('aria-expanded', isCollapsed ? 'true' : 'false');
                const bodyId = toggleHead.getAttribute('aria-controls');
                const body = bodyId ? card.querySelector(`#${bodyId}`) : card.querySelector('.dp-collapse-body');
                if (body) body.hidden = !isCollapsed;
                const arrow = toggleHead.querySelector('.dp-toggle-arrow');
                if (arrow) arrow.textContent = isCollapsed ? '▼' : '▶';
            }
            return;
        }

        const btn = e.target.closest('[data-dp-action]');
        if (btn) {
            const action = btn.dataset.dpAction;
            btn.disabled = true;
            try {
                await handleAction(containerEl, resultId, action);
            } finally {
                if (btn.isConnected) btn.disabled = false;
            }
        }
    });
}

function focusDetailWhenSourceIsHidden(containerEl) {
    const source = containerEl.__detailReturnTarget;
    if (!source?.classList.contains('ledger-open')) return;
    requestAnimationFrame(() => {
        containerEl.querySelector('#courthouse-detail-panel')?.focus({ preventScroll: true });
    });
}

// ─── Public exports ──────────────────────────────────────────────────────────

export async function renderDetailPanel(containerEl, result, allResults) {
    containerEl.__detailReturnTarget = document.querySelector(
        '.rq-item[aria-expanded="true"], .ledger-open[aria-expanded="true"]'
    );
    // Replace any previous panel without clearing the source row/button that
    // the operator just selected.
    containerEl.innerHTML = '';

    // Show loading
    containerEl.innerHTML = `<div class="detail-panel dp-immersive" id="courthouse-detail-panel" role="region" aria-label="Result details" tabindex="-1">
        <div class="dp-header">
            <span class="dp-label">Loading analytics…</span>
            <button type="button" class="dp-close" aria-label="Close result details" data-dp-close>✕</button>
        </div>
        <div class="dp-body">
            <div class="dp-loading-grid">
                <div class="dp-loading-card"></div>
                <div class="dp-loading-card"></div>
                <div class="dp-loading-card"></div>
                <div class="dp-loading-card"></div>
            </div>
        </div>
    </div>`;

    wirePanel(containerEl, String(result._id));
    focusDetailWhenSourceIsHidden(containerEl);

    // Scroll to panel immediately (deep-link UX)
    containerEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Parallel fetch: full result + analytics
    const resultId = String(result._id);
    const model = result.model || '';
    const promptName = result.prompt_name || '';

    let fullResult = result;
    let trendData = null;
    let breakdownData = null;
    let compResults = allResults || [];
    let hostName = '';

    try {
        const [fullRes, trendRes, breakdownRes, compRes, hostRes] = await Promise.allSettled([
            fetchResult(resultId),
            model ? fetchTrends(model, 14) : Promise.resolve(null),
            model ? fetchQualityBreakdown(model) : Promise.resolve(null),
            promptName ? fetchSamePromptResults(promptName, 30) : Promise.resolve(null),
            fetchHostNames(),
        ]);

        // Unwrap result
        if (fullRes.status === 'fulfilled' && fullRes.value) {
            const d = fullRes.value?.data || fullRes.value;
            fullResult = d?.result || d || result;
        }

        // Unwrap trends — API returns { data: { trends: [...], period, model } }
        if (trendRes.status === 'fulfilled' && trendRes.value) {
            const td = trendRes.value?.data || trendRes.value;
            trendData = td?.trends || td?.trend || (Array.isArray(td) ? td : null);
        }

        // Unwrap breakdown — API returns { data: { by_category: { "Model": { cat: { avg_quality } } } } }
        if (breakdownRes.status === 'fulfilled' && breakdownRes.value) {
            const bd = breakdownRes.value?.data || breakdownRes.value;
            // Extract by_category for the current model
            const byCategory = bd?.by_category;
            if (byCategory && typeof byCategory === 'object') {
                // Find model key (exact match or partial)
                const modelData = byCategory[model] ||
                    Object.values(byCategory).find(v => v && typeof v === 'object');
                breakdownData = modelData || null;
            } else {
                breakdownData = bd?.breakdown || bd;
            }
        }

        // Unwrap cross-model results
        if (compRes.status === 'fulfilled' && compRes.value) {
            const cd = compRes.value?.data || compRes.value;
            const arr = cd?.results || (Array.isArray(cd) ? cd : null);
            if (arr && arr.length > 0) compResults = arr;
        }

        // Unwrap host names
        if (hostRes.status === 'fulfilled' && hostRes.value) {
            const hd = hostRes.value?.data || hostRes.value;
            const hostMap = hd?.hosts || hd;
            if (hostMap && typeof hostMap === 'object' && fullResult.host) {
                hostName = hostMap[fullResult.host] || '';
            }
        }
    } catch (err) {
        console.warn('[detail-panel] analytics fetch error:', err);
    }

    // Render full panel
    containerEl.innerHTML = buildPanelHTML(fullResult, compResults, trendData, breakdownData, hostName);
    wirePanel(containerEl, String(fullResult._id));
    focusDetailWhenSourceIsHidden(containerEl);
}

export function closeDetailPanel(containerEl) {
    const returnTarget = containerEl.__detailReturnTarget
        || document.querySelector('.rq-item[aria-expanded="true"], .ledger-open[aria-expanded="true"]');
    const returnToLedger = returnTarget?.classList.contains('ledger-open');
    containerEl.innerHTML = '';
    document.querySelectorAll('.rq-item').forEach(el => {
        el.classList.remove('is-active');
        el.setAttribute('aria-expanded', 'false');
    });
    document.querySelectorAll('.ledger-row').forEach(el => el.classList.remove('is-active'));
    document.querySelectorAll('.ledger-open').forEach(el => el.setAttribute('aria-expanded', 'false'));
    if (returnToLedger) {
        document.dispatchEvent(new CustomEvent('courthouse-activate-tab', { detail: { name: 'ledger' } }));
    }
    if (returnTarget?.isConnected) returnTarget.focus();
    containerEl.__detailReturnTarget = null;
}
