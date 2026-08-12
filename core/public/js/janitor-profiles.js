/**
 * JanitorProfilesPage — Profiles + Runs sub-tabs of the Janitor tab.
 *
 * Talks to data service via core's data-proxy at /api/data/janitor/profiles/*.
 * Helpers: DataCommons.apiFetch, window.AgentXUtils.{showToast,formatBytes,escapeHtml}.
 */
(function () {
    const $ = (id) => document.getElementById(id);
    const api = (path, opts) => DataCommons.apiFetch(`/api/data/janitor/profiles${path}`, opts);
    const toast = (msg, type = 'info') => window.AgentXUtils.showToast(msg, type);
    const esc = (s) => window.AgentXUtils.escapeHtml(String(s ?? ''));
    const fmtBytes = (b) => window.AgentXUtils.formatBytes(b || 0);

    // DataCommons.apiFetch throws Error("<status>: <body>") on non-2xx.
    // The body is usually { status:'error', errors:[...] } or { status:'error', message:'...' }.
    // Pull the human-readable bits out for the toast so users see "root \"/foo\": Blocked by safety policy"
    // instead of "400: {"status":"error","errors":["root \"/foo\": ..."]}".
    function formatApiError(err) {
        const m = err && err.message && err.message.match(/^(\d+):\s*([\s\S]*)$/);
        if (!m) return err && err.message ? err.message : 'Unknown error';
        try {
            const body = JSON.parse(m[2]);
            if (Array.isArray(body.errors) && body.errors.length) return body.errors.join(' · ');
            if (body.message) return body.message;
        } catch (_) { /* not JSON, fall through */ }
        return `${m[1]}: ${m[2]}`;
    }

    // ── State ───────────────────────────────────────────────
    let profiles = [];
    let editingId = null;
    let runsCache = [];
    let currentRunDetail = null;

    // ── Sub-tab switching ───────────────────────────────────

    function switchSubtab(name) {
        document.querySelectorAll('#tab-janitor .jn-subtab-panel').forEach(el => el.style.display = 'none');
        document.querySelectorAll('#tab-janitor .jn-subtab-btn').forEach(el => el.classList.remove('jn-subtab-active'));

        const panel = $(`jn-subtab-${name}`);
        if (panel) panel.style.display = '';
        const btn = document.querySelector(`#tab-janitor .jn-subtab-btn[data-jn-subtab="${name}"]`);
        if (btn) btn.classList.add('jn-subtab-active');

        if (name === 'profiles') loadProfiles();
        if (name === 'runs') populateRunsProfileFilter();
    }

    // ── Profiles list & editor ──────────────────────────────

    async function loadProfiles() {
        try {
            const r = await api('/');
            profiles = r?.data?.profiles || [];
            renderProfilesTable();
        } catch (err) {
            toast(`Load profiles failed: ${formatApiError(err)}`, 'error');
        }
    }

    function renderProfilesTable() {
        const tbody = $('jnp-profiles-tbody');
        if (!profiles.length) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--muted); padding:20px;">No profiles yet. Click "New Profile" to create one.</td></tr>';
            return;
        }
        tbody.innerHTML = profiles.map(p => `
            <tr>
                <td>${esc(p.name)}</td>
                <td><code>${esc((p.roots || []).join(', '))}</code></td>
                <td>${esc((p.policies || []).join(', '))}</td>
                <td>${p.schedule?.enabled ? `every ${esc(p.schedule.intervalMinutes)}m` : '<span style="color:var(--muted);">manual</span>'}</td>
                <td>${p.aiTriage ? '<i class="fas fa-sparkles" style="color:#a78bfa;"></i>' : '—'}</td>
                <td>
                    <button class="jn-btn jn-btn-ghost" data-jnp-action="run" data-id="${esc(p._id)}"><i class="fas fa-play"></i></button>
                    <button class="jn-btn jn-btn-ghost" data-jnp-action="edit" data-id="${esc(p._id)}"><i class="fas fa-pen"></i></button>
                    <button class="jn-btn jn-btn-ghost" data-jnp-action="delete" data-id="${esc(p._id)}"><i class="fas fa-trash"></i></button>
                </td>
            </tr>
        `).join('');
    }

    function openEditor(profile) {
        editingId = profile?._id || null;
        $('jnp-editor-title').textContent = profile ? `Edit: ${profile.name}` : 'New Profile';
        $('jnp-name').value = profile?.name || '';
        $('jnp-roots').value = (profile?.roots || []).join('\n');
        $('jnp-ext-include').value = (profile?.extensions?.include || []).join(', ');
        $('jnp-ext-exclude').value = (profile?.extensions?.exclude || []).join(', ');
        const sel = $('jnp-policies');
        Array.from(sel.options).forEach(opt => opt.selected = (profile?.policies || []).includes(opt.value));
        $('jnp-sched-enabled').checked = !!profile?.schedule?.enabled;
        $('jnp-sched-mins').value = profile?.schedule?.intervalMinutes || '';
        $('jnp-compute-hashes').checked = profile?.computeHashes !== false;
        $('jnp-ai-triage').checked = !!profile?.aiTriage;
        $('jnp-editor-panel').style.display = '';
    }

    function closeEditor() {
        editingId = null;
        $('jnp-editor-panel').style.display = 'none';
    }

    function readEditor() {
        const splitCsv = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
        const splitLines = (s) => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
        const sel = $('jnp-policies');
        const policies = Array.from(sel.options).filter(o => o.selected).map(o => o.value);
        const enabled = $('jnp-sched-enabled').checked;
        const mins = parseInt($('jnp-sched-mins').value, 10);
        return {
            name: $('jnp-name').value.trim(),
            roots: splitLines($('jnp-roots').value),
            extensions: { include: splitCsv($('jnp-ext-include').value), exclude: splitCsv($('jnp-ext-exclude').value) },
            policies,
            schedule: enabled ? { enabled: true, intervalMinutes: Number.isFinite(mins) ? mins : null } : null,
            computeHashes: $('jnp-compute-hashes').checked,
            aiTriage: $('jnp-ai-triage').checked
        };
    }

    async function saveProfile() {
        const body = readEditor();
        try {
            const path = editingId ? `/${editingId}` : '/';
            const method = editingId ? 'PUT' : 'POST';
            await api(path, { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
            toast(`Profile ${editingId ? 'updated' : 'created'}`, 'success');
            closeEditor();
            await loadProfiles();
        } catch (err) {
            toast(`Save failed: ${formatApiError(err)}`, 'error');
        }
    }

    async function deleteProfile(id) {
        const profile = profiles.find(p => String(p._id) === String(id));
        if (!profile) return;
        if (!confirm(`Delete profile "${profile.name}"? Run history is preserved.`)) return;
        try {
            await api(`/${id}`, { method: 'DELETE' });
            toast('Profile deleted', 'success');
            await loadProfiles();
        } catch (err) {
            toast(`Delete failed: ${formatApiError(err)}`, 'error');
        }
    }

    async function runProfile(id) {
        const profile = profiles.find(p => String(p._id) === String(id));
        if (!profile) return;
        try {
            const r = await api(`/${id}/run`, { method: 'POST' });
            toast(`Run started: ${r?.data?.run_id || 'ok'}`, 'success');
        } catch (err) {
            toast(`Run failed: ${formatApiError(err)}`, 'error');
        }
    }

    // ── Runs list & detail ──────────────────────────────────

    function populateRunsProfileFilter() {
        if (!profiles.length) {
            // Lazy-load profiles if the user jumped straight to Runs.
            // Only recurse if profiles actually arrived — guards against an
            // infinite loop when zero profiles exist.
            loadProfiles().then(() => {
                if (profiles.length) populateRunsProfileFilter();
                else renderEmptyRunsFilter();
            });
            return;
        }
        const sel = $('jnp-runs-profile-filter');
        const current = sel.value;
        sel.innerHTML = '<option value="">Pick a profile…</option>' +
            profiles.map(p => `<option value="${esc(p._id)}">${esc(p.name)}</option>`).join('');
        sel.value = current;
        if (sel.value) loadRuns(sel.value);
    }

    function renderEmptyRunsFilter() {
        const sel = $('jnp-runs-profile-filter');
        if (sel) sel.innerHTML = '<option value="">No profiles yet — create one in the Profiles tab</option>';
        const tbody = $('jnp-runs-tbody');
        if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--muted); padding:20px;">No profiles yet</td></tr>';
    }

    async function loadRuns(profileId) {
        if (!profileId) {
            $('jnp-runs-tbody').innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--muted); padding:20px;">Pick a profile</td></tr>';
            return;
        }
        try {
            const r = await api(`/${profileId}/runs?limit=20`);
            runsCache = r?.data?.runs || [];
            renderRunsTable();
        } catch (err) {
            toast(`Load runs failed: ${formatApiError(err)}`, 'error');
        }
    }

    function renderRunsTable() {
        const tbody = $('jnp-runs-tbody');
        if (!runsCache.length) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--muted); padding:20px;">No runs yet</td></tr>';
            return;
        }
        tbody.innerHTML = runsCache.map(run => {
            const dur = run.finished_at && run.started_at
                ? Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 1000) + 's'
                : '—';
            const actCount = (run.proposed_actions || []).length;
            const pendingCount = (run.proposed_actions || []).filter(a => a.status === 'pending').length;
            return `
                <tr>
                    <td>${esc(run.profile_name)}</td>
                    <td>${esc(new Date(run.started_at).toLocaleString())}</td>
                    <td>${dur}</td>
                    <td><span class="jn-stat-tag">${esc(run.status)}</span></td>
                    <td>${actCount} (${pendingCount} pending)</td>
                    <td><button class="jn-btn jn-btn-ghost" data-jnp-action="open-run" data-id="${esc(run._id)}">Open</button></td>
                </tr>
            `;
        }).join('');
    }

    async function openRunDetail(runId) {
        try {
            const r = await api(`/runs/${runId}`);
            currentRunDetail = r?.data?.run;
            renderRunDetail();
            $('jnp-run-detail-panel').style.display = '';
        } catch (err) {
            toast(`Load run failed: ${formatApiError(err)}`, 'error');
        }
    }

    function activePreview(action) {
        const preview = action?.approval_preview;
        const restore = preview?.restore_source;
        if (
            !preview
            || preview.status !== 'ready'
            || !preview.id
            || !restore?.file
            || !restore?.sha256
            || restore.sha256 !== preview.sha256
        ) return null;
        const expiresAt = new Date(preview.expires_at).getTime();
        return Number.isFinite(expiresAt) && expiresAt > Date.now() ? preview : null;
    }

    function restoreSourceBlock(preview) {
        const source = preview?.restore_source;
        if (!source) return '';
        const verifiedAt = new Date(source.verified_at || preview.verified_at).toLocaleString();
        return `<div style="font-size:10px; color:var(--muted); margin:4px 0; max-width:360px; overflow-wrap:anywhere;">
            Verified restore source: <code>${esc(source.file)}</code><br>
            Complete SHA-256: <code>${esc(source.sha256)}</code><br>
            Verified: ${esc(verifiedAt)}
        </div>`;
    }

    function actionControls(action, runId, idx) {
        if (action.status !== 'pending') return '';
        const preview = activePreview(action);
        const applyAvailable = preview?.live_apply_available === true;
        return `
            <button class="jn-btn jn-btn-success" data-jnp-action="preview" data-run="${esc(runId)}" data-idx="${idx}">${preview ? 'Refresh preview' : 'Preview'}</button>
            ${preview ? `
                ${restoreSourceBlock(preview)}
                <button class="jn-btn jn-btn-warn" data-jnp-action="apply" data-run="${esc(runId)}" data-idx="${idx}"
                    ${applyAvailable ? '' : 'disabled title="Live maintenance is not commissioned"'}>Apply approved action</button>
                ${applyAvailable ? '' : '<div style="font-size:10px; color:var(--muted); margin-top:4px;">Apply unavailable: live maintenance is not commissioned.</div>'}
            ` : ''}
            <button class="jn-btn jn-btn-ghost" data-jnp-action="reject" data-run="${esc(runId)}" data-idx="${idx}">Reject</button>
        `;
    }

    function renderRunDetail() {
        const run = currentRunDetail;
        if (!run) return;
        $('jnp-run-detail-sub').textContent = `${run.profile_name} · ${new Date(run.started_at).toLocaleString()}`;

        const aiBlock = run.ai_triage
            ? (run.ai_triage.error
                ? `<div style="color:#ef4444; font-size:12px;">AI triage error: ${esc(run.ai_triage.error)}</div>`
                : `<div style="font-size:12px; color:var(--muted);">AI verdict (${esc(run.ai_triage.model || 'unknown')}, ${esc(run.ai_triage.duration_ms)}ms)</div><pre style="font-size:11px; background:#0a0a0a; padding:8px; overflow:auto; max-height:200px;">${esc(JSON.stringify(run.ai_triage.verdict, null, 2))}</pre>`)
            : '<div style="color:var(--muted); font-size:12px;">No AI triage</div>';

        const dedupBlock = run.dedup_error
            ? `<div style="color:#f59e0b; font-size:12px;">Dedup error: ${esc(run.dedup_error)}</div>`
            : run.dedup_report_id
                ? `<div style="font-size:12px; color:var(--muted);">Dedup report: <code>${esc(run.dedup_report_id)}</code></div>`
                : '';

        const actions = run.proposed_actions || [];
        const actionsBlock = actions.length === 0
            ? '<div style="color:var(--muted); font-size:12px;">No proposed actions</div>'
            : `<table class="jn-table" style="margin-top:8px;">
                <thead><tr><th>#</th><th>Policy</th><th>Files</th><th>Reason</th><th>Saves</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>${actions.map((a, i) => `
                    <tr>
                        <td>${i}</td>
                        <td>${esc(a.policy)}</td>
                        <td title="${esc(a.files.join('\n'))}">${a.files.length}</td>
                        <td><span style="font-size:11px;">${esc(a.reason)}</span></td>
                        <td>${esc(fmtBytes(a.space_saved))}</td>
                        <td><span class="jn-stat-tag">${esc(a.status)}</span></td>
                        <td>
                            ${actionControls(a, run._id, i)}
                        </td>
                    </tr>
                `).join('')}</tbody>
            </table>`;

        $('jnp-run-detail-body').innerHTML = `
            <div style="font-size:12px; color:var(--muted); margin-bottom:8px;">
                Status: <strong>${esc(run.status)}</strong>
                · Files seen: ${run.counts?.files_seen ?? 0}
                · Hashed: ${run.counts?.hashed ?? 0}
                ${run.error ? `<div style="color:#ef4444;">Error: ${esc(run.error)}</div>` : ''}
            </div>
            ${dedupBlock}
            ${aiBlock}
            <h4 style="margin-top:12px;">Proposed Actions</h4>
            ${actionsBlock}
        `;
    }

    async function previewAction(runId, idx) {
        try {
            await api(`/runs/${runId}/actions/${idx}/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirm: true, dry_run: true })
            });
            toast('Dry-run preview recorded; no files were changed', 'success');
            await openRunDetail(runId); // refresh
        } catch (err) {
            toast(`Preview failed: ${formatApiError(err)}`, 'error');
        }
    }

    async function applyAction(runId, idx) {
        const action = currentRunDetail?.proposed_actions?.[idx];
        const preview = activePreview(action);
        if (!preview) {
            toast('Apply blocked: generate a current preview first', 'error');
            return;
        }
        const count = action.files?.length || 0;
        const restore = preview.restore_source;
        if (!confirm(`Permanently delete the ${count} file(s) in preview ${preview.id}?\n\nVerified survivor and restore source:\n${restore.file}\nSHA-256: ${restore.sha256}\n\nThis cannot be undone.`)) return;
        try {
            const response = await api(`/runs/${runId}/actions/${idx}/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    confirm: true,
                    dry_run: false,
                    preview_id: preview.id,
                    apply_confirm: 'DELETE_APPROVED_FILES',
                    restore_confirm: 'VERIFIED_SURVIVOR_IS_RESTORE_SOURCE'
                })
            });
            const status = response?.data?.action?.status;
            if (status === 'executed') toast('Approved action executed and recorded', 'success');
            else toast(`Apply finished with status: ${status || 'unknown'}; review the recorded result`, 'warn');
            await openRunDetail(runId);
        } catch (err) {
            toast(`Apply failed: ${formatApiError(err)}`, 'error');
        }
    }

    async function rejectAction(runId, idx) {
        try {
            await api(`/runs/${runId}/actions/${idx}/reject`, { method: 'POST' });
            toast('Action rejected', 'success');
            await openRunDetail(runId);
        } catch (err) {
            toast(`Reject failed: ${formatApiError(err)}`, 'error');
        }
    }

    // ── Event wiring ────────────────────────────────────────

    function bind() {
        // Sub-tab buttons
        document.querySelectorAll('#tab-janitor .jn-subtab-btn').forEach(btn => {
            btn.addEventListener('click', () => switchSubtab(btn.dataset.jnSubtab));
        });

        // Profiles
        $('jnp-new-btn')?.addEventListener('click', () => openEditor(null));
        $('jnp-editor-cancel')?.addEventListener('click', closeEditor);
        $('jnp-editor-save')?.addEventListener('click', saveProfile);

        // Profiles table delegation
        $('jnp-profiles-tbody')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-jnp-action]');
            if (!btn) return;
            const id = btn.dataset.id;
            const action = btn.dataset.jnpAction;
            if (action === 'run') runProfile(id);
            else if (action === 'edit') openEditor(profiles.find(p => String(p._id) === String(id)));
            else if (action === 'delete') deleteProfile(id);
        });

        // Runs
        $('jnp-runs-profile-filter')?.addEventListener('change', (e) => loadRuns(e.target.value));
        $('jnp-runs-refresh')?.addEventListener('click', () => {
            const id = $('jnp-runs-profile-filter').value;
            if (id) loadRuns(id); else populateRunsProfileFilter();
        });
        $('jnp-runs-tbody')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-jnp-action="open-run"]');
            if (btn) openRunDetail(btn.dataset.id);
        });

        // Run detail
        $('jnp-run-detail-close')?.addEventListener('click', () => $('jnp-run-detail-panel').style.display = 'none');
        $('jnp-run-detail-body')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-jnp-action]');
            if (!btn) return;
            const action = btn.dataset.jnpAction;
            const run = btn.dataset.run;
            const idx = parseInt(btn.dataset.idx, 10);
            if (action === 'preview') previewAction(run, idx);
            else if (action === 'apply') applyAction(run, idx);
            else if (action === 'reject') rejectAction(run, idx);
        });
    }

    // ── Init ────────────────────────────────────────────────

    function init() {
        if (!document.getElementById('tab-janitor')) return; // not on this page
        bind();
        // Tools sub-tab is the default; we stay there until user clicks elsewhere.
        // Pre-load profiles so the run filter has data when user opens Runs sub-tab.
        loadProfiles();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
