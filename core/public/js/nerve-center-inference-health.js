/**
 * Nerve Center — Inference Health section.
 * Admission gate state, benchmark claims, watchdog summary, and num_ctx drift.
 * Single consolidated endpoint: GET /api/nerve-center/inference-health
 */
(function () {
    'use strict';

    const shared = window.NerveCenterShared;
    if (!shared) {
        console.warn('[InferenceHealth] NerveCenterShared not loaded');
        return;
    }

    function hostLabel(url) {
        if (!url) return '—';
        return url.replace(/^https?:\/\//, '').replace(/:11434$/, '');
    }

    function humanDuration(ms) {
        if (ms == null) return '—';
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        if (m < 60) return `${m}m ${s % 60}s`;
        return `${Math.floor(m / 60)}h ${m % 60}m`;
    }

    function shortHash(key) {
        return String(key || '').slice(-6);
    }

    // ── Panel builders ────────────────────────────────────────

    function buildGatePanel(gate) {
        if (!gate || gate.error) {
            return `<div class="nc-muted">Gate stats unavailable: ${shared.escapeHtml(gate?.error || 'unknown')}</div>`;
        }
        if (!gate.enabled) {
            return `<div class="nc-muted">Admission gate is disabled (GATE_ENABLED=false).</div>`;
        }

        const entries = gate.entries || [];
        if (entries.length === 0) {
            return `<div class="nc-muted" style="padding:8px 4px;">Gate active, max <strong>${gate.maxInflight}</strong> in-flight per (host, model). No traffic in current window.</div>`;
        }

        const rows = entries.map(e => {
            const tone = e.waiters > 0 ? 'warn' : (e.inFlight >= gate.maxInflight ? 'active' : 'ok');
            const badgeColor = tone === 'warn' ? '#fbbf24' : tone === 'active' ? '#4ade80' : '#94a3b8';
            return `
                <tr>
                    <td style="color:${badgeColor};font-weight:600">${shared.escapeHtml(hostLabel(e.host))}</td>
                    <td style="color:#cbd5e1">${shared.escapeHtml(shared.shortModel ? shared.shortModel(e.model) : e.model)}</td>
                    <td style="text-align:right">${e.inFlight}/${gate.maxInflight}</td>
                    <td style="text-align:right">${e.waiters > 0 ? `<span style="color:#fbbf24">${e.waiters}</span>` : '0'}</td>
                    <td style="text-align:right;color:#64748b">${e.peak}</td>
                    <td style="text-align:right;color:#64748b">${e.maxWaiters}</td>
                    <td style="text-align:right;color:#64748b">${e.totalAcquired}</td>
                </tr>`;
        }).join('');

        return `
            <div class="nc-card" style="margin-bottom:12px;padding:12px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <strong>Admission Gate</strong>
                    <span class="nc-muted" style="font-size:11px;">max ${gate.maxInflight} in-flight per (host, model) • total in-flight ${gate.totalInFlight} • waiters ${gate.totalWaiters}</span>
                </div>
                <table class="nc-table" style="width:100%;font-size:12px;">
                    <thead><tr>
                        <th style="text-align:left">Host</th>
                        <th style="text-align:left">Model</th>
                        <th style="text-align:right">In-flight</th>
                        <th style="text-align:right">Waiters</th>
                        <th style="text-align:right">Peak</th>
                        <th style="text-align:right">Max waiters</th>
                        <th style="text-align:right">Total acquired</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    function buildClaimsPanel(claims) {
        if (!Array.isArray(claims) || claims.length === 0) {
            return `
                <div class="nc-card" style="margin-bottom:12px;padding:12px;">
                    <strong>Benchmark Claims</strong>
                    <div class="nc-muted" style="margin-top:4px;font-size:12px;">No active claims — consumers routing normally.</div>
                </div>`;
        }

        const rows = claims.map(c => {
            const age = humanDuration(c.ageMs);
            const est = humanDuration(c.estimatedDurationMs);
            return `
                <tr>
                    <td style="color:#fbbf24;font-weight:600">${shared.escapeHtml(hostLabel(c.hostUrl))}</td>
                    <td style="color:#cbd5e1">${shared.escapeHtml(c.batchId || '—')}</td>
                    <td style="color:#94a3b8">${shared.escapeHtml(c.prevStatus || 'idle')}</td>
                    <td style="color:#94a3b8">${age}</td>
                    <td style="color:#64748b">${est}</td>
                </tr>`;
        }).join('');

        return `
            <div class="nc-card" style="margin-bottom:12px;padding:12px;border-left:3px solid #fbbf24;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <strong>Benchmark Claims <span class="nc-muted" style="font-weight:normal;font-size:11px;">(consumers auto-route off these hosts)</span></strong>
                    <span class="nc-muted" style="font-size:11px;">${claims.length} active</span>
                </div>
                <table class="nc-table" style="width:100%;font-size:12px;">
                    <thead><tr>
                        <th style="text-align:left">Host</th>
                        <th style="text-align:left">Batch ID</th>
                        <th style="text-align:left">Prev status</th>
                        <th style="text-align:left">Age</th>
                        <th style="text-align:left">Est. duration</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    function buildWatchdogPanel(w) {
        if (!w || w.error) {
            return `<div class="nc-muted">Watchdog stats unavailable: ${shared.escapeHtml(w?.error || 'unknown')}</div>`;
        }
        const okRate = w.probesSent > 0 ? ((w.probesOk / w.probesSent) * 100).toFixed(1) : '—';
        const events = (w.recentEvents || []).slice(0, 5).map(ev => {
            const when = shared.timeAgo ? shared.timeAgo(ev.timestamp) : new Date(ev.timestamp).toLocaleTimeString();
            const tone = ev.type.includes('jam') || ev.type === 'unjam_failed' ? '#f87171'
                       : ev.type.startsWith('grace') ? '#a3e635'
                       : ev.type === 'unjam_success' || ev.type === 'reload_success' || ev.type === 'pin_restore_triggered' ? '#4ade80'
                       : '#94a3b8';
            return `<li style="margin:3px 0;color:${tone};font-size:12px;">
                <span style="color:#64748b">${shared.escapeHtml(when)}</span>
                <strong>${shared.escapeHtml(ev.type)}</strong>
                <span class="nc-muted">${shared.escapeHtml(ev.hostName || ev.hostUrl || '')}</span>
            </li>`;
        }).join('');

        return `
            <div class="nc-card" style="margin-bottom:12px;padding:12px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <strong>Watchdog <span class="nc-muted" style="font-weight:normal;font-size:11px;">(Ollama probe + jam recovery)</span></strong>
                    <span class="nc-muted" style="font-size:11px;">
                        ${w.running ? '<span style="color:#4ade80">● running</span>' : '<span style="color:#f87171">● stopped</span>'}
                    </span>
                </div>
                <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;font-size:12px;margin-bottom:8px;">
                    <div><span class="nc-muted">Probes</span><br><strong>${w.probesSent ?? 0}</strong></div>
                    <div><span class="nc-muted">OK rate</span><br><strong>${okRate}%</strong></div>
                    <div><span class="nc-muted">Failed</span><br><strong style="color:${w.probesFailed > 0 ? '#fbbf24' : 'inherit'}">${w.probesFailed ?? 0}</strong></div>
                    <div><span class="nc-muted">Jams</span><br><strong style="color:${w.jamsDetected > 0 ? '#f87171' : 'inherit'}">${w.jamsDetected ?? 0}</strong></div>
                    <div><span class="nc-muted">Unjams</span><br><strong>${w.unjamsDone ?? 0}</strong></div>
                </div>
                ${events ? `<div><span class="nc-muted" style="font-size:11px;">Recent events:</span><ul style="list-style:none;padding:0;margin:4px 0 0;">${events}</ul></div>` : ''}
            </div>`;
    }

    function buildDriftPanel(drift) {
        if (!drift) return '';
        if (drift.error) {
            return `<div class="nc-muted">Drift unavailable: ${shared.escapeHtml(drift.error)}</div>`;
        }
        const windowMin = Math.round((drift.windowMs || 0) / 60000);
        const t = drift.totals || {};
        const pct = drift.driftPct;
        const hasSamples = drift.hasSamples === true && Number.isFinite(pct);
        const driftTone = !hasSamples ? '#94a3b8' : pct > 10 ? '#f87171' : pct > 2 ? '#fbbf24' : '#4ade80';

        const rows = (drift.byCallerSource || []).map(r => `
            <tr>
                <td style="color:#cbd5e1">${shared.escapeHtml(r.caller || '—')}</td>
                <td><span style="color:${r.source === 'modelfile' ? '#4ade80' : r.source === 'caller' ? '#a3e635' : '#fbbf24'}">${shared.escapeHtml(r.source || '(unset)')}</span></td>
                <td style="text-align:right">${r.count}</td>
                <td style="color:#64748b;font-size:11px">${shared.escapeHtml(hostLabel(r.sampleHost))} · ${shared.escapeHtml(r.sampleModel || '')}</td>
            </tr>`).join('');

        return `
            <div class="nc-card" style="margin-bottom:12px;padding:12px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <strong>num_ctx Drift <span class="nc-muted" style="font-weight:normal;font-size:11px;">(last ${windowMin} min)</span></strong>
                    <span style="color:${driftTone};font-size:12px;">
                        ${hasSamples ? `${pct.toFixed(1)}% drift` : '— drift · no measured calls'} · ${t.modelfile || 0} modelfile · ${t.caller || 0} caller · ${t.pinned || 0} pinned · ${t.resolved || 0} resolved${t.unknown ? ` · ${t.unknown} unknown` : ''}
                    </span>
                </div>
                ${rows ? `
                    <table class="nc-table" style="width:100%;font-size:12px;">
                        <thead><tr>
                            <th style="text-align:left">Caller</th>
                            <th style="text-align:left">num_ctx source</th>
                            <th style="text-align:right">Count</th>
                            <th style="text-align:left">Sample</th>
                        </tr></thead>
                        <tbody>${rows}</tbody>
                    </table>` : '<div class="nc-muted" style="font-size:12px;">No inference calls in window.</div>'}
                <div class="nc-muted" style="font-size:10.5px;margin-top:6px;">
                    Low drift % is good only when the window has measured calls. <span style="color:#4ade80">modelfile</span> = resident default. <span style="color:#a3e635">caller</span> = explicit benchmark/probe value. <span style="color:#7cf0ff">host_preference_pin</span> = intentional host policy. Other known values indicate resolver fallback; missing sources remain unknown.
                </div>
            </div>`;
    }

    function buildJudgeDriftPanel(jd) {
        if (!jd) return '';
        if (jd.unavailable) {
            const reason = jd.error || jd.reason || 'benchmark unreachable';
            return `
                <div class="nc-card" style="margin-bottom:12px;padding:12px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <strong>Judge Drift <span class="nc-muted" style="font-weight:normal;font-size:11px;">(per-category ρ vs baseline)</span></strong>
                        <span class="nc-muted" style="font-size:11px;">unavailable — ${shared.escapeHtml(reason)}</span>
                    </div>
                </div>`;
        }

        const overall = jd.overall_status || 'ok';
        const overallTone = overall === 'alert' ? '#f87171'
                          : overall === 'warning' ? '#fbbf24'
                          : '#4ade80';
        const baseline = jd.baseline_label || 'no baseline';
        const t = jd.thresholds || {};
        const thresholdText = `${Math.round((t.drop_pp || 0.15) * 100)}pp drop OR ρ<${t.absolute_floor ?? 0.5}`;

        const statusColor = s => (
            s === 'alert' ? '#f87171'
            : s === 'warning' ? '#fbbf24'
            : s === 'insufficient_data' || s === 'no_baseline' ? '#94a3b8'
            : '#4ade80'
        );

        const statusLabel = s => (
            s === 'alert' ? 'TRIPPED'
            : s === 'warning' ? 'WARNING'
            : s === 'ok' ? 'OK'
            : s === 'insufficient_data' ? 'insufficient'
            : s === 'no_baseline' ? 'no baseline'
            : s
        );

        const fmt = v => (v == null || Number.isNaN(v)) ? '—' : Number(v).toFixed(3);

        const rows = (jd.categories || []).map(c => {
            const tone = statusColor(c.status);
            const reasonsTxt = (c.reasons && c.reasons.length) ? c.reasons.join(', ') : '';
            const drop = c.drop_pp != null ? `${(c.drop_pp * 100).toFixed(1)}pp` : '—';
            return `
                <tr>
                    <td style="color:#cbd5e1">${shared.escapeHtml(c.category)}</td>
                    <td style="text-align:right;color:#cbd5e1">${fmt(c.current_rho)}</td>
                    <td style="text-align:right;color:#64748b">${fmt(c.baseline_rho)}</td>
                    <td style="text-align:right;color:${c.drop_pp > 0 ? '#fbbf24' : '#64748b'}">${drop}</td>
                    <td style="text-align:right;color:#64748b">${c.sample_size ?? 0}</td>
                    <td style="color:${tone};font-weight:600">${statusLabel(c.status)}</td>
                    <td style="color:#64748b;font-size:11px">${shared.escapeHtml(reasonsTxt)}</td>
                </tr>`;
        }).join('');

        return `
            <div class="nc-card" style="margin-bottom:12px;padding:12px;${overall === 'alert' ? 'border-left:3px solid #f87171;' : overall === 'warning' ? 'border-left:3px solid #fbbf24;' : ''}">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <strong>Judge Drift <span class="nc-muted" style="font-weight:normal;font-size:11px;">(per-category ρ vs baseline)</span></strong>
                    <span style="color:${overallTone};font-size:12px;">
                        overall <strong>${statusLabel(overall)}</strong>
                        <span class="nc-muted" style="margin-left:8px;">baseline: ${shared.escapeHtml(baseline)}</span>
                    </span>
                </div>
                ${rows ? `
                    <table class="nc-table" style="width:100%;font-size:12px;">
                        <thead><tr>
                            <th style="text-align:left">Category</th>
                            <th style="text-align:right">Current ρ</th>
                            <th style="text-align:right">Baseline ρ</th>
                            <th style="text-align:right">Drop</th>
                            <th style="text-align:right">n</th>
                            <th style="text-align:left">Status</th>
                            <th style="text-align:left">Reasons</th>
                        </tr></thead>
                        <tbody>${rows}</tbody>
                    </table>` : '<div class="nc-muted" style="font-size:12px;">No category data.</div>'}
                <div class="nc-muted" style="font-size:10.5px;margin-top:6px;">
                    Trips on ${shared.escapeHtml(thresholdText)}. Source: benchmark <code>/api/benchmark/drift</code> (0129 calibration loop).
                </div>
            </div>`;
    }

    function buildSummary(data) {
        const gate = data.gate || {};
        const claims = data.benchmarkClaims || [];
        const drift = data.drift || {};
        const parts = [];
        if (gate.totalInFlight != null) parts.push(`${gate.totalInFlight} in-flight`);
        if (gate.totalWaiters > 0) parts.push(`<span style="color:#fbbf24">${gate.totalWaiters} waiting</span>`);
        if (claims.length > 0) parts.push(`<span style="color:#fbbf24">${claims.length} benchmark claim${claims.length === 1 ? '' : 's'}</span>`);
        if (drift.driftPct != null) {
            const color = drift.driftPct > 10 ? '#f87171' : drift.driftPct > 2 ? '#fbbf24' : '#4ade80';
            parts.push(`<span style="color:${color}">${drift.driftPct.toFixed(1)}% drift</span>`);
        }
        const jd = data.judgeDrift;
        if (jd && !jd.unavailable && jd.overall_status) {
            const jdColor = jd.overall_status === 'alert' ? '#f87171'
                          : jd.overall_status === 'warning' ? '#fbbf24'
                          : '#4ade80';
            parts.push(`<span style="color:${jdColor}">judge ${jd.overall_status}</span>`);
        }
        return parts.join(' · ') || 'no activity';
    }

    let _refreshTimer = null;

    async function loadInferenceHealth() {
        const body = document.getElementById('sectionInferenceHealthBody');
        if (!body) return;
        shared.setSectionBusy(body, true);
        try {
            const resp = await shared.fetchJson('/api/nerve-center/inference-health');
            const data = resp.data || {};
            body.innerHTML =
                buildGatePanel(data.gate) +
                buildClaimsPanel(data.benchmarkClaims) +
                buildWatchdogPanel(data.watchdog) +
                buildDriftPanel(data.drift) +
                buildJudgeDriftPanel(data.judgeDrift);

            const summary = document.getElementById('nc-ih-summary');
            if (summary) summary.innerHTML = buildSummary(data);
        } catch (err) {
            shared.renderSectionError(body, `Failed to load inference health: ${err.message}`);
        } finally {
            shared.finishSectionLoad(body);
        }

        // Cheap auto-refresh: 30s ticker, guarded so collapsed sections don't
        // hammer the API. Idempotent — setInterval is kept in a single slot.
        if (!_refreshTimer) {
            _refreshTimer = setInterval(() => {
                const section = document.getElementById('sectionInferenceHealth');
                if (section && !section.classList.contains('collapsed')) {
                    loadInferenceHealth();
                }
            }, 30_000);
        }
    }

    window.NerveCenterInferenceHealth = { loadInferenceHealth };
})();
