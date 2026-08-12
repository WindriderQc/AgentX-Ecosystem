/**
 * DocJanitorPage — Docs sub-tab of the Janitor tab.
 *
 * Talks to the data service via core's data-proxy at /api/data/janitor/docs/*.
 * Read-only markdown classifier; no writes beyond the audit directory.
 */
(function () {
    const $ = (id) => document.getElementById(id);
    const esc = (s) => window.AgentXUtils.escapeHtml(String(s ?? ''));
    const toast = (msg, type = 'info') => window.AgentXUtils.showToast(msg, type);
    const fmtBytes = (b) => window.AgentXUtils.formatBytes(b || 0);

    const api = (path, opts) => DataCommons.apiFetch(`/api/data/janitor/docs${path}`, opts);

    const DEFAULT_TARGET = '/home/agentx/codes/agentx-platform';
    const PAGE_SIZE = 100;

    const state = {
        findings: null,
        files: [],
        visibleCount: PAGE_SIZE,
        loaded: false
    };

    function formatApiError(err) {
        const m = err && err.message && err.message.match(/^(\d+):\s*([\s\S]*)$/);
        if (!m) return err && err.message ? err.message : 'Unknown error';
        try {
            const body = JSON.parse(m[2]);
            if (body.message) return body.message;
            if (Array.isArray(body.errors)) return body.errors.join(' · ');
        } catch (_) { /* not JSON */ }
        return `${m[1]}: ${m[2]}`;
    }

    function targetInput() {
        const raw = ($('dj-target-input').value || '').trim();
        return raw || DEFAULT_TARGET;
    }

    function statusBadge(status) {
        const colors = { ok: '#10b981', warn: '#f59e0b', fail: '#ef4444' };
        return `<span style="color:${colors[status] || '#94a3b8'}; font-weight:600;">${esc(status || '—')}</span>`;
    }

    function severityBadge(sev) {
        const colors = { fail: '#ef4444', warn: '#f59e0b', info: '#60a5fa' };
        return `<span style="display:inline-block; padding:1px 6px; border-radius:3px; font-size:10px; text-transform:uppercase; color:#fff; background:${colors[sev] || '#64748b'};">${esc(sev)}</span>`;
    }

    function categoryBadge(cat) {
        const styles = {
            PERMANENT: 'color:#10b981; background:rgba(16,185,129,0.1); border:1px solid rgba(16,185,129,0.3);',
            TRANSIENT: 'color:#94a3b8; background:rgba(148,163,184,0.08); border:1px solid rgba(148,163,184,0.2);',
            UNKNOWN:   'color:#f59e0b; background:rgba(245,158,11,0.1); border:1px solid rgba(245,158,11,0.3);'
        };
        return `<span style="display:inline-block; padding:1px 8px; border-radius:3px; font-size:10px; font-weight:600; letter-spacing:0.04em; ${styles[cat] || ''}">${esc(cat)}</span>`;
    }

    function applyFindings(findings) {
        state.findings = findings;
        state.files = (findings && findings.files) || [];
        state.visibleCount = PAGE_SIZE;
        renderStats();
        renderObservations();
        renderRecommendations();
        renderFiles();
        const ts = findings && findings.scanned_at ? new Date(findings.scanned_at).toLocaleString() : '—';
        $('dj-last-scan').innerHTML = `<i class="fas fa-clock" style="margin-right:4px; opacity:0.6;"></i>Scanned: ${esc(ts)}`;
    }

    function renderStats() {
        const f = state.findings;
        if (!f) return;
        $('dj-stat-total').textContent = f.summary.total_md_files;
        $('dj-stat-permanent').textContent = f.summary.permanent;
        $('dj-stat-transient').textContent = f.summary.transient;
        $('dj-stat-unknown').textContent = f.summary.unknown;
        $('dj-stat-status').innerHTML = statusBadge(f.status);
    }

    function renderObservations() {
        const obs = (state.findings && state.findings.observations) || [];
        $('dj-obs-sub').textContent = obs.length ? `${obs.length}` : '';
        const el = $('dj-observations');
        if (!obs.length) {
            el.innerHTML = `<div style="text-align:center; color:var(--muted); padding:20px;">No observations.</div>`;
            return;
        }
        el.innerHTML = obs.map(o => `
            <div style="padding:10px; border:1px solid var(--border); border-radius:6px; margin-bottom:8px;">
              <div style="display:flex; gap:8px; align-items:center; margin-bottom:4px;">
                ${severityBadge(o.severity)}
                <strong style="font-size:12px;">${esc(o.type)}</strong>
              </div>
              <div style="font-size:12px; color:#cbd5e1;">${esc(o.message)}</div>
            </div>
        `).join('');
    }

    function renderRecommendations() {
        const recs = (state.findings && state.findings.recommendations) || [];
        $('dj-rec-sub').textContent = recs.length ? `${recs.length}` : '';
        const el = $('dj-recommendations');
        if (!recs.length) {
            el.innerHTML = `<div style="text-align:center; color:var(--muted); padding:20px;">No recommendations.</div>`;
            return;
        }
        el.innerHTML = recs.map((r, i) => {
            const actions = (r.actions || []).map(a => `<li>${esc(a)}</li>`).join('');
            const paths = (r.related_paths || []).slice(0, 5).map(p => `<code style="font-size:11px;">${esc(p)}</code>`).join(' ');
            const morePaths = (r.related_paths || []).length > 5 ? ` <span style="color:var(--muted); font-size:11px;">+${r.related_paths.length - 5} more</span>` : '';
            return `
            <div style="padding:12px; border:1px solid var(--border); border-radius:6px; margin-bottom:8px;">
              <div style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">
                ${severityBadge(r.severity)}
                <strong style="font-size:13px;">${i + 1}. ${esc(r.title)}</strong>
              </div>
              <div style="font-size:12px; color:#cbd5e1; margin-bottom:6px;">${esc(r.message)}</div>
              ${paths ? `<div style="margin-bottom:6px;">${paths}${morePaths}</div>` : ''}
              ${actions ? `<ul style="font-size:11px; color:#94a3b8; margin:4px 0 0 20px;">${actions}</ul>` : ''}
            </div>
            `;
        }).join('');
    }

    function getFilteredFiles() {
        const cat = $('dj-filter-category').value;
        const search = ($('dj-filter-search').value || '').toLowerCase().trim();
        return state.files.filter(f => {
            if (cat && f.category !== cat) return false;
            if (search && !f.path.toLowerCase().includes(search)) return false;
            return true;
        });
    }

    function renderFiles() {
        const filtered = getFilteredFiles();
        const shown = filtered.slice(0, state.visibleCount);
        $('dj-files-sub').textContent = filtered.length ? `${shown.length} of ${filtered.length}` : '';

        const tbody = $('dj-files-tbody');
        if (!filtered.length) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--muted); padding:20px;">No files match the current filter.</td></tr>`;
            $('dj-files-more').style.display = 'none';
            return;
        }

        tbody.innerHTML = shown.map(f => `
            <tr>
              <td>${categoryBadge(f.category)}</td>
              <td><code style="font-size:11px;">${esc(f.path)}</code></td>
              <td style="font-size:11px; color:#94a3b8;">${esc(f.reason)}</td>
              <td style="text-align:right; font-size:11px; color:#94a3b8;">${fmtBytes(f.size_bytes)}</td>
            </tr>
        `).join('');

        $('dj-files-more').style.display = filtered.length > state.visibleCount ? '' : 'none';
    }

    async function runScan() {
        const btn = $('dj-scan-btn');
        const originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Scanning…';
        try {
            const r = await api('/scan', {
                method: 'POST',
                body: JSON.stringify({ target_repo: targetInput() })
            });
            if (!r || r.status !== 'success') throw new Error(r?.message || 'Scan failed');
            applyFindings(r.data);
            toast(`Scan complete: ${r.data.summary.total_md_files} files, status ${r.data.status}`, 'success');
            state.loaded = true;
        } catch (err) {
            toast(`Scan failed: ${formatApiError(err)}`, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
    }

    async function loadLatest() {
        const btn = $('dj-latest-btn');
        const originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading…';
        try {
            const qs = `?target_repo=${encodeURIComponent(targetInput())}`;
            const r = await api(`/latest${qs}`);
            if (!r || r.status !== 'success') throw new Error(r?.message || 'Load failed');
            applyFindings(r.data.findings);
            toast(`Loaded latest: ${r.data.name}`, 'success');
            state.loaded = true;
        } catch (err) {
            const msg = formatApiError(err);
            if (/No prior/i.test(msg)) {
                toast('No prior audit found — run a scan first.', 'info');
            } else {
                toast(`Load failed: ${msg}`, 'error');
            }
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
    }

    function bindEvents() {
        $('dj-scan-btn').addEventListener('click', runScan);
        $('dj-latest-btn').addEventListener('click', loadLatest);
        $('dj-filter-category').addEventListener('change', () => { state.visibleCount = PAGE_SIZE; renderFiles(); });
        $('dj-filter-search').addEventListener('input', () => { state.visibleCount = PAGE_SIZE; renderFiles(); });
        $('dj-load-more-files').addEventListener('click', () => { state.visibleCount += PAGE_SIZE; renderFiles(); });
        $('dj-target-input').value = DEFAULT_TARGET;

        const docsBtn = document.querySelector('#tab-janitor .jn-subtab-btn[data-jn-subtab="docs"]');
        if (docsBtn) {
            docsBtn.addEventListener('click', () => {
                if (!state.loaded) loadLatest();
            });
        }
    }

    function init() {
        if (!document.getElementById('jn-subtab-docs')) return;
        bindEvents();
    }

    document.addEventListener('DOMContentLoaded', init);
    window.DocJanitorPage = { init, runScan, loadLatest };
})();
