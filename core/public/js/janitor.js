/**
 * JanitorPage — Disk Janitor command center UI logic
 * Talks to data service via core proxy at /api/data/*
 */
const JanitorPage = (() => {
    // ── State ───────────────────────────────────────────────
    let summaryData = null;
    let dedupReport = null;
    let policiesData = null;
    let treeData = null;
    let dupePageOffset = 0;
    const DUPES_PER_PAGE = 20;
    let cleanupSuggestions = [];
    let cleanupToken = null;
    let chatHistory = [];

    // ── Helpers ─────────────────────────────────────────────

    function $(id) { return document.getElementById(id); }

    const showToast = (msg, type = 'info') => window.AgentXUtils.showToast(msg, type);

    const api = DataCommons.apiFetch;

    const fmtBytes = (bytes) => window.AgentXUtils.formatBytes(bytes);

    const timeAgo = DataCommons.timeAgo;

    const escHtml = (s) => window.AgentXUtils.escapeHtml(s);

    const BAR_COLORS = ['#3b82f6', '#8b5cf6', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#6b7280'];

    // ── Health Metrics ──────────────────────────────────────

    function renderMetrics() {
        const s = summaryData || {};
        const d = s.duplicates || {};
        const c = s.duplicateCandidates || {};
        const limits = s.evidenceLimitations || {};
        const p = policiesData || [];

        $('jn-stat-files').innerHTML = `
            <div class="jn-stat-top">
                <div><div class="jn-stat-val">${s.totalFiles != null ? s.totalFiles.toLocaleString() : '--'}</div>
                <div class="jn-stat-label">Total Files</div></div>
            </div>`;

        const pct = s.totalSize && s.diskTotal ? Math.round(s.totalSize / s.diskTotal * 100) : null;
        $('jn-stat-size').innerHTML = `
            <div class="jn-stat-top">
                <div><div class="jn-stat-val">${s.totalSizeFormatted || fmtBytes(s.totalSize)}</div>
                <div class="jn-stat-label">Total Size</div></div>
                ${pct != null ? `<span class="jn-stat-tag" style="background:rgba(245,158,11,0.15);color:#f59e0b;">${pct}% used</span>` : ''}
            </div>`;

        $('jn-stat-dupes').innerHTML = `
            <div class="jn-stat-top">
                <div><div class="jn-stat-val" style="color:#ef4444;">${d.groups != null ? d.groups.toLocaleString() : '--'}</div>
                <div class="jn-stat-label">Verified SHA256 Groups</div></div>
                ${d.groups > 0 ? '<span class="jn-stat-tag" style="background:rgba(239,68,68,0.15);color:#ef4444;">Verified</span>' : ''}
            </div>
            <div class="jn-stat-sub">${d.groups ? 'Current-hash lower bound' : ''}</div>`;

        const savings = d.potentialSavings || 0;
        $('jn-stat-reclaimable').innerHTML = `
            <div class="jn-stat-top">
                <div><div class="jn-stat-val" style="color:#f59e0b;">${d.potentialSavingsFormatted || fmtBytes(savings)}</div>
                <div class="jn-stat-label">Proven Duplicate Savings</div></div>
            </div>
            <div class="jn-stat-sub">${savings > 0 ? `${((savings / (s.totalSize || 1)) * 100).toFixed(1)}% of total · review required` : ''}</div>`;

        const oversized = Number(limits.oversizedCandidateGroups || 0);
        if ($('jn-evidence-note')) {
            $('jn-evidence-note').textContent = [
                'Verified duplicate counts and proven savings are lower bounds.',
                `${Number(c.groups || 0).toLocaleString()} same-size groups remain candidates; candidate bytes are not savings.`,
                limits.note,
                oversized > 0
                    ? `${oversized.toLocaleString()} groups include individual unhashed files beyond the current per-run budget.`
                    : null,
                (s.scope || {}).note
            ].filter(Boolean).join(' ');
        }

        const activeCount = p.filter(x => x.enabled).length;
        $('jn-stat-policies').innerHTML = `
            <div class="jn-stat-top">
                <div><div class="jn-stat-val" style="color:#22c55e;">${activeCount} <span style="font-size:12px;color:var(--muted);">/ ${p.length}</span></div>
                <div class="jn-stat-label">Policies Active</div></div>
            </div>
            <div class="jn-stat-sub">${p.filter(x => x.enabled).map(x => x.name.replace(/^(Delete|Remove|Flag)\s+/i, '')).join(' \u00b7 ')}</div>`;

        const ls = s.lastScan;
        $('jn-last-scan').textContent = ls ? `Last scan: ${timeAgo(ls.started_at || ls.finished_at)}` : '';
    }

    // ── Storage Breakdown ───────────────────────────────────

    function renderBreakdown() {
        const dirs = treeData || [];
        if (dirs.length === 0) {
            $('jn-bar').innerHTML = '';
            $('jn-breakdown-tbody').innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:20px;">No directory data. Run a storage scan first.</td></tr>';
            return;
        }

        const totalSize = dirs.reduce((s, d) => s + (d.totalSize || 0), 0);
        $('jn-breakdown-info').textContent = `${dirs.length} directories \u00b7 ${fmtBytes(totalSize)} total`;

        $('jn-bar').innerHTML = dirs.slice(0, 7).map((d, i) => {
            const pct = totalSize > 0 ? Math.max((d.totalSize / totalSize) * 100, 3) : 0;
            const name = (d.path || '').split('/').filter(Boolean).pop() || d.path;
            return `<div class="jn-bar-seg" style="width:${pct}%;background:${BAR_COLORS[i % BAR_COLORS.length]};">${escHtml(name)}/ ${fmtBytes(d.totalSize)}</div>`;
        }).join('') + (dirs.length > 7 ? `<div class="jn-bar-seg" style="flex:1;background:#6b7280;">+${dirs.length - 7} more</div>` : '');

        $('jn-breakdown-tbody').innerHTML = dirs.map((d, i) => {
            const color = BAR_COLORS[i % BAR_COLORS.length];
            const pct = totalSize > 0 ? (d.totalSize / totalSize * 100) : 0;
            return `<tr style="cursor:pointer;">
                <td><span style="color:${color};">\u25a0</span></td>
                <td style="color:#fff;font-weight:500;">${escHtml(d.path)}</td>
                <td>${(d.fileCount || 0).toLocaleString()}</td>
                <td style="font-weight:600;color:#fff;">${fmtBytes(d.totalSize)}</td>
                <td style="color:${(d.duplicates || 0) > 0 ? '#ef4444' : 'var(--muted)'};">${d.duplicates || '-'}</td>
                <td><div class="jn-progress" style="width:100px;"><div class="jn-progress-fill" style="width:${pct}%;background:${color};"></div></div></td>
            </tr>`;
        }).join('');
    }

    // ── Duplicate Groups ────────────────────────────────────

    function renderDupes() {
        const groups = dedupReport ? (dedupReport.groups || []) : [];
        const summary = dedupReport ? (dedupReport.summary || {}) : {};

        $('jn-dupes-sub').textContent = groups.length > 0
            ? `${summary.total_duplicate_groups || groups.length} groups \u00b7 ${summary.total_duplicate_files || 0} redundant files`
            : '';

        if (groups.length === 0) {
            $('jn-dupes-tbody').innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:20px;">No duplicates found. Run a dedup scan.</td></tr>';
            $('jn-dupes-more').style.display = 'none';
            return;
        }

        const page = groups.slice(0, dupePageOffset + DUPES_PER_PAGE);
        $('jn-dupes-tbody').innerHTML = page.map((g, idx) => {
            const sample = (g.files && g.files[0]) || {};
            const samplePath = sample.path || sample.filename || g.hash || '';
            const dir = samplePath.split('/').slice(0, -1).join('/') || '';
            const fname = samplePath.split('/').pop() || samplePath;

            return `<tr style="cursor:pointer;" onclick="JanitorPage._toggleDupe(${idx})">
                <td>
                    <span style="color:var(--muted);margin-right:4px;" id="jn-dupe-arrow-${idx}">\u25b6</span>
                    <span style="color:var(--text);">${escHtml(fname)}</span><br>
                    <span style="color:var(--muted);font-size:10px;">${escHtml(dir)}</span>
                </td>
                <td style="color:#ef4444;font-weight:700;">${g.count || g.files?.length || 0}</td>
                <td>${fmtBytes(g.file_size || g.size || sample.size)}</td>
                <td style="color:#f59e0b;font-weight:600;">${fmtBytes(g.wasted_space || g.wasted)}</td>
                <td>
                    <button class="jn-btn jn-btn-ai" style="padding:2px 6px;font-size:9px;" onclick="event.stopPropagation();JanitorPage._aiResolveDupe(${idx})"><i class="fas fa-sparkles"></i> AI</button>
                </td>
            </tr>
            <tr><td colspan="5" style="padding:0;"><div class="jn-expand" id="jn-dupe-detail-${idx}"></div></td></tr>`;
        }).join('');

        $('jn-dupes-more').style.display = page.length < groups.length ? 'block' : 'none';
    }

    function _toggleDupe(idx) {
        const el = $(`jn-dupe-detail-${idx}`);
        const arrow = $(`jn-dupe-arrow-${idx}`);
        if (!el) return;
        const open = el.classList.toggle('open');
        if (arrow) arrow.innerHTML = open ? '\u25bc' : '\u25b6';
        if (open && !el.dataset.loaded) {
            el.dataset.loaded = '1';
            _renderDupeDetail(idx);
        }
    }

    function _renderDupeDetail(idx) {
        const groups = dedupReport ? (dedupReport.groups || []) : [];
        const g = groups[idx];
        if (!g || !g.files) return;

        const el = $(`jn-dupe-detail-${idx}`);
        // mtime is epoch SECONDS (nas_files convention); sort numerically, keep oldest first.
        const sorted = [...g.files].sort((a, b) => (a.mtime || 0) - (b.mtime || 0));

        el.innerHTML = sorted.map((f, i) => {
            const isKeep = i === 0;
            return `<div class="jn-file-row ${isKeep ? 'jn-file-keep' : 'jn-file-delete'}">
                ${isKeep
                    ? '<span style="color:#22c55e;font-weight:700;min-width:40px;">KEEP</span>'
                    : '<span style="color:#ef4444;font-weight:700;min-width:40px;">DUP</span>'}
                <span style="color:var(--text);flex:1;font-family:monospace;font-size:10px;">${escHtml(f.path)}</span>
                <span style="color:var(--muted);font-size:10px;">${f.mtime ? new Date(f.mtime * 1000).toLocaleDateString() : ''} \u00b7 ${isKeep ? 'oldest' : 'copy'}</span>
            </div>`;
        }).join('') + `<div class="jn-file-row jn-file-ai" id="jn-dupe-ai-${idx}" style="display:none;">
            <span style="color:#a78bfa;">\u2728</span>
            <span style="color:#a78bfa;font-size:10px;line-height:1.4;" id="jn-dupe-ai-text-${idx}"></span>
        </div>`;
    }

    async function _aiResolveDupe(idx) {
        const groups = dedupReport ? (dedupReport.groups || []) : [];
        const g = groups[idx];
        if (!g || !g.files) return;

        const el = $(`jn-dupe-detail-${idx}`);
        if (!el.classList.contains('open')) _toggleDupe(idx);

        const aiEl = $(`jn-dupe-ai-${idx}`);
        const aiText = $(`jn-dupe-ai-text-${idx}`);
        if (aiEl) aiEl.style.display = 'flex';
        if (aiText) aiText.textContent = 'Thinking...';

        try {
            const json = await api('/janitor/ai', {
                method: 'POST',
                body: JSON.stringify({
                    action: 'resolve_duplicates',
                    context: { duplicates: g.files }
                })
            });
            const result = json.data?.result || {};
            if (aiText) aiText.textContent = `AI: ${result.reason || result.text || JSON.stringify(result)}`;
        } catch (err) {
            if (aiText) aiText.textContent = 'AI unavailable \u2014 the model router / Ollama may be offline.';
        }
    }

    // ── Cleanup Suggestions ─────────────────────────────────

    async function loadCleanup(scanPath) {
        const body = scanPath ? { path: scanPath } : { path: '/mnt/datalake/' };
        try {
            const json = await api('/janitor/suggest', { method: 'POST', body: JSON.stringify(body) });
            const data = json.data || {};
            cleanupSuggestions = data.suggestions || [];
            cleanupToken = data.confirmation_token || null;
            renderCleanup();
        } catch (err) {
            console.warn('loadCleanup:', err);
            cleanupSuggestions = [];
            renderCleanup();
        }
    }

    function renderCleanup() {
        const total = cleanupSuggestions.reduce((s, x) => s + (x.space_saved || 0), 0);
        $('jn-cleanup-sub').textContent = cleanupSuggestions.length > 0
            ? `${cleanupSuggestions.length} actionable \u00b7 ${fmtBytes(total)} reclaimable`
            : '';

        if (cleanupSuggestions.length === 0) {
            $('jn-cleanup-list').innerHTML = '<div style="text-align:center;color:var(--muted);padding:20px;">No suggestions yet. Run an analysis first.</div>';
            return;
        }

        $('jn-cleanup-list').innerHTML = cleanupSuggestions.map((s, i) => {
            const isDelete = s.action === 'delete';
            const badgeClass = isDelete ? 'jn-badge-delete' : 'jn-badge-review';
            const label = isDelete ? 'DELETE' : 'REVIEW';
            const fileDisplay = s.files.length === 1 ? escHtml(s.files[0]) : `${s.files.length} files`;

            return `<div class="jn-sug-row">
                <input type="checkbox" ${isDelete ? 'checked' : ''} data-sug-idx="${i}" class="jn-sug-check" style="accent-color:${isDelete ? '#22c55e' : '#f59e0b'};">
                <span class="jn-badge ${badgeClass}">${label}</span>
                <span style="flex:1;color:var(--text);">${fileDisplay}${s.reason ? ` <span style="color:var(--muted);">\u2014 ${escHtml(s.reason)}</span>` : ''}</span>
                <span style="color:#f59e0b;font-weight:600;min-width:60px;">${fmtBytes(s.space_saved)}</span>
                <span style="padding:2px 8px;background:rgba(255,255,255,0.05);border-radius:4px;color:var(--muted);font-size:10px;">${escHtml(s.policy)}</span>
            </div>`;
        }).join('');
    }

    function getCheckedCleanupFiles() {
        const checks = document.querySelectorAll('.jn-sug-check:checked');
        const files = [];
        checks.forEach(cb => {
            const idx = parseInt(cb.dataset.sugIdx);
            const sug = cleanupSuggestions[idx];
            if (sug) files.push(...sug.files);
        });
        return files;
    }

    async function executeCleanup(dryRun) {
        const files = getCheckedCleanupFiles();
        if (files.length === 0) return showToast('No files selected.', 'error');
        if (!cleanupToken) return showToast('No confirmation token. Re-run suggestions first.', 'error');

        if (!dryRun) {
            $('jn-modal-content').innerHTML = `
                <h3 style="color:#fff;margin:0 0 12px;">Confirm Deletion</h3>
                <p style="color:var(--muted);font-size:13px;">This will permanently delete <strong style="color:#ef4444;">${files.length} files</strong>.</p>
                <p style="color:var(--muted);font-size:12px;margin-top:8px;">This cannot be undone.</p>
                <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px;">
                    <button class="jn-btn jn-btn-ghost" onclick="document.getElementById('jn-modal').classList.remove('open')">Cancel</button>
                    <button class="jn-btn jn-btn-danger" onclick="JanitorPage._confirmDelete()"><i class="fas fa-trash"></i> Delete ${files.length} files</button>
                </div>`;
            $('jn-modal').classList.add('open');
            return;
        }

        try {
            showToast('Running dry run...', 'info');
            const json = await api('/janitor/execute', {
                method: 'POST',
                body: JSON.stringify({ files, confirmation_token: cleanupToken, dry_run: dryRun })
            });
            const r = json.data || {};
            showToast(`Dry run: would delete ${r.deleted?.length || 0} files, free ${fmtBytes(r.space_freed || 0)}`, 'success');
        } catch (err) { showToast('Cleanup failed: ' + err.message, 'error'); }
    }

    async function _confirmDelete() {
        $('jn-modal').classList.remove('open');
        const files = getCheckedCleanupFiles();
        try {
            showToast('Deleting files...', 'info');
            const json = await api('/janitor/execute', {
                method: 'POST',
                body: JSON.stringify({ files, confirmation_token: cleanupToken, dry_run: false })
            });
            const r = json.data || {};
            showToast(`Deleted ${r.deleted?.length || 0} files, freed ${fmtBytes(r.space_freed || 0)}`, 'success');
            loadSummary();
            loadDedupReport();
        } catch (err) { showToast('Delete failed: ' + err.message, 'error'); }
    }

    // ── AI Triage ───────────────────────────────────────────

    async function runTriage() {
        $('jn-triage-grid').innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;color:#a78bfa;"><i class="fas fa-spinner fa-spin"></i> AI is analyzing your storage...</div>';
        $('jn-triage-sub').textContent = '';

        try {
            const context = {
                files: (treeData || []).map(d => ({
                    path: d.path, size: d.totalSize, fileCount: d.fileCount
                })),
                stats: summaryData || {}
            };

            const json = await api('/janitor/ai', {
                method: 'POST',
                body: JSON.stringify({ action: 'triage', context })
            });

            const result = json.data?.result || {};
            const categories = result.categories || [];

            if (categories.length === 0 && result.text) {
                $('jn-triage-grid').innerHTML = `<div style="grid-column:1/-1;padding:14px;color:var(--text);font-size:12px;line-height:1.5;">${escHtml(result.text)}</div>`;
                return;
            }

            const classMap = { KEEP: 'keep', ARCHIVE: 'archive', JUNK: 'junk' };
            const colorMap = { KEEP: '#22c55e', ARCHIVE: '#f59e0b', JUNK: '#ef4444' };

            $('jn-triage-grid').innerHTML = categories.map(c => {
                const cls = classMap[c.label] || '';
                const color = colorMap[c.label] || 'var(--muted)';
                return `<div class="jn-triage-card ${cls}">
                    <div class="jn-triage-head">
                        <span style="color:${color};font-weight:700;">${escHtml(c.label)}</span>
                        <span style="color:var(--muted);font-size:10px;">${c.files_count || 0} files \u00b7 ${fmtBytes(c.total_size || 0)}</span>
                    </div>
                    <div style="color:var(--muted);line-height:1.5;">${escHtml(c.reason)}</div>
                </div>`;
            }).join('');

            $('jn-triage-sub').textContent = `${categories.length} categories \u00b7 ${json.data?.duration_ms || 0}ms`;
        } catch (err) {
            $('jn-triage-grid').innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:20px;color:#ef4444;">AI unavailable \u2014 ${escHtml(err.message)}</div>`;
        }
    }

    // ── AI Chat ─────────────────────────────────────────────

    function appendChatMsg(role, text) {
        const body = $('jn-ai-body');
        if (!body) return;
        const div = document.createElement('div');
        div.className = `jn-ai-msg ${role}`;
        div.textContent = text;
        body.appendChild(div);
        body.scrollTop = body.scrollHeight;
    }

    async function sendChat() {
        const input = $('jn-ai-input');
        const msg = (input?.value || '').trim();
        if (!msg) return;
        input.value = '';

        appendChatMsg('user', msg);
        chatHistory.push({ role: 'user', content: msg });

        const typingId = 'jn-ai-typing';
        const body = $('jn-ai-body');
        const typing = document.createElement('div');
        typing.id = typingId;
        typing.className = 'jn-ai-msg assistant';
        typing.style.opacity = '0.6';
        typing.textContent = 'Thinking...';
        body.appendChild(typing);
        body.scrollTop = body.scrollHeight;

        try {
            const json = await api('/janitor/ai', {
                method: 'POST',
                body: JSON.stringify({
                    action: 'chat',
                    context: {
                        message: msg,
                        stats: summaryData || {},
                        recentTriage: treeData ? treeData.slice(0, 10) : []
                    }
                })
            });

            const result = json.data?.result || {};
            const reply = result.text || result.reason || JSON.stringify(result);

            typing.remove();
            appendChatMsg('assistant', reply);
            chatHistory.push({ role: 'assistant', content: reply });
        } catch (err) {
            typing.remove();
            appendChatMsg('assistant', 'AI unavailable \u2014 the model router / Ollama may be offline.');
        }
    }

    function toggleAiPanel() {
        $('jn-ai-panel')?.classList.toggle('collapsed');
    }

    // ── Data Loading ────────────────────────────────────────

    async function loadSummary() {
        try {
            const json = await api('/storage/summary');
            summaryData = json.data || json;
            renderMetrics();
        } catch (err) { console.warn('loadSummary:', err); }
    }

    async function loadTree() {
        try {
            const json = await api('/storage/files/tree');
            treeData = (json.data && json.data.tree) || json.data || [];
            renderBreakdown();
        } catch (err) {
            console.warn('loadTree:', err);
            treeData = [];
            renderBreakdown();
        }
    }

    async function loadPolicies() {
        try {
            const json = await api('/janitor/policies');
            policiesData = (json.data && json.data.policies) || [];
            renderMetrics();
        } catch (err) { console.warn('loadPolicies:', err); }
    }

    async function loadDedupReport() {
        try {
            const json = await api('/janitor/dedup-report');
            dedupReport = json.data || null;
            renderMetrics();
            renderDupes();
        } catch (err) {
            if (!String(err).includes('404')) console.warn('loadDedupReport:', err);
            dedupReport = null;
            renderDupes();
        }
    }

    // ── Button Wiring ───────────────────────────────────────

    function wireButtons() {
        $('jn-load-more-dupes')?.addEventListener('click', () => {
            dupePageOffset += DUPES_PER_PAGE;
            renderDupes();
        });

        $('jn-dedup-btn')?.addEventListener('click', async () => {
            try {
                showToast('Starting dedup scan...', 'info');
                await api('/janitor/dedup-scan', { method: 'POST', body: '{}' });
                showToast('Dedup scan started!', 'success');
                setTimeout(loadDedupReport, 3000);
            } catch (err) { showToast('Dedup scan failed: ' + err.message, 'error'); }
        });

        $('jn-preview-cleanup')?.addEventListener('click', () => executeCleanup(true));
        $('jn-apply-cleanup')?.addEventListener('click', () => executeCleanup(false));

        $('jn-analyze-btn')?.addEventListener('click', () => {
            const path = prompt('Enter directory path to analyze:', '/mnt/datalake/');
            if (path) loadCleanup(path);
        });

        $('jn-run-triage')?.addEventListener('click', runTriage);
        $('jn-ai-toggle')?.addEventListener('click', toggleAiPanel);
        $('jn-ai-send')?.addEventListener('click', sendChat);
        $('jn-ai-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
    }

    // ── Init ────────────────────────────────────────────────

    function init() {
        loadSummary();
        loadTree();
        loadPolicies();
        loadDedupReport();
        // Cleanup suggestions trigger a live recursive walk + SHA256 hashing, so
        // they run only on explicit "Analyze Directory" — not on page load.
        renderCleanup();
        wireButtons();

        setInterval(() => {
            if (!document.hidden) { loadSummary(); loadDedupReport(); }
        }, 30000);
    }

    return { init, _toggleDupe, _aiResolveDupe, _confirmDelete };
})();
