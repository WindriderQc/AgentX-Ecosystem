/**
 * StoragePage — Storage Scanner UI logic
 * Talks to data service via core proxy at /api/data/*
 */
const StoragePage = (() => {
    let pollInterval = null;
    let resourceInterval = null;
    let activeScanId = null;
    let scanStartTime = null;
    let elapsedTimer = null;

    // ── Helpers ──────────────────────────────────────────────

    const showToast = (msg, type = 'info') => window.AgentXUtils.showToast(msg, type);

    const apiFetch = DataCommons.apiFetch;

    const formatBytes = (bytes) => window.AgentXUtils.formatBytes(bytes);

    function formatDuration(ms) {
        if (ms == null || isNaN(ms)) return '--';
        const s = Math.floor(ms / 1000);
        if (s < 60) return s + 's';
        const m = Math.floor(s / 60);
        const sec = s % 60;
        if (m < 60) return m + 'm ' + sec + 's';
        const h = Math.floor(m / 60);
        return h + 'h ' + (m % 60) + 'm';
    }

    function formatUptime(seconds) {
        if (seconds == null) return '--';
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        if (d > 0) return d + 'd ' + h + 'h';
        const m = Math.floor((seconds % 3600) / 60);
        return h + 'h ' + m + 'm';
    }

    const timeAgo = DataCommons.timeAgo;

    function truncateId(id) {
        if (!id) return '--';
        return String(id).length > 10 ? String(id).slice(0, 10) + '...' : String(id);
    }

    function badgeClass(status) {
        const s = String(status || '').toLowerCase();
        if (s === 'scanning' || s === 'running') return 'st-badge-scanning';
        if (s === 'complete' || s === 'completed' || s === 'done') return 'st-badge-complete';
        if (s === 'error' || s === 'failed') return 'st-badge-error';
        if (s === 'stopped' || s === 'cancelled') return 'st-badge-stopped';
        return 'st-badge-idle';
    }

    function badgeLabel(status) {
        const s = String(status || '').toLowerCase();
        if (s === 'scanning' || s === 'running') return 'Scanning';
        if (s === 'complete' || s === 'completed' || s === 'done') return 'Complete';
        if (s === 'error' || s === 'failed') return 'Error';
        if (s === 'stopped' || s === 'cancelled') return 'Stopped';
        return 'Idle';
    }

    function $(id) { return document.getElementById(id); }

    // ── Summary ─────────────────────────────────────────────

    async function loadSummary() {
        try {
            const json = await apiFetch('/storage/summary');
            const d = json.data || json;
            $('st-total-files').textContent = (d.totalFiles != null) ? d.totalFiles.toLocaleString() : '--';
            $('st-total-size').textContent = d.totalSizeFormatted || formatBytes(d.totalSize);
            const dupes = d.duplicates;
            $('st-duplicates').textContent = dupes ? (dupes.groups != null ? dupes.groups.toLocaleString() : '--') : '0';
            $('st-last-scan').textContent = d.lastScan ? timeAgo(d.lastScan.started_at || d.lastScan.finished_at) : '--';
            const limits = d.evidenceLimitations || {};
            const scope = d.scope || {};
            const oversized = Number(limits.oversizedCandidateGroups || 0);
            const note = [
                'Verified SHA256 groups and proven savings are lower bounds; candidate bytes are not savings.',
                limits.note,
                oversized > 0
                    ? `${oversized.toLocaleString()} candidate groups currently contain individual unhashed files beyond the per-run budget.`
                    : null,
                scope.note
            ].filter(Boolean).join(' ');
            if ($('st-evidence-note')) $('st-evidence-note').textContent = note;
        } catch (err) {
            console.warn('loadSummary failed:', err);
        }
    }

    // ── Recent scans ────────────────────────────────────────

    async function loadScans() {
        const tbody = $('st-scans-tbody');
        try {
            const json = await apiFetch('/storage/scans');
            const scans = (json.data && json.data.scans) || json.data || json || [];
            if (!Array.isArray(scans) || scans.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="st-empty">No scans yet</td></tr>';
                return;
            }
            tbody.innerHTML = scans.map(s => {
                const counts = s.counts || {};
                const dur = s.duration != null
                    ? formatDuration(s.duration * 1000)
                    : (s.finished_at && s.started_at)
                        ? formatDuration(new Date(s.finished_at) - new Date(s.started_at))
                        : '--';
                const date = s.started_at;
                return `<tr>
                    <td class="st-mono" title="${s._id}">${truncateId(s._id)}</td>
                    <td><span class="st-badge ${badgeClass(s.status)}">${badgeLabel(s.status)}</span></td>
                    <td>${(counts.files_seen || 0).toLocaleString()}</td>
                    <td>${(counts.upserts || 0).toLocaleString()}</td>
                    <td>${(counts.errors || 0).toLocaleString()}</td>
                    <td>${dur}</td>
                    <td title="${date || ''}">${date ? new Date(date).toLocaleDateString() : '--'}</td>
                </tr>`;
            }).join('');
        } catch (err) {
            tbody.innerHTML = '<tr><td colspan="7" class="st-empty">Failed to load scans</td></tr>';
            console.warn('loadScans failed:', err);
        }
    }

    // ── Start scan ──────────────────────────────────────────

    async function startScan() {
        const rootsRaw = ($('st-roots').value || '').trim();
        if (!rootsRaw) {
            showToast('Enter at least one root directory', 'error');
            return;
        }
        const roots = rootsRaw.split('\n').map(r => r.trim()).filter(Boolean);
        const extRaw = ($('st-extensions').value || '').trim();
        const extensions = extRaw ? extRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
        const batchSize = parseInt($('st-batch-size').value, 10) || 100;

        const btn = $('st-start-btn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting...';

        // Reset counters and progress for new scan
        $('st-files-seen').textContent = '0';
        $('st-files-upserted').textContent = '0';
        $('st-files-errors').textContent = '0';
        $('st-elapsed').textContent = '--';
        $('st-start-time').textContent = '--';
        $('st-progress-fill').style.width = '0%';

        try {
            const json = await apiFetch('/storage/scan', {
                method: 'POST',
                body: JSON.stringify({ roots, extensions, batch_size: batchSize }),
            });
            const scanId = (json.data && json.data.scan_id) || json.scan_id;
            if (!scanId) throw new Error('No scan_id in response');
            activeScanId = scanId;
            scanStartTime = Date.now();
            showToast('Scan started: ' + truncateId(scanId), 'success');
            updateStatusUI('scanning', scanId);
            startPolling(scanId);
        } catch (err) {
            showToast('Failed to start scan: ' + err.message, 'error');
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-play"></i> Start Scan';
        }
    }

    // ── Poll status ─────────────────────────────────────────

    function startPolling(scanId) {
        stopPolling();
        pollStatus(scanId); // immediate first poll
        pollInterval = setInterval(() => pollStatus(scanId), 2000);
        startElapsedTimer();
    }

    function stopPolling() {
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
        stopElapsedTimer();
    }

    async function pollStatus(scanId) {
        try {
            const json = await apiFetch('/storage/status/' + scanId);
            const d = json.data || json;
            const counts = d.counts || {};

            $('st-scan-id').textContent = truncateId(d._id || scanId);
            $('st-files-seen').textContent = (counts.files_seen || 0).toLocaleString();
            $('st-files-upserted').textContent = (counts.upserts || 0).toLocaleString();
            $('st-files-errors').textContent = (counts.errors || 0).toLocaleString();

            // No progress percentage from backend
            const isLive = d.live || d.status === 'running' || d.status === 'scanning';
            const fill = $('st-progress-fill');
            if (isLive) {
                // Animate a subtle indeterminate effect based on file count
                const seen = counts.files_seen || 0;
                fill.style.width = seen > 0 ? Math.min(90, Math.log10(seen) * 20) + '%' : '5%';
            } else if (d.status === 'complete' || d.status === 'stopped') {
                fill.style.width = '100%';
            }

            if (d.started_at) {
                $('st-start-time').textContent = new Date(d.started_at).toLocaleTimeString();
                scanStartTime = new Date(d.started_at).getTime();
            }

            const status = String(d.status || '').toLowerCase();
            updateStatusUI(status, d._id || scanId);

            if (status === 'complete' || status === 'completed' || status === 'done' ||
                status === 'error' || status === 'failed' ||
                status === 'stopped' || status === 'cancelled') {
                stopPolling();
                activeScanId = null;
                const btn = $('st-start-btn');
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-play"></i> Start Scan'; }
                loadSummary();
                loadScans();
                if (status === 'complete' || status === 'completed' || status === 'done') {
                    showToast('Scan completed successfully', 'success');
                    $('st-progress-fill').style.width = '100%';
                } else if (status === 'error' || status === 'failed') {
                    showToast('Scan ended with errors', 'error');
                } else {
                    showToast('Scan stopped', 'info');
                }
            }
        } catch (err) {
            console.warn('pollStatus failed:', err);
            stopPolling();
            activeScanId = null;
            showToast('Lost connection to scan', 'error');
        }
    }

    function updateStatusUI(status, scanId) {
        const badge = $('st-status-badge');
        badge.className = 'st-badge ' + badgeClass(status);
        badge.textContent = badgeLabel(status);

        $('st-scan-id').textContent = truncateId(scanId || activeScanId || '--');

        const isActive = (status === 'scanning' || status === 'running');
        $('st-stop-btn').style.display = isActive ? 'inline-flex' : 'none';
    }

    // ── Elapsed timer ───────────────────────────────────────

    function startElapsedTimer() {
        stopElapsedTimer();
        updateElapsed();
        elapsedTimer = setInterval(updateElapsed, 1000);
    }

    function stopElapsedTimer() {
        if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    }

    function updateElapsed() {
        if (!scanStartTime) { $('st-elapsed').textContent = '--'; return; }
        $('st-elapsed').textContent = formatDuration(Date.now() - scanStartTime);
    }

    // ── Stop scan ───────────────────────────────────────────

    async function stopScan() {
        if (!activeScanId) return;
        const btn = $('st-stop-btn');
        btn.disabled = true;
        try {
            await apiFetch('/storage/stop/' + activeScanId, { method: 'POST' });
            showToast('Stop requested', 'info');
        } catch (err) {
            showToast('Failed to stop: ' + err.message, 'error');
        } finally {
            btn.disabled = false;
        }
    }

    // ── System resources ────────────────────────────────────

    async function loadResources() {
        try {
            const json = await apiFetch('/system/resources');
            const d = json.data || json;
            const sys = d.system || {};
            const proc = d.process || {};
            // CPU: use system load average as percentage (load / cpus * 100)
            const cpus = sys.cpus || 1;
            const load1m = Array.isArray(sys.load_avg) ? sys.load_avg[0] : null;
            $('st-res-cpu').textContent = load1m != null ? (load1m / cpus * 100).toFixed(1) + '%' : '--';
            // Memory: percentage of total used
            const totalMem = sys.total_mem || 1;
            const freeMem = sys.free_mem || 0;
            const memPct = ((totalMem - freeMem) / totalMem * 100);
            $('st-res-memory').textContent = totalMem ? memPct.toFixed(1) + '%' : '--';
            // Load average
            $('st-res-load').textContent = load1m != null ? load1m.toFixed(2) : '--';
            // Uptime from system
            $('st-res-uptime').textContent = sys.uptime != null ? formatUptime(sys.uptime) : '--';
        } catch (err) {
            console.warn('loadResources failed:', err);
        }
    }

    function startResourcePolling() {
        loadResources();
        resourceInterval = setInterval(loadResources, 10000);
    }

    // ── Cleanup ─────────────────────────────────────────────

    function cleanup() {
        stopPolling();
        if (resourceInterval) { clearInterval(resourceInterval); resourceInterval = null; }
    }

    window.addEventListener('beforeunload', cleanup);

    // ── Init ────────────────────────────────────────────────

    function init() {
        document.getElementById('st-start-btn').addEventListener('click', startScan);
        document.getElementById('st-stop-btn').addEventListener('click', stopScan);
        document.getElementById('st-refresh-scans-btn').addEventListener('click', loadScans);

        loadSummary();
        loadScans();
        startResourcePolling();
    }

    // ── Public API ──────────────────────────────────────────

    return { init, startScan, stopScan, loadScans, loadSummary, loadResources };
})();
