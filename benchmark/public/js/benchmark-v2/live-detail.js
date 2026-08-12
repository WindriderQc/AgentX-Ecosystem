// live-detail.js — Live batch execution panel
// Top: Test Progress — hero progress, dual bars, grouped stats, live indicator
// Bottom: Judge Lane — Q&A exhibit, score card, dimensions
//
// KEY DATA FLOW:
//   current_test.stage: 'warmup' | 'executing' | 'responded' | 'idle'
//   Judging may be pipelined on split-host runs, but same-host runs defer
//   judging until generation has finished.
//   Judge progress via batch.judge_stats & batch.pipeline_activity.judging
//   Scored results appear in batch.results[] with quality_score != null

import { levelBadge } from '../components/level-badge.js';
import { scoreColor } from '../components/score-color.js';
import { renderRawCuratedJudgePanes, wireRawCuratedJudgePanes } from '../components/raw-response.js';
import { fmtMs, fmtNum } from '../utils/format.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pct(a, b) {
    if (!b) return 0;
    return Math.min(100, Math.round((a / b) * 100));
}

function elapsedStr(ms) {
    if (!ms || ms < 0) return '—';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

function isExcluded(result) {
    return result?.excluded_from_leaderboard === true
        || result?.truncation?.truncation_invalidates_score === true
        || result?.truncation?.hidden_response_cap === true;
}

// ── Result lookups ───────────────────────────────────────────────────────────

function findResultForCurrentTest(results, ct) {
    if (!results?.length || !ct?.prompt_name) return null;
    const matches = results.filter(r => r.prompt_name === ct.prompt_name && r.model === ct.model);
    return matches.length > 0 ? matches[matches.length - 1] : null;
}

function findLastScoredResult(results) {
    if (!results?.length) return null;
    const scored = results.filter(r => r.quality_score != null);
    if (!scored.length) return null;
    scored.sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return tb - ta;
    });
    return scored[0];
}

function findCurrentlyJudging(results) {
    if (!results?.length) return null;
    const unscored = results.filter(r => (r.response || r.response_preview) && r.quality_score == null);
    if (!unscored.length) return null;
    unscored.sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return ta - tb;
    });
    return unscored[0];
}

function recentScores(results, n = 20) {
    if (!results?.length) return [];
    return results
        .filter(r => r.quality_score != null && !isExcluded(r))
        .sort((a, b) => {
            const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
            const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
            return ta - tb;
        })
        .slice(-n)
        .map(r => r.quality_score);
}

// ── SVG progress ring ────────────────────────────────────────────────────────

function progressRing(pctVal, label, color, size = 72) {
    const r = (size - 8) / 2;
    const circ = 2 * Math.PI * r;
    const offset = circ * (1 - pctVal / 100);
    return `<svg class="ld-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="5"/>
        <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${color}" stroke-width="5"
            stroke-dasharray="${circ}" stroke-dashoffset="${offset}"
            stroke-linecap="round" transform="rotate(-90 ${size/2} ${size/2})"
            style="transition: stroke-dashoffset 0.6s ease"/>
        <text x="${size/2}" y="${size/2 - 4}" text-anchor="middle" fill="${color}" font-size="16" font-weight="900">${pctVal}%</text>
        <text x="${size/2}" y="${size/2 + 10}" text-anchor="middle" fill="#666" font-size="8" font-weight="600">${label}</text>
    </svg>`;
}

// ── Score dots sparkline ─────────────────────────────────────────────────────

function scoreDots(scores) {
    if (!scores.length) return '';
    const dots = scores.map((s, i) => {
        const c = scoreColor(s);
        return `<span class="ld-sdot" style="background:${c}" title="#${i + 1} · ${s.toFixed(1)}"></span>`;
    }).join('');
    return `<div class="ld-score-dots">
        <span class="ld-sdot-label">Recent scores</span>
        <span class="ld-sdot-end">oldest</span>
        <span class="ld-sdot-arrow">›</span>
        ${dots}
        <span class="ld-sdot-arrow ld-sdot-arrow-r">›</span>
        <span class="ld-sdot-end ld-sdot-end-r">newest</span>
    </div>`;
}

// ── Tiny inline sparkline (SVG polyline) ─────────────────────────────────────

function sparkline(values, color, opts = {}) {
    const w = opts.w || 56;
    const h = opts.h || 14;
    if (!values || values.length < 2) {
        return `<svg class="ld-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"></svg>`;
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = (max - min) || 1;
    const stepX = w / (values.length - 1);
    const pts = values.map((v, i) => {
        const x = i * stepX;
        const y = h - 1 - ((v - min) / range) * (h - 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const lastX = (values.length - 1) * stepX;
    const lastY = h - 1 - ((values[values.length - 1] - min) / range) * (h - 2);
    return `<svg class="ld-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>
        <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="1.6" fill="${color}"/>
    </svg>`;
}

function ledDot(state) {
    // state: 'good' | 'warn' | 'bad' | 'idle'
    return `<span class="ld-led ld-led-${state}"></span>`;
}

function elapsedSecShort(ms) {
    if (ms == null || ms < 0) return '—';
    const s = ms / 1000;
    if (s < 10) return `${s.toFixed(1)}s`;
    if (s < 60) return `${Math.round(s)}s`;
    const m = Math.floor(s / 60);
    const rs = Math.round(s % 60);
    return `${m}m ${rs}s`;
}

// ══════════════════════════════════════════════════════════════════════════════
// TOP — TEST PROGRESS (hero ring, dual bars, grouped stats)
// ══════════════════════════════════════════════════════════════════════════════

// ── Right-rail stat cards (Speed / Throughput / Time) ────────────────────────
//
// Each card has a dominant hero number (live), a delta vs the running average,
// a sparkline, and supporting chips. The Time card includes an elapsed/ETA
// progress bar so completion is glanceable.

function deltaPct(cur, avg) {
    if (cur == null || avg == null || avg === 0) return null;
    return ((cur - avg) / avg) * 100;
}

function deltaTag(cur, avg, opts = {}) {
    const d = deltaPct(cur, avg);
    if (d == null || !isFinite(d)) return '';
    const goodIfHigher = opts.goodIfHigher !== false; // default: higher is better
    const abs = Math.abs(d);
    if (abs < 1) return `<span class="ld-delta ld-delta-flat" title="vs avg">≈</span>`;
    const isUp = d > 0;
    const isGood = goodIfHigher ? isUp : !isUp;
    const tone = isGood ? 'good' : 'bad';
    const arrow = isUp ? '▲' : '▼';
    return `<span class="ld-delta ld-delta-${tone}" title="vs avg">${arrow}${abs.toFixed(0)}%</span>`;
}

function statCards(s) {
    const tpsState = s.dispCurTps == null ? 'idle'
        : (s.avgTps && s.dispCurTps >= s.avgTps * 0.9 ? 'good'
        : (s.avgTps && s.dispCurTps >= s.avgTps * 0.7 ? 'warn' : 'bad'));
    const sucState = s.successRate == null ? 'idle'
        : (s.successRate >= 95 ? 'good' : (s.successRate >= 80 ? 'warn' : 'bad'));
    const sucPct = s.successRate != null ? Math.max(0, Math.min(100, s.successRate)) : 0;
    const failState = s.failed === 0 ? 'good' : (s.failed < 3 ? 'warn' : 'bad');

    // Time progress: elapsed / (elapsed + eta)
    const totalMs = (s.elapsedMs || 0) + (s.etaMs || 0);
    const timePct = totalMs > 0 ? Math.round(((s.elapsedMs || 0) / totalMs) * 100) : 0;
    const completionPct = s.total ? Math.round((s.completed / s.total) * 100) : 0;

    const speedHero = s.dispCurTps != null ? fmtNum(s.dispCurTps) : '—';
    const speedHeroLbl = s.curTpsIsLast ? 'last tok/s' : 'live tok/s';
    const tpsSpark = sparkline(s.tpsRecent, '#4fc3f7', { w: 84, h: 22 });
    const latSpark = sparkline(s.latRecent, '#ffa726', { w: 84, h: 16 });

    return `
        <div class="ld-dash-stats ld-stats-v2">
            <div class="ld-stat ld-stat-${tpsState}" title="Generation speed">
                <div class="ld-stat-head"><span class="ld-stat-icon">⚡</span><span>SPEED</span></div>
                <div class="ld-stat-hero">
                    <span class="ld-stat-hero-val">${speedHero}</span>
                    <span class="ld-stat-hero-unit">tok/s</span>
                    ${deltaTag(s.dispCurTps, s.avgTps, { goodIfHigher: true })}
                </div>
                <div class="ld-stat-hero-lbl">${speedHeroLbl}</div>
                <div class="ld-stat-spark-row">${tpsSpark}</div>
                <div class="ld-stat-sub">
                    <span class="ld-stat-sub-val">${s.avgTps != null ? fmtNum(s.avgTps) : '—'}</span>
                    <span class="ld-stat-sub-lbl">avg tok/s</span>
                </div>
                <div class="ld-stat-sub">
                    <span class="ld-stat-sub-val">${s.dispCurLatency != null ? fmtMs(s.dispCurLatency) : '—'}</span>
                    <span class="ld-stat-sub-lbl">${s.curLatencyIsLast ? 'last' : 'cur'} latency</span>
                </div>
                <div class="ld-stat-spark-row">${latSpark}</div>
                <div class="ld-stat-sub">
                    <span class="ld-stat-sub-val">${s.avgLatency != null ? fmtMs(s.avgLatency) : '—'}</span>
                    <span class="ld-stat-sub-lbl">avg latency</span>
                </div>
            </div>

            <div class="ld-stat ld-stat-${sucState}" title="Throughput &amp; reliability">
                <div class="ld-stat-head"><span class="ld-stat-icon">📊</span><span>THROUGHPUT</span></div>
                <div class="ld-stat-hero">
                    <span class="ld-stat-hero-val">${s.testsPerMin != null ? fmtNum(s.testsPerMin) : '—'}</span>
                    <span class="ld-stat-hero-unit">/ min</span>
                </div>
                <div class="ld-stat-hero-lbl">tests / minute</div>
                <div class="ld-stat-sub">
                    <span class="ld-stat-sub-val">${s.totalTokens > 0 ? s.totalTokens.toLocaleString() : '—'}</span>
                    <span class="ld-stat-sub-lbl">total tokens</span>
                </div>
                <div class="ld-stat-meter" title="Success rate">
                    <div class="ld-stat-meter-head">
                        <span class="ld-stat-meter-lbl">success</span>
                        <span class="ld-stat-meter-val ld-meter-${sucState}">${s.successRate != null ? `${s.successRate.toFixed(0)}%` : '—'}</span>
                    </div>
                    <div class="ld-stat-meter-bar"><div class="ld-stat-meter-fill ld-meter-${sucState}" style="width:${sucPct}%"></div></div>
                </div>
                <div class="ld-stat-chips">
                    <span class="ld-chip ld-chip-${failState}">${ledDot(failState)}<b>${s.failed}</b><span>failed</span></span>
                </div>
            </div>

            <div class="ld-stat ld-stat-time" title="Time &amp; ETA">
                <div class="ld-stat-head"><span class="ld-stat-icon">⏱</span><span>TIME</span></div>
                <div class="ld-stat-hero">
                    <span class="ld-stat-hero-val">${s.etaMs != null ? elapsedStr(s.etaMs) : '—'}</span>
                </div>
                <div class="ld-stat-hero-lbl">eta remaining</div>
                <div class="ld-stat-meter" title="Elapsed vs ETA">
                    <div class="ld-stat-meter-head">
                        <span class="ld-stat-meter-lbl">elapsed</span>
                        <span class="ld-stat-meter-val" data-live-elapsed-since="${s.startedAt ? new Date(s.startedAt).getTime() : ''}">${s.elapsedMs != null ? elapsedStr(s.elapsedMs) : '—'}</span>
                    </div>
                    <div class="ld-stat-meter-bar ld-meter-time">
                        <div class="ld-stat-meter-fill ld-meter-time-fill" style="width:${timePct}%"></div>
                        <div class="ld-stat-meter-marker" style="left:${completionPct}%" title="${completionPct}% tests done"></div>
                    </div>
                </div>
                <div class="ld-stat-sub">
                    <span class="ld-stat-sub-val">${s.avgTestMs != null ? elapsedSecShort(s.avgTestMs) : '—'}</span>
                    <span class="ld-stat-sub-lbl">avg / test</span>
                </div>
            </div>
        </div>`;
}

function testDashboard(ct, batch, results) {
    const completed = batch.completed ?? 0;
    const failed = batch.failed ?? 0;
    const total = batch.total || batch.total_tests || 0;
    const stage = ct?.stage || 'idle';
    const model = ct?.model || '—';
    const testNum = ct?.test_number || '?';
    const isActive = stage === 'executing' || stage === 'warmup';

    const js = batch.judge_stats || {};
    const jCompleted = js.completed ?? batch.judge_completed ?? 0;
    const jTotal = js.total ?? batch.judge_total ?? 0;

    const testPct = pct(completed, total);
    const judgePct = pct(jCompleted, jTotal);

    // Stage indicator
    let stageIcon, stageText;
    if (stage === 'idle')         { stageIcon = '◻'; stageText = 'Idle'; }
    else if (stage === 'warmup')  { stageIcon = '◌'; stageText = 'Warming up…'; }
    else if (stage === 'executing') { stageIcon = '◉'; stageText = 'Generating…'; }
    else                          { stageIcon = '◉'; stageText = 'Responded'; }

    // Current test info
    const promptName = ct?.prompt_name || '';
    const promptLevel = ct?.prompt_level;
    const promptCategory = ct?.prompt_category || '';

    // ── Rolling stats ──
    const completedResults = results.filter(r => r.response || r.response_preview);
    const latencies = completedResults.map(r => r.latency).filter(v => v != null);
    const tpsValues = completedResults.map(r => r.tokens_per_sec).filter(v => v != null);
    const tokenCounts = completedResults.map(r => r.tokens).filter(v => v != null);
    const successCount = completedResults.filter(r => r.success !== false).length;

    const avgLatency = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
    const avgTps = tpsValues.length ? tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length : null;
    const totalTokens = tokenCounts.reduce((a, b) => a + b, 0);
    const successRate = completedResults.length ? (successCount / completedResults.length * 100) : null;
    const curLatency = ct?.latency;
    const curTps = ct?.tokens_per_sec;

    // CUR values are only set on stage='responded' (after a test finishes). While
    // 'executing' (no streaming), they're null. Fall back to the most recent
    // completed test's metrics so the dashboard isn't a wall of dashes during
    // long generations — flag those as "last" instead of "cur".
    const lastCompleted = completedResults.length
        ? completedResults
            .slice()
            .sort((a, b) => {
                const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
                const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
                return tb - ta;
            })[0]
        : null;
    const curTpsIsLast = curTps == null && lastCompleted?.tokens_per_sec != null;
    const curLatencyIsLast = curLatency == null && lastCompleted?.latency != null;
    const dispCurTps = curTps != null ? curTps : (lastCompleted?.tokens_per_sec ?? null);
    const dispCurLatency = curLatency != null ? curLatency : (lastCompleted?.latency ?? null);

    // Recent-window rolling samples for sparklines (last 20)
    const tpsRecent = tpsValues.slice(-20);
    const latRecent = latencies.slice(-20);

    const startedAt = batch.started_at || batch.execution_started_at;
    const elapsedMs = startedAt ? Date.now() - new Date(startedAt).getTime() : null;
    const em = batch.execution_metrics || {};
    const remaining = Math.max(0, total - completed);
    const avgTestMs = em.avg_test_duration_ms || (latencies.length ? avgLatency : null);
    const etaMs = avgTestMs && remaining > 0 ? avgTestMs * remaining : null;
    const testsPerMin = em.tests_per_minute || (elapsedMs > 60000 && completed > 0 ? (completed / (elapsedMs / 60000)) : null);

    // ── Current-test runtime (the test running RIGHT NOW) ──
    const ctStartedAt = ct?.started_at ? new Date(ct.started_at).getTime() : null;
    const ctRuntimeMs = (isActive && ctStartedAt) ? Date.now() - ctStartedAt : null;
    const expectedMs = avgTestMs || null;

    // Per-test timeout from execution_config (default: 10 min). The orchestrator
    // aborts the request when ctRuntimeMs > timeoutMs — so we surface it.
    const ec = batch.execution_config || {};
    const timeoutMs = Number(ec.per_test_timeout_ms) || 600000; // 10min default

    // Bar reflects progress toward the *timeout*, not just the avg. The avg
    // is rendered as a tick mark so the user sees both reference points.
    let runtimeBarPct = 0;
    let expectedTickPct = expectedMs ? Math.min(100, (expectedMs / timeoutMs) * 100) : null;
    let runtimeState = 'good';
    let stallReason = null;
    if (ctRuntimeMs != null) {
        runtimeBarPct = Math.min(100, Math.round((ctRuntimeMs / timeoutMs) * 100));
        const stallFloorMs = Math.max(60000, (expectedMs || 0) * 3); // 1min or 3× avg
        if (ctRuntimeMs > timeoutMs * 0.85) {
            runtimeState = 'bad';
            stallReason = `Approaching ${elapsedSecShort(timeoutMs)} timeout — request will be aborted`;
        } else if (expectedMs && ctRuntimeMs > stallFloorMs) {
            runtimeState = 'bad';
            stallReason = `Stalled — running ${(ctRuntimeMs / expectedMs).toFixed(1)}× longer than avg test (${elapsedSecShort(expectedMs)})`;
        } else if (expectedMs && ctRuntimeMs > expectedMs * 1.5) {
            runtimeState = 'warn';
        }
    }
    const remainingTimeoutMs = ctRuntimeMs != null ? Math.max(0, timeoutMs - ctRuntimeMs) : null;
    const runtimeHTML = isActive ? `
        <div class="ld-runtime ld-runtime-${runtimeState}">
            <span class="ld-runtime-pulse"></span>
            <span class="ld-runtime-lbl">RUNNING</span>
            <span class="ld-runtime-val" data-live-elapsed-since="${ctStartedAt || ''}">${elapsedSecShort(ctRuntimeMs)}</span>
            <span class="ld-runtime-sep">/</span>
            ${expectedMs ? `<span class="ld-runtime-exp">~${elapsedSecShort(expectedMs)} avg</span>` : ''}
            <span class="ld-runtime-exp ld-runtime-timeout-lbl">timeout ${elapsedSecShort(timeoutMs)}</span>
            <div class="ld-runtime-bar" title="Progress toward per-test timeout">
                <div class="ld-runtime-bar-fill" style="width:${runtimeBarPct}%"></div>
                ${expectedTickPct != null ? `<div class="ld-runtime-bar-tick" style="left:${expectedTickPct}%" title="avg test duration"></div>` : ''}
            </div>
            ${remainingTimeoutMs != null && runtimeState !== 'good' ? `<span class="ld-runtime-countdown">${elapsedSecShort(remainingTimeoutMs)} left</span>` : ''}
        </div>
        ${stallReason ? `<div class="ld-stall-warn"><span class="ld-stall-icon">⚠</span><span class="ld-stall-msg">${esc(stallReason)}</span></div>` : ''}
    ` : '';

    // Flags
    let flagsHTML = '';
    const matchingResult = ct ? findResultForCurrentTest(results, ct) : null;
    if (matchingResult) {
        const flags = [];
        if (matchingResult.truncation?.hidden_response_cap) flags.push('<span class="ld-flag ld-flag-invalid">hidden cap</span>');
        else if (matchingResult.truncation?.response_truncated) flags.push('<span class="ld-flag ld-flag-trunc">truncated</span>');
        if (matchingResult.excluded_from_leaderboard) flags.push('<span class="ld-flag ld-flag-invalid">excluded</span>');
        if (matchingResult.needs_review) flags.push('<span class="ld-flag ld-flag-review">review</span>');
        if (matchingResult.success === false) flags.push('<span class="ld-flag ld-flag-error">✗ failed</span>');
        if (flags.length) flagsHTML = `<div class="ld-flags-row">${flags.join('')}</div>`;
    }

    // Score sparkline
    const dots = scoreDots(recentScores(results));

    return `<div class="ld-dashboard ${isActive ? 'ld-dashboard-active' : ''}">
        <div class="ld-dash-row">
            <div class="ld-dash-hero">
                ${progressRing(testPct, 'TESTS', 'var(--r-active)', 80)}
            </div>
            <div class="ld-dash-center">
                <div class="ld-dash-bars">
                    <div class="ld-dual-bar">
                        <span class="ld-bar-label">Test</span>
                        <div class="ld-bar-track"><div class="ld-bar-fill ld-bar-test" style="width:${testPct}%"></div></div>
                        <span class="ld-bar-val">${completed}/${total}</span>
                    </div>
                    <div class="ld-dual-bar">
                        <span class="ld-bar-label">Judge</span>
                        <div class="ld-bar-track"><div class="ld-bar-fill ld-bar-judge" style="width:${judgePct}%"></div></div>
                        <span class="ld-bar-val">${jCompleted}/${jTotal}</span>
                    </div>
                </div>
                <div class="ld-dash-now ${isActive ? 'ld-now-active' : ''}">
                    <span class="ld-now-icon">${stageIcon}</span>
                    <span class="ld-now-model">${esc(model)}</span>
                    <span class="ld-now-sep">›</span>
                    <span class="ld-now-prompt">${esc(promptName) || '—'}</span>
                    ${promptLevel ? levelBadge(promptLevel) : ''}
                    ${promptCategory ? `<span class="ld-now-cat">${esc(promptCategory)}</span>` : ''}
                    <span class="ld-now-num">#${testNum}</span>
                    <span class="ld-now-stage">${stageText}</span>
                    ${flagsHTML}
                </div>
                ${runtimeHTML}
                ${dots}
            </div>
            ${statCards({
                dispCurTps, curTpsIsLast, avgTps, tpsRecent,
                dispCurLatency, curLatencyIsLast, avgLatency, latRecent,
                testsPerMin, totalTokens, successRate, failed,
                completed, total,
                startedAt, elapsedMs, etaMs, avgTestMs,
            })}
        </div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// BOTTOM — JUDGE LANE (Q&A exhibit + decision tree)
// ══════════════════════════════════════════════════════════════════════════════

// ── Decision tree helpers ─────────────────────────────────────────────────────

const METHOD_META = {
    deterministic:   { label: 'Deterministic',   icon: '⚡', cls: 'jdt-method-det' },
    quick:           { label: 'Quick Pattern',    icon: '⚡', cls: 'jdt-method-det' },
    llm_judge:       { label: 'LLM Judge',        icon: '🤖', cls: 'jdt-method-llm' },
    decomposed:      { label: 'Decomposed Judge', icon: '🤖', cls: 'jdt-method-llm' },
    reference:       { label: 'Reference Judge',  icon: '🤖', cls: 'jdt-method-llm' },
    reference_quick: { label: 'Reference Quick',  icon: '🤖', cls: 'jdt-method-llm' },
    hybrid:          { label: 'Hybrid',           icon: '🔀', cls: 'jdt-method-hyb' },
    llm_failed:      { label: 'Judge Failed',     icon: '✗',  cls: 'jdt-method-fail' },
    empty_response:  { label: 'Empty Response',   icon: '✗',  cls: 'jdt-method-fail' },
    pending:         { label: 'Pending',          icon: '◌',  cls: 'jdt-method-wait' },
    skipped:         { label: 'Skipped',          icon: '—',  cls: 'jdt-method-wait' },
};

const DET_TYPE_META = {
    numeric:    { label: 'numeric_eval',    desc: 'Extracts a number from the response and compares to expected answer within tolerance.' },
    exact:      { label: 'exact_match',     desc: 'Normalises both texts then checks for string equality or containment.' },
    json:       { label: 'json_compare',    desc: 'Parses response as JSON and performs deep equality against expected structure.' },
    regex:      { label: 'regex_patterns',  desc: 'Checks must-contain / must-not-contain regex patterns with optional per-pattern weights.' },
};

function judgePathBreadcrumb(s) {
    const method = s.scoring_method || 'pending';
    const mm = METHOD_META[method] || { label: method, icon: '?', cls: '' };
    const crumbs = [`<span class="jdt-crumb ${mm.cls}">${mm.icon} ${mm.label}</span>`];

    if (method === 'deterministic' || method === 'quick') {
        const dt = s.quality_breakdown?.type || s.scoring_type || '';
        const dtm = DET_TYPE_META[dt];
        if (dtm) crumbs.push(`<span class="jdt-crumb jdt-crumb-sub">${dtm.label}</span>`);
    } else if (method === 'llm_judge' || method === 'decomposed' || method === 'reference' || method === 'reference_quick') {
        const jm = s.judge_model || '';
        if (jm) crumbs.push(`<span class="jdt-crumb jdt-crumb-sub">${esc(jm)}</span>`);
    }

    return crumbs.join('<span class="jdt-arrow">→</span>');
}

function judgingDecisionTree(s) {
    const method = s.scoring_method || 'pending';
    const score = s.quality_score ?? s.composite_score;
    const color = score != null ? scoreColor(score) : '#666';
    const display = score != null ? Number(score).toFixed(1) : '—';
    const conf = s.judge_confidence;
    const scoringTime = s.scoring_time_ms;

    // ── Method description line ──
    const dt = s.quality_breakdown?.type || s.scoring_type || '';
    const dtm = DET_TYPE_META[dt];
    let methodDescHTML = '';
    if (dtm) {
        methodDescHTML = `<div class="jdt-method-desc">${dtm.desc}</div>`;
    }

    // ── Routing explanation ──
    const routeSteps = [];
    if (method === 'deterministic' || method === 'quick') {
        routeSteps.push({ icon: '1', label: 'Deterministic scoring checked first', status: 'pass' });
        if (dt) routeSteps.push({ icon: '2', label: `Method: ${DET_TYPE_META[dt]?.label || dt}`, status: 'pass' });
        routeSteps.push({ icon: '3', label: 'LLM judge bypassed — deterministic result is authoritative', status: 'skip' });
    } else if (method === 'llm_judge' || method === 'decomposed' || method === 'reference' || method === 'reference_quick') {
        routeSteps.push({ icon: '1', label: 'Deterministic scoring: not applicable or no confident match', status: 'skip' });
        routeSteps.push({ icon: '2', label: `LLM judge invoked: ${esc(s.judge_model || '—')}`, status: 'pass' });
    } else if (method === 'hybrid') {
        routeSteps.push({ icon: '1', label: 'Deterministic accuracy scoring applied', status: 'pass' });
        routeSteps.push({ icon: '2', label: `LLM compliance check: ${esc(s.judge_model || '—')}`, status: 'pass' });
        routeSteps.push({ icon: '3', label: 'Scores combined into hybrid composite', status: 'pass' });
    } else if (method === 'llm_failed') {
        routeSteps.push({ icon: '1', label: 'LLM judge invoked but returned no valid score', status: 'fail' });
        routeSteps.push({ icon: '2', label: 'Result marked llm_failed — score set to null', status: 'fail' });
    }

    const routeHTML = routeSteps.map(step => {
        const cls = step.status === 'pass' ? 'jdt-step-pass'
                  : step.status === 'fail' ? 'jdt-step-fail'
                  : 'jdt-step-skip';
        const icon = step.status === 'pass' ? '✓' : step.status === 'fail' ? '✗' : '↷';
        return `<div class="jdt-route-step ${cls}">
            <span class="jdt-step-icon">${icon}</span>
            <span class="jdt-step-label">${step.label}</span>
        </div>`;
    }).join('');

    // ── Deterministic evidence block ──
    let evidenceHTML = '';
    if ((method === 'deterministic' || method === 'quick') && s.quality_explanation) {
        const expectedAns = s.expected_answer;
        const explanationText = s.quality_explanation;

        // Try to surface numeric/comparison detail from explanation text
        const matchIcon = (score != null && score >= 9) ? '✓' : (score != null && score > 0) ? '~' : '✗';
        const matchCls  = (score != null && score >= 9) ? 'jdt-ev-match' : (score != null && score > 0) ? 'jdt-ev-partial' : 'jdt-ev-mismatch';

        evidenceHTML = `<div class="jdt-evidence">
            <div class="jdt-ev-head">EVALUATION EVIDENCE</div>
            ${expectedAns != null ? `<div class="jdt-ev-row">
                <span class="jdt-ev-label">Expected</span>
                <span class="jdt-ev-val jdt-ev-expected">${esc(String(expectedAns))}</span>
            </div>` : ''}
            <div class="jdt-ev-row ${matchCls}">
                <span class="jdt-ev-label">Verdict</span>
                <span class="jdt-ev-val">${matchIcon} ${esc(explanationText)}</span>
            </div>
        </div>`;
    }

    // ── Dimensions / breakdown ──
    let dimsHTML = '';
    const breakdown = s.quality_breakdown || s.decomposed_score;
    if (Array.isArray(breakdown) && breakdown.length) {
        const rows = breakdown.map(d => {
            const pass = d.passed ?? (d.score >= 1);
            const name = d.dimension || d.name || '?';
            const dimScore = d.score != null ? Number(d.score).toFixed(1) : '';
            const weight = d.weight != null ? `×${d.weight}` : '';
            const dimDesc = d.description || d.details || '';
            return `<div class="jdt-dim-row ${pass ? 'jdt-dim-pass' : 'jdt-dim-fail'}">
                <span class="jdt-dim-verdict">${pass ? '✓' : '✗'}</span>
                <div class="jdt-dim-body">
                    <div class="jdt-dim-top">
                        <span class="jdt-dim-name">${esc(name)}</span>
                        <span class="jdt-dim-score">${dimScore}${weight ? ` <span class="jdt-dim-weight">${weight}</span>` : ''}</span>
                    </div>
                    ${dimDesc ? `<div class="jdt-dim-desc">${esc(dimDesc)}</div>` : ''}
                </div>
            </div>`;
        }).join('');
        dimsHTML = `<div class="jdt-dims"><div class="jdt-ev-head">SCORING DIMENSIONS</div>${rows}</div>`;
    }

    // ── LLM reasoning ──
    let reasoningHTML = '';
    if (s.quality_explanation && method !== 'deterministic' && method !== 'quick') {
        reasoningHTML = `<div class="jdt-reasoning">
            <div class="jdt-ev-head">JUDGE REASONING</div>
            <div class="jdt-reasoning-text">${esc(s.quality_explanation)}</div>
        </div>`;
    }

    // ── Hybrid sub-scores ──
    let hybridHTML = '';
    if (method === 'hybrid' && (s.accuracy_score != null || s.compliance_score != null)) {
        hybridHTML = `<div class="jdt-hybrid">
            <div class="jdt-ev-head">HYBRID BREAKDOWN</div>
            <div class="jdt-hybrid-grid">
                ${s.accuracy_score != null ? `<div class="jdt-hybrid-cell">
                    <span class="jdt-hybrid-val">${Number(s.accuracy_score).toFixed(1)}</span>
                    <span class="jdt-hybrid-label">accuracy</span>
                </div>` : ''}
                ${s.compliance_score != null ? `<div class="jdt-hybrid-cell">
                    <span class="jdt-hybrid-val">${Number(s.compliance_score).toFixed(1)}</span>
                    <span class="jdt-hybrid-label">compliance</span>
                </div>` : ''}
                ${s.semantic_score != null ? `<div class="jdt-hybrid-cell">
                    <span class="jdt-hybrid-val">${Number(s.semantic_score).toFixed(1)}</span>
                    <span class="jdt-hybrid-label">semantic</span>
                </div>` : ''}
                ${s.format_score != null ? `<div class="jdt-hybrid-cell">
                    <span class="jdt-hybrid-val ${s.format_compliant === false ? 'jdt-score-fail' : ''}">${Number(s.format_score).toFixed(1)}</span>
                    <span class="jdt-hybrid-label">format</span>
                </div>` : ''}
            </div>
        </div>`;
    }

    // ── Review flag ──
    let envelopeHTML = '';
    const trunc = s.truncation || {};
    const exec = s.execution_settings || {};
    const envelopeRows = [];
    if (trunc.response_limit != null || exec.num_predict != null) {
        envelopeRows.push(['Runtime cap', trunc.response_limit ?? exec.num_predict]);
    }
    if (exec.answer_contract_applied) {
        const parts = [];
        if (exec.answer_contract_target_tokens != null) parts.push(`target ${exec.answer_contract_target_tokens}`);
        if (exec.answer_contract_max_tokens != null) parts.push(`max ${exec.answer_contract_max_tokens}`);
        envelopeRows.push(['Visible answer contract', parts.join(', ') || 'applied']);
    } else if (trunc.response_truncated) {
        envelopeRows.push(['Visible answer contract', 'not applied']);
    }
    if (trunc.response_truncated) envelopeRows.push(['Generation stop', trunc.done_reason || 'length']);
    if (trunc.hidden_response_cap) envelopeRows.push(['Score validity', 'invalid: hidden runtime cap']);
    if (s.excluded_from_leaderboard) envelopeRows.push(['Leaderboard', 'excluded']);

    if (envelopeRows.length) {
        envelopeHTML = `<div class="jdt-envelope ${isExcluded(s) ? 'jdt-envelope-invalid' : ''}">
            <div class="jdt-ev-head">EXECUTION ENVELOPE</div>
            ${envelopeRows.map(([k, v]) => `<div class="jdt-ev-row">
                <span class="jdt-ev-label">${esc(k)}</span>
                <span class="jdt-ev-val">${esc(v)}</span>
            </div>`).join('')}
        </div>`;
    }

    let reviewHTML = '';
    if (s.needs_review) {
        reviewHTML = `<div class="jdt-review-flag">
            <span class="jdt-review-icon">⚠</span>
            <span>Flagged for review${s.review_reason ? `: ${esc(s.review_reason)}` : ''}</span>
        </div>`;
    }

    // ── Collapsible: judge prompt ──
    let rawBlocksHTML = '';
    if (s.judge_prompt || s.judge_raw_response) {
        const parts = [];
        if (s.judge_prompt) {
            parts.push(`<div class="ld-block ld-collapsible" data-collapsed="true">
                <div class="ld-block-head ld-block-toggle"><span class="ld-block-label">JUDGE PROMPT</span><span class="ld-toggle-arrow">▶</span></div>
                <pre class="ld-raw-text ld-collapse-body">${esc(s.judge_prompt)}</pre>
            </div>`);
        }
        if (s.judge_raw_response) {
            parts.push(`<div class="ld-block ld-collapsible" data-collapsed="true">
                <div class="ld-block-head ld-block-toggle"><span class="ld-block-label">RAW JUDGE RESPONSE</span><span class="ld-toggle-arrow">▶</span></div>
                <pre class="ld-raw-text ld-collapse-body">${esc(s.judge_raw_response)}</pre>
            </div>`);
        }
        rawBlocksHTML = parts.join('');
    }

    // ── Meta bar ──
    const metaParts = [];
    if (scoringTime != null) metaParts.push(`<span>${fmtMs(scoringTime)}</span>`);
    if (conf != null) metaParts.push(`<span class="jdt-conf">${Math.round(conf * 100)}% confidence</span>`);
    if (s.prompt_complexity != null) metaParts.push(`<span>complexity ${s.prompt_complexity}/10</span>`);

    return `<div class="jdt-panel">
        <div class="jdt-panel-head">
            <div class="jdt-breadcrumb">${judgePathBreadcrumb(s)}</div>
            <div class="jdt-score-inline">
                <span class="jdt-score-val" style="color:${color}">${display}</span>
                <span class="jdt-score-of">/10</span>
            </div>
            ${metaParts.length ? `<div class="jdt-meta">${metaParts.join('<span class="jdt-meta-sep">·</span>')}</div>` : ''}
        </div>
        ${methodDescHTML}
        <div class="jdt-route">${routeHTML}</div>
        ${evidenceHTML}
        ${dimsHTML}
        ${reasoningHTML}
        ${hybridHTML}
        ${envelopeHTML}
        ${reviewHTML}
        ${rawBlocksHTML}
    </div>`;
}

function judgeLane(batch, lastScored, currentlyJudging) {
    const judgeModel = batch.judge_config?.model || batch.judge_model || '—';
    const js = batch.judge_stats || {};
    const pa = batch.pipeline_activity?.judging;
    const judgeStatus = batch.judge_status || 'none';
    const jCompleted = js.completed ?? batch.judge_completed ?? 0;
    const jTotal = js.total ?? batch.judge_total ?? 0;
    const jPending = js.pending ?? Math.max(0, jTotal - jCompleted);
    const jFailed = js.failed ?? batch.judge_failed ?? 0;
    const lag = js.lag ?? jPending;
    const avgTime = js.avg_time_ms ?? js.eta_avg_ms;
    const concurrency = js.concurrency;

    const isJudgeRunning = judgeStatus === 'running' || batch.status === 'judging';
    const isActive = isJudgeRunning && (jPending > 0 || (pa && pa.pending > 0));
    const hasAnyJudging = jTotal > 0;
    const hasScored = lastScored != null;
    const progressPct = pct(jCompleted, jTotal);

    // Judge lane pill
    let judgePill;
    if (!hasAnyJudging)      judgePill = '<span class="ld-pill ld-pill-wait">waiting</span>';
    else if (isActive)       judgePill = '<span class="ld-pill ld-pill-judge"><span class="ld-sb-spinner"></span> judging</span>';
    else if (!isJudgeRunning && jPending > 0) judgePill = '<span class="ld-pill ld-pill-wait">waiting for generation</span>';
    else if (jCompleted > 0) judgePill = '<span class="ld-pill ld-pill-done">complete</span>';
    else                     judgePill = '<span class="ld-pill ld-pill-wait">idle</span>';

    // Queue meta tags
    const queueTags = [];
    if (jPending > 0) queueTags.push(`<span class="ld-queue-tag ld-qt-pending">${jPending} pending</span>`);
    if (!isJudgeRunning && jPending > 0) queueTags.push('<span class="ld-queue-tag">phase waits for generation</span>');
    if (lag > 0 && lag !== jPending) queueTags.push(`<span class="ld-queue-tag ld-qt-lag">lag ${lag}</span>`);
    if (avgTime != null) queueTags.push(`<span class="ld-queue-tag">avg ${fmtMs(avgTime)}</span>`);
    if (concurrency) queueTags.push(`<span class="ld-queue-tag">×${concurrency}</span>`);
    if (jFailed > 0) queueTags.push(`<span class="ld-queue-tag ld-qt-fail">${jFailed} failed</span>`);

    // Progress strip
    const stripHTML = hasAnyJudging ? `<div class="ld-jstrip">
        <div class="ld-bar-track ld-jstrip-bar"><div class="ld-bar-fill ld-bar-judge" style="width:${progressPct}%"></div></div>
        <span class="ld-jstrip-count">${jCompleted}/${jTotal}</span>
        ${queueTags.join('')}
    </div>` : '';

    // ── Content being judged ──
    const exhibit = (isJudgeRunning ? currentlyJudging : null) || lastScored;
    const exhibitLabel = currentlyJudging ? 'CURRENTLY EVALUATING' : (hasScored ? 'LAST EVALUATED' : '');

    let contentHTML = '';
    if (exhibit) {
        const promptName = exhibit.prompt_name || '?';
        const promptLevel = exhibit.prompt_level || exhibit.level;
        const promptCategory = exhibit.prompt_category || exhibit.category || '';
        const questionText = exhibit.prompt || exhibit.prompt_preview || exhibit.prompt_text || '';
        const exhibitModel = exhibit.model || '';

        // Three-pane response tabs when we have the full response; preview fallback during streaming.
        const hasFinalResponse = exhibit.response != null && exhibit.response !== '';
        const previewText = exhibit.response_preview || '';

        const responseHTML = hasFinalResponse
            ? renderRawCuratedJudgePanes(exhibit, { idPrefix: 'ld-rrp' })
            : `<pre class="ld-ep-text ld-ep-mono">${esc(previewText) || '<span class="ld-text-dim">No response text</span>'}</pre>`;

        // Decision tree — only for scored results (not mid-stream)
        const decisionHTML = (exhibit.quality_score != null || exhibit.scoring_method === 'llm_failed')
            ? judgingDecisionTree(exhibit)
            : '';

        contentHTML = `<div class="ld-exhibit">
            <div class="ld-exhibit-head">
                <span class="ld-exhibit-label">${exhibitLabel}</span>
                <span class="ld-tag">${esc(promptName)}</span>
                ${promptLevel ? levelBadge(promptLevel) : ''}
                ${promptCategory ? `<span class="ld-tag">${esc(promptCategory)}</span>` : ''}
                ${exhibitModel ? `<span class="ld-tag-dim">${esc(exhibitModel)}</span>` : ''}
                ${currentlyJudging ? '<span class="ld-pill ld-pill-judge"><span class="ld-sb-spinner"></span> judging</span>' : ''}
            </div>
            <div class="ld-exhibit-panels">
                <div class="ld-exhibit-panel ld-ep-q">
                    <div class="ld-ep-head"><span class="ld-ep-icon">❓</span> QUESTION</div>
                    <div class="ld-ep-text">${esc(questionText) || '<span class="ld-text-dim">No prompt text</span>'}</div>
                </div>
                <div class="ld-exhibit-panel ld-ep-r">
                    <div class="ld-ep-head"><span class="ld-ep-icon">💬</span> RESPONSE</div>
                    ${responseHTML}
                </div>
            </div>
            ${decisionHTML}
        </div>`;
    } else if (hasAnyJudging && isActive) {
        contentHTML = `<div class="ld-exhibit ld-exhibit-wait">
            <span class="ld-sb-spinner"></span>
            <span>Waiting for first evaluation…</span>
        </div>`;
    } else if (hasAnyJudging && !isJudgeRunning && jPending > 0) {
        contentHTML = `<div class="ld-exhibit ld-exhibit-wait">
            <span>Judge phase is queued and will begin after generation completes.</span>
        </div>`;
    }

    // ── Batch scoring summary ──
    let summaryHTML = '';
    if (jCompleted > 0) {
        const allResults = batch.results || [];
        const scored = allResults.filter(r => r.quality_score != null);
        if (scored.length > 0) {
            const scores = scored.map(r => r.quality_score);
            const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
            const min = Math.min(...scores);
            const max = Math.max(...scores);
            const passCount = scored.filter(r => (r.quality_score ?? 0) >= 5).length;
            const avgColor = scoreColor(avg);

            summaryHTML = `<div class="ld-judge-summary">
                <div class="ld-summary-grid">
                    <span class="ld-summary-stat"><span class="ld-summary-val" style="color:${avgColor}">${fmtNum(avg)}</span><span class="ld-summary-label">avg</span></span>
                    <span class="ld-summary-stat"><span class="ld-summary-val">${fmtNum(min)}</span><span class="ld-summary-label">min</span></span>
                    <span class="ld-summary-stat"><span class="ld-summary-val">${fmtNum(max)}</span><span class="ld-summary-label">max</span></span>
                    <span class="ld-summary-stat"><span class="ld-summary-val">${passCount}/${scored.length}</span><span class="ld-summary-label">pass</span></span>
                </div>
            </div>`;
        }
    }

    return `<div class="ld-lane ld-lane-judge ${isActive ? 'ld-lane-active' : ''}">
        <div class="ld-lane-head">
            <span class="ld-lane-icon">⚖️</span>
            <span class="ld-lane-title">Judge Lane</span>
            <span class="ld-model-name">${esc(judgeModel)}</span>
            ${judgePill}
            ${summaryHTML}
        </div>
        <div class="ld-lane-body">
            ${stripHTML}
            <div class="ld-judge-main">
                ${contentHTML}
            </div>
        </div>
    </div>`;
}

// ── Layout builder ───────────────────────────────────────────────────────────

function buildHTML(batch) {
    const ct = batch.current_test;
    const results = batch.results || [];
    const lastScored = findLastScoredResult(results);
    const currentlyJudging = (batch.judge_status === 'running' || batch.status === 'judging')
        ? findCurrentlyJudging(results)
        : null;

    return `<div class="ld-stack ${(!ct || ct.stage === 'idle') ? 'ld-idle' : ''}">
        ${testDashboard(ct, batch, results)}
        ${judgeLane(batch, lastScored, currentlyJudging)}
    </div>`;
}

// ── Collapsible toggle handler ───────────────────────────────────────────────

function handleToggle(e) {
    const toggle = e.target.closest('.ld-block-toggle');
    if (!toggle) return;
    const block = toggle.closest('.ld-collapsible');
    if (!block) return;
    const isCollapsed = block.dataset.collapsed === 'true';
    block.dataset.collapsed = isCollapsed ? 'false' : 'true';
    const arrow = toggle.querySelector('.ld-toggle-arrow');
    if (arrow) arrow.textContent = isCollapsed ? '▼' : '▶';
    const body = block.querySelector('.ld-collapse-body');
    if (body) body.style.display = isCollapsed ? 'block' : 'none';
}

// ── Public API ────────────────────────────────────────────────────────────────

let _liveTickHandle = null;

function ensureLiveTicker(container) {
    if (_liveTickHandle) return;
    _liveTickHandle = setInterval(() => {
        if (!document.body.contains(container)) {
            clearInterval(_liveTickHandle);
            _liveTickHandle = null;
            return;
        }
        const now = Date.now();
        container.querySelectorAll('[data-live-elapsed-since]').forEach(el => {
            const since = Number(el.dataset.liveElapsedSince);
            if (!since) return;
            const ms = now - since;
            // Use compact format for short values (current-test runtime),
            // full format for long values (overall elapsed).
            el.textContent = el.classList.contains('ld-sg-val-big')
                ? elapsedStr(ms)
                : elapsedSecShort(ms);
        });
    }, 1000);
}

export function renderLiveDetail(container, batch) {
    container.innerHTML = buildHTML(batch);
    container.addEventListener('click', handleToggle);
    // Wire Raw / Curated / Judge-raw tabs (task 0172). Listener is attached to
    // the container once; survives subsequent updateLiveDetail() innerHTML
    // replacements via event delegation.
    wireRawCuratedJudgePanes(container);
    ensureLiveTicker(container);
}

export function updateLiveDetail(container, batch) {
    container.innerHTML = buildHTML(batch);
    // Idempotent — only wires once per container.
    wireRawCuratedJudgePanes(container);
    ensureLiveTicker(container);
}
