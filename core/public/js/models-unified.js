/**
 * Unified Model Catalog — AgentX
 *
 * Single consolidated view: table with enriched rows, category filters,
 * tag cloud, benchmark scores, capabilities, host indicators, detail drawer.
 */

const API_ENDPOINT = '/api/models/catalog';

/* ── Category color map ─────────────────────────────────── */
const CAT_COLORS = {
    coding:     { bg: 'rgba(59,130,246,0.15)',  border: '#3b82f6',  text: '#60a5fa' },
    reasoning:  { bg: 'rgba(168,85,247,0.15)',  border: '#a855f7',  text: '#c084fc' },
    generalist: { bg: 'rgba(100,116,139,0.15)', border: '#64748b',  text: '#94a3b8' },
    specialist: { bg: 'rgba(236,72,153,0.15)',  border: '#ec4899',  text: '#f472b6' },
    ops:        { bg: 'rgba(34,197,94,0.15)',   border: '#22c55e',  text: '#4ade80' },
    embedding:  { bg: 'rgba(139,92,246,0.15)',  border: '#8b5cf6',  text: '#a78bfa' },
    judge:      { bg: 'rgba(245,158,11,0.15)',  border: '#f59e0b',  text: '#fbbf24' },
};

/* ── Score color helper ─────────────────────────────────── */
function scoreColor(score) {
    if (score >= 80) return '#22c55e';
    if (score >= 60) return '#3b82f6';
    if (score >= 40) return '#f59e0b';
    return '#ef4444';
}

function escapeHtml(value) {
    return window.AgentXUtils.escapeHtml(value);
}

/* ================================================================
   UnifiedModels — main class
   ================================================================ */
class UnifiedModels {
    constructor() {
        this.allModels = [];
        this.filteredModels = [];
        this.comparisonList = new Set();
        this.sources = null;
        this.activeCategory = 'all';
        this.activeTags = new Set();
        this.currentSort = { column: null, direction: null };
        this.uiReady = false;

        this.manager = null;
        this.comparator = null;

        this.tableBodyEl = document.getElementById('modelsTableBody');
        this.loadingEl = document.getElementById('loadingIndicator');
        this.compareDrawer = document.getElementById('compareDrawer');
        this.compareListEl = document.getElementById('compareList');
        this.compareContentEl = document.getElementById('compareContent');
        this.compareSubtitleEl = document.getElementById('compareSubtitle');

        this.loadedModels = new Map(); // hostUrl -> Set of model names loaded in VRAM

        this.init();
    }

    async init() {
        if (!this.uiReady) {
            if (window.ModelManager) this.manager = new ModelManager(this);
            if (window.ModelComparator) this.comparator = new ModelComparator(this);

            this.setupCategoryStrip();
            this.setupFilters();
            this.setupActionMenuDismissal();
            this.setupStatPopouts();
            this.setupDetailDrawer();
            this.uiReady = true;
        }
        await this.fetchModels();
        // Fetch live state in background (non-blocking)
        this.fetchLiveState().catch(() => {});
    }

    /* ── Data fetching ──────────────────────────────────── */
    async fetchModels() {
        try {
            if (this.loadingEl) this.loadingEl.style.display = 'block';
            if (this.tableBodyEl) this.tableBodyEl.innerHTML = '';

            const res = await fetch(API_ENDPOINT, { credentials: 'include' });

            if (!res.ok) throw new Error('Failed to fetch models');

            const data = await res.json();
            const payload = data.data || data;
            this.allModels = payload.models || [];
            this.sources = payload.sources || null;
            const validIds = new Set(this.allModels.map(model => model.id || model.name));
            this.comparisonList = new Set([...this.comparisonList].filter(id => validIds.has(id)));

            this.filteredModels = [...this.allModels];
            this.updateStats();
            this.buildHostFilter();
            this.buildTagCloud();
            this.filterModels();
            this.renderComparisonDrawer();
        } catch (err) {
            console.error('Error:', err);
            if (this.tableBodyEl) this.tableBodyEl.innerHTML = `<tr><td colspan="9" class="error-msg text-center p-4">Failed to load models. ${escapeHtml(err.message)}</td></tr>`;
        } finally {
            if (this.loadingEl) this.loadingEl.style.display = 'none';
        }
    }

    /* ── Category pill strip ────────────────────────────── */
    setupCategoryStrip() {
        document.querySelectorAll('.cat-pill').forEach(pill => {
            pill.addEventListener('click', () => {
                document.querySelector('.cat-pill.active')?.classList.remove('active');
                pill.classList.add('active');
                this.activeCategory = pill.dataset.cat;
                this.filterModels();
            });
        });
    }

    /* ── Host filter dropdown ───────────────────────────── */
    buildHostFilter() {
        const sel = document.getElementById('hostSelect');
        if (!sel) return;
        const hosts = new Map();
        for (const host of (this.sources?.ollama?.hosts || [])) {
            if (host?.url) hosts.set(host.url, host.name || host.url);
        }
        for (const m of this.allModels) {
            if (m.provider !== 'ollama' || m.deployment?.status === 'gone') continue;
            const url = m.source?.url;
            const name = m.source?.hostName || url;
            if (url && !hosts.has(url)) hosts.set(url, name);
        }
        // Keep "All Hosts" option, add discovered hosts
        sel.innerHTML = '<option value="all">All Hosts</option>';
        for (const [url, name] of hosts) {
            const opt = document.createElement('option');
            opt.value = url;
            opt.textContent = name;
            sel.appendChild(opt);
        }
        sel.onchange = () => this.filterModels();
    }

    /* ── Tag cloud ──────────────────────────────────────── */
    buildTagCloud() {
        const tagCounts = new Map();
        for (const m of this.allModels) {
            for (const t of (m.tags || [])) {
                tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
            }
        }
        const container = document.getElementById('tagCloud');
        if (!container) return;

        if (tagCounts.size === 0) {
            container.style.display = 'none';
            return;
        }
        container.style.display = 'flex';
        container.innerHTML = '<span class="tag-cloud-label"><i class="fas fa-tags"></i> Tags:</span>';

        const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
        for (const [tag, count] of sorted.slice(0, 20)) {
            const btn = document.createElement('button');
            btn.className = 'tag-pill';
            btn.dataset.tag = tag;
            btn.innerHTML = `${escapeHtml(tag)} <span class="tag-count">${count}</span>`;
            btn.addEventListener('click', () => {
                if (this.activeTags.has(tag)) {
                    this.activeTags.delete(tag);
                    btn.classList.remove('active');
                } else {
                    this.activeTags.add(tag);
                    btn.classList.add('active');
                }
                this.filterModels();
            });
            container.appendChild(btn);
        }
    }

    /* ── Filtering ──────────────────────────────────────── */
    setupFilters() {
        let timeout;
        document.getElementById('searchInput')?.addEventListener('input', () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => this.filterModels(), 250);
        });

        ['providerSelect', 'sortSelect', 'statusSelect'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => this.filterModels());
        });

        document.getElementById('clearCompare')?.addEventListener('click', () => {
            this.comparisonList.clear();
            this.renderComparisonDrawer();
            this.renderTable();
        });

        document.querySelectorAll('.models-table th.sortable').forEach(th => {
            th.addEventListener('click', () => this.sortByColumn(th.dataset.sort));
        });
    }

    setupActionMenuDismissal() {
        if (this.actionMenuDismissalBound) return;
        this.actionMenuDismissalBound = true;
        document.addEventListener('click', () => {
            document.querySelectorAll('.action-menu.active').forEach(el => el.classList.remove('active'));
        });
    }

    filterModels() {
        const term = (document.getElementById('searchInput')?.value || '').toLowerCase();
        const provider = document.getElementById('providerSelect')?.value || 'all';
        const hostFilter = document.getElementById('hostSelect')?.value || 'all';
        const statusFilter = document.getElementById('statusSelect')?.value || 'available';
        const sort = document.getElementById('sortSelect')?.value || 'name';
        const cat = this.activeCategory;

        this.filteredModels = this.allModels.filter(m => {
            // Status filter (default: hide gone models)
            const isGone = m.deployment?.status === 'gone';
            if (statusFilter === 'available' && isGone) return false;
            if (statusFilter === 'gone' && !isGone) return false;

            // Search: name, tags, vendor, description
            const searchFields = [
                m.name, m.displayName, m.vendor, m.description,
                ...(m.tags || []), ...(m.categories || [])
            ].join(' ').toLowerCase();
            if (term && !searchFields.includes(term)) return false;

            // Provider
            const normalizedProvider = provider;
            if (normalizedProvider !== 'all' && m.provider !== normalizedProvider) return false;

            // Host
            if (hostFilter !== 'all' && m.source?.url !== hostFilter) return false;

            // Category
            if (cat !== 'all') {
                const cats = m.categories || [];
                if (!cats.includes(cat)) return false;
            }

            // Tags
            if (this.activeTags.size > 0) {
                const mTags = new Set(m.tags || []);
                for (const t of this.activeTags) {
                    if (!mTags.has(t)) return false;
                }
            }

            return true;
        });

        // Sort
        if (!this.currentSort.column) {
            this.filteredModels.sort((a, b) => {
                if (sort === 'score') return (b.benchmarkStats?.avgCompositeScore || 0) - (a.benchmarkStats?.avgCompositeScore || 0);
                if (sort === 'size') return (b.size || 0) - (a.size || 0);
                if (sort === 'speed') return (b.capabilities?.avgTokensPerSec || 0) - (a.capabilities?.avgTokensPerSec || 0);
                if (sort === 'newest') return new Date(b.modified_at || 0) - new Date(a.modified_at || 0);
                return a.name.localeCompare(b.name);
            });
        }

        this.renderTable();
    }

    /* ── Column sorting ─────────────────────────────────── */
    sortByColumn(column) {
        if (this.currentSort.column === column) {
            this.currentSort.direction = this.currentSort.direction === 'asc' ? 'desc' :
                this.currentSort.direction === 'desc' ? null : 'asc';
            if (!this.currentSort.direction) this.currentSort.column = null;
        } else {
            this.currentSort = { column, direction: 'asc' };
        }

        if (this.currentSort.column) {
            const dir = this.currentSort.direction === 'asc' ? 1 : -1;
            this.filteredModels.sort((a, b) => {
                let av, bv;
                switch (column) {
                    case 'name':    av = a.name?.toLowerCase() || ''; bv = b.name?.toLowerCase() || ''; return dir * av.localeCompare(bv);
                    case 'host':    av = a.source?.hostName || a.source?.url || ''; bv = b.source?.hostName || b.source?.url || ''; return dir * av.localeCompare(bv);
                    case 'params':  av = parseFloat(a.details?.parameter_size || a.parameterSize || '0'); bv = parseFloat(b.details?.parameter_size || b.parameterSize || '0'); return dir * (av - bv);
                    case 'context': av = a.executionOverrides?.num_ctx || a.executionDefaults?.num_ctx || a.capabilities?.maxContext || 0; bv = b.executionOverrides?.num_ctx || b.executionDefaults?.num_ctx || b.capabilities?.maxContext || 0; return dir * (av - bv);
                    case 'score':   av = a.benchmarkStats?.avgCompositeScore || 0; bv = b.benchmarkStats?.avgCompositeScore || 0; return dir * (av - bv);
                    case 'speed':   av = a.capabilities?.avgTokensPerSec || 0; bv = b.capabilities?.avgTokensPerSec || 0; return dir * (av - bv);
                    default: return 0;
                }
            });
        }

        this.updateSortIndicators();
        this.renderTable();
    }

    updateSortIndicators() {
        document.querySelectorAll('.models-table th.sortable').forEach(th => {
            th.classList.remove('sort-asc', 'sort-desc');
        });
        if (this.currentSort.column) {
            const th = document.querySelector(`.models-table th[data-sort="${this.currentSort.column}"]`);
            if (th) th.classList.add(`sort-${this.currentSort.direction}`);
        }
    }

    getActiveModels() {
        return this.allModels.filter(m => m.deployment?.status !== 'gone');
    }

    getGoneModels() {
        return this.allModels.filter(m => m.deployment?.status === 'gone');
    }

    uniqueLogicalModels(models) {
        const unique = new Map();
        for (const model of models) {
            const key = `${model.provider || 'unknown'}:${String(model.name || '').toLowerCase().replace(/:latest$/, '')}`;
            if (!unique.has(key)) unique.set(key, model);
        }
        return [...unique.values()];
    }

    formatBytes(bytes, compact = false) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '--';

        const units = compact
            ? ['B', 'K', 'M', 'G', 'T']
            : ['B', 'KB', 'MB', 'GB', 'TB'];

        let value = bytes;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex += 1;
        }

        const precision = value >= 100 || unitIndex === 0 ? 0 : 1;
        return `${value.toFixed(precision)} ${units[unitIndex]}`.trim();
    }

    getHostHardware(hostName) {
        return { gpu: 'GPU', vramGb: null };
    }

    getHostSummaries() {
        const entries = new Map();
        const configuredHosts = Array.isArray(this.sources?.ollama?.hosts) ? this.sources.ollama.hosts : [];
        const active = this.getActiveModels();

        const ensureEntry = ({ url, name }) => {
            const key = url || `name:${name || 'unknown'}`;
            if (!entries.has(key)) {
                const hardware = this.getHostHardware(name);
                entries.set(key, {
                    key,
                    url: url || '',
                    name: name || url || 'Unknown Host',
                    models: [],
                    totalSize: 0,
                    loadedModels: [],
                    idleModels: [],
                    status: 'unknown',
                    gpu: hardware.gpu,
                    vramGb: hardware.vramGb,
                });
            }
            return entries.get(key);
        };

        for (const host of configuredHosts) {
            ensureEntry({
                url: typeof host === 'string' ? host : host?.url,
                name: typeof host === 'string' ? host : (host?.name || host?.url),
            });
        }

        for (const model of active) {
            if (model.provider !== 'ollama') continue;
            const entry = ensureEntry({
                url: model.source?.url,
                name: model.source?.hostName || model.source?.url,
            });
            entry.models.push(model);
            entry.totalSize += model.size || 0;
        }

        for (const url of this.loadedModels.keys()) {
            ensureEntry({
                url,
                name: configuredHosts.find(host => (typeof host === 'string' ? host : host?.url) === url)?.name || url,
            });
        }

        const hasLiveState = this.loadedModels.size > 0;
        for (const entry of entries.values()) {
            const loadedSet = entry.url ? (this.loadedModels.get(entry.url) || new Set()) : new Set();
            entry.loadedModels = entry.models.filter(model => loadedSet.has(model.name) || loadedSet.has(model.name?.split(':')[0]));
            entry.idleModels = entry.models.filter(model => !loadedSet.has(model.name) && !loadedSet.has(model.name?.split(':')[0]));
            entry.status = !entry.url || !hasLiveState
                ? 'unknown'
                : this.loadedModels.has(entry.url)
                ? 'online'
                : 'offline';
        }

        return [...entries.values()].sort((a, b) =>
            (b.models.length - a.models.length) ||
            (b.loadedModels.length - a.loadedModels.length) ||
            a.name.localeCompare(b.name)
        );
    }

    /* ── Stats ──────────────────────────────────────────── */
    updateStats() {
        const active = this.getActiveModels();
        const gone = this.getGoneModels();
        const activeLogical = this.uniqueLogicalModels(active);
        const goneLogical = this.uniqueLogicalModels(gone);
        const totalEl = document.getElementById('statTotal');
        if (totalEl) totalEl.innerText = goneLogical.length
            ? `${activeLogical.length} + ${goneLogical.length}`
            : String(activeLogical.length);

        const size = active.reduce((acc, m) => acc + (m.size || 0), 0);
        document.getElementById('statStorage').innerText = this.formatBytes(size);

        const s = this.sources || {};
        const inferredHosts = new Set(active.filter(m => m?.provider === 'ollama').map(m => m?.source?.url).filter(Boolean));
        const hostCount = Array.isArray(s?.ollama?.hosts) && s.ollama.hosts.length ? s.ollama.hosts.length : inferredHosts.size;
        const customCount = Number(s?.custom?.count || 0) || active.filter(m => m?.provider === 'custom').length;

        const hostsEl = document.getElementById('statHosts');
        const subEl = document.getElementById('statHostsSub');
        if (hostsEl) hostsEl.innerText = String(hostCount);
        if (subEl) {
            const parts = [];
            if (customCount) parts.push(`${customCount} custom`);
            subEl.innerText = parts.length ? `Extras: ${parts.join(' · ')}` : 'Ollama hosts';
        }

        // Storage sub-text: per host
        const byHost = new Map();
        for (const m of active) {
            if (m.provider !== 'ollama') continue;
            const hname = m.source?.hostName || 'Unknown';
            byHost.set(hname, (byHost.get(hname) || 0) + (m.size || 0));
        }
        const storageSub = document.getElementById('statStorageSub');
        if (storageSub && byHost.size > 0) {
            storageSub.innerText = [...byHost.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([h, s]) => `${h}: ${this.formatBytes(s, true)}`)
                .join(' · ');
        }

        // Total sub-text
        const totalSub = document.getElementById('statTotalSub');
        if (totalSub) {
            const ollamaInstalls = active.filter(m => m.provider === 'ollama').length;
            const ollamaModels = this.uniqueLogicalModels(active.filter(m => m.provider === 'ollama')).length;
            const parts = [`${ollamaModels} Ollama models · ${ollamaInstalls} host installs`];
            const custom = activeLogical.filter(m => m.provider === 'custom').length;
            if (custom) parts.push(`${custom} custom`);
            if (goneLogical.length) parts.push(`${goneLogical.length} gone`);
            totalSub.innerText = parts.join(' · ');
        }

        // Benchmarked — count all (guest book models keep their stats)
        const benchmarked = this.uniqueLogicalModels(this.allModels.filter(m => m.benchmarkStats?.avgCompositeScore > 0));
        const benchEl = document.getElementById('statBenchmarked');
        const avgEl = document.getElementById('statAvgScore');
        if (benchEl) benchEl.innerText = benchmarked.length;
        if (avgEl && benchmarked.length > 0) {
            const avg = benchmarked.reduce((s, m) => s + m.benchmarkStats.avgCompositeScore, 0) / benchmarked.length;
            avgEl.innerText = `Avg: ${avg.toFixed(1)}`;
        }
    }

    /* ── Live state (loaded models) ────────────────────── */
    async fetchLiveState() {
        try {
            const res = await fetch('/api/cluster/schedule/live', { credentials: 'include' });
            if (!res.ok) return;
            const json = await res.json();
            const hosts = json?.data?.hosts || [];
            this.loadedModels.clear();
            for (const h of hosts) {
                if (h.status !== 'online') continue;
                const set = new Set();
                for (const m of (h.models || [])) {
                    // Ollama returns full name like "qwen2.5:14b", normalize
                    const name = (m.name || m.model || '').split(':')[0];
                    set.add(m.name || m.model || '');
                    if (name) set.add(name);
                }
                this.loadedModels.set(h.url, set);
            }
            // Re-render table to show status indicators
            this.renderTable();
        } catch (e) {
            // Graceful degradation — live state is optional
        }
    }

    isModelLoaded(model) {
        if (model.provider !== 'ollama') return null; // non-ollama: unknown
        const hostUrl = model.source?.url;
        if (!hostUrl || !this.loadedModels.has(hostUrl)) return null;
        const set = this.loadedModels.get(hostUrl);
        const runtimeName = model.deployment?.resolvedName || model.name;
        return set.has(runtimeName) || set.has(runtimeName?.split(':')[0]) || false;
    }

    /* ── Table rendering ────────────────────────────────── */
    renderTable() {
        if (!this.tableBodyEl) return;
        this.tableBodyEl.innerHTML = '';
        if (this.filteredModels.length === 0) {
            this.tableBodyEl.innerHTML = '<tr><td colspan="9" class="text-center p-4" style="color:var(--muted);">No models found</td></tr>';
            return;
        }

        for (const model of this.filteredModels) {
            const tr = document.createElement('tr');
            if (model.deployment?.status === 'gone') tr.classList.add('model-gone');
            tr.innerHTML = this.buildRowHTML(model);

            // Row click → detail drawer
            tr.addEventListener('click', (e) => {
                if (e.target.closest('.actions, button, a, .action-menu')) return;
                this.openDetailDrawer(model);
            });

            // Compare
            tr.querySelector('.action-compare')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleCompare(model);
            });

            tr.querySelector('.action-chat')?.addEventListener('click', (e) => {
                e.stopPropagation();
                startChat(model.name);
            });

            // Action menu
            const actionBtn = tr.querySelector('.btn-actions');
            if (actionBtn) {
                actionBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    document.querySelectorAll('.action-menu.active').forEach(el => el.classList.remove('active'));
                    tr.querySelector('.action-menu')?.classList.toggle('active');
                });
            }

            tr.querySelector('.action-delete')?.addEventListener('click', (e) => { e.stopPropagation(); this.manager?.deleteModel(model); });
            tr.querySelector('.action-start')?.addEventListener('click', (e) => { e.stopPropagation(); this.manager?.startModel(model); });
            tr.querySelector('.action-stop')?.addEventListener('click', (e) => { e.stopPropagation(); this.manager?.stopModel(model); });
            tr.querySelector('.action-test')?.addEventListener('click', (e) => { e.stopPropagation(); this.manager?.testModel(model); });
            tr.querySelector('.action-config')?.addEventListener('click', (e) => { e.stopPropagation(); if (window.modelExecutionConfig) window.modelExecutionConfig.open(model.name); });

            tr.querySelector('.context-cell')?.addEventListener('click', (e) => {
                e.stopPropagation();
                if (window.modelExecutionConfig) window.modelExecutionConfig.open(model.name);
            });

            this.tableBodyEl.appendChild(tr);
        }
    }

    buildRowHTML(model) {
        const source = model.provider || 'custom';
        const isOllama = source === 'ollama';
        const isGone = model.deployment?.status === 'gone';
        const isSelected = this.comparisonList.has(model.id || model.name);

        const params = model.details?.parameter_size || model.parameterSize || model.parameters || '-';
        // Effective context: override > auto-detected default > theoretical max
        const rawCtx = model.executionOverrides?.num_ctx || model.executionDefaults?.num_ctx || model.capabilities?.maxContext || model.details?.context_length || null;
        const context = rawCtx ? (rawCtx >= 1024 ? Math.round(rawCtx / 1024) + 'k' : rawCtx) : '--';

        // Host
        const hostName = isOllama ? (model.source?.hostName || '') : '';
        const hostUrl = model.source?.url || '';

        // Categories
        const cats = (model.categories || []).slice(0, 3);
        const catBadges = cats.map(c => {
            const col = CAT_COLORS[c] || CAT_COLORS.generalist;
            return `<span class="cat-badge" style="background:${col.bg}; border-color:${col.border}; color:${col.text};">${escapeHtml(c)}</span>`;
        }).join('') || '<span style="color:var(--muted); font-size:12px;">--</span>';

        // Benchmark score
        const score = model.benchmarkStats?.avgCompositeScore;
        let scoreCell = '<span style="color:var(--muted);">--</span>';
        if (score != null && score > 0) {
            const color = scoreColor(score);
            scoreCell = `<div class="score-badge" style="--score-color:${color};">
                <div class="score-bar" style="width:${Math.min(score, 100)}%; background:${color};"></div>
                <span>${score.toFixed(1)}</span>
            </div>`;
        }

        // Speed
        const tps = model.capabilities?.avgTokensPerSec;
        const speedCell = tps ? `<span class="speed-val">${tps.toFixed(1)}<span class="speed-unit"> t/s</span></span>` : '<span style="color:var(--muted);">--</span>';

        // Capability icons
        const caps = [];
        if (model.capabilities?.supportsThinking) caps.push('<i class="fas fa-brain cap-icon" title="Thinking/Reasoning"></i>');
        if (model.capabilities?.supportsVision) caps.push('<i class="fas fa-eye cap-icon" title="Vision"></i>');
        const jt = model.capabilities?.judgeTier || model.capabilities?.curatedJudgeTier;
        if (jt) caps.push(`<span class="judge-tier tier-${jt}" title="Judge: ${jt}">${jt[0].toUpperCase()}</span>`);
        // Tags as tiny pills (max 2)
        const tags = (model.tags || []).slice(0, 2);
        for (const t of tags) {
            caps.push(`<span class="micro-tag">${escapeHtml(t)}</span>`);
        }
        const capCell = caps.length ? caps.join(' ') : '<span style="color:var(--muted);">--</span>';

        // Live status
        const loaded = this.isModelLoaded(model);
        const statusDot = loaded === true
            ? '<span class="status-dot loaded" title="Loaded in VRAM"></span>'
            : loaded === false
            ? '<span class="status-dot idle" title="Installed (not loaded)"></span>'
            : '';
        const runtimeAction = loaded === true
            ? '<button class="menu-item action-stop"><i class="fas fa-stop"></i> Stop on this host</button>'
            : '<button class="menu-item action-start"><i class="fas fa-play"></i> Start on this host</button>';
        const runtimeMenu = isOllama && !isGone
            ? `${runtimeAction}
               <button class="menu-item action-test"><i class="fas fa-flask"></i> Test on this host</button>
               <button class="menu-item action-config"><i class="fas fa-sliders-h"></i> Config</button>
               <div class="divider"></div>
               <button class="menu-item action-delete text-red"><i class="fas fa-trash"></i> Delete from this host</button>`
            : '<button class="menu-item action-config"><i class="fas fa-sliders-h"></i> Config</button>';

        return `
            <td>
                <div class="model-name">
                    <div class="model-icon ${source}">${this.getIconForSource(source)}</div>
                    <div>
                        <div class="model-primary-name">${statusDot}${escapeHtml(model.name)}</div>
                        ${model.vendor ? `<div class="model-vendor">${escapeHtml(model.vendor)}</div>` : ''}
                    </div>
                </div>
            </td>
            <td>
                ${isGone
                    ? `<span class="host-badge gone" title="Model removed from host">${hostName ? escapeHtml(hostName) : 'Gone'} <i class="fas fa-ghost" style="margin-left:4px; font-size:10px;"></i></span>`
                    : hostName ? `<span class="host-badge" title="${escapeHtml(hostUrl)}">${escapeHtml(hostName)}</span>` : `<span class="tag uppercase">${escapeHtml(source)}</span>`}
            </td>
            <td>${escapeHtml(params)}</td>
            <td class="context-cell" data-model="${escapeHtml(model.name)}" title="${model.executionOverrides?.num_ctx ? 'Override' : model.executionDefaults?.num_ctx ? 'Auto-detected' : 'Max capability'} · Click to configure">${context}</td>
            <td>${catBadges}</td>
            <td>${scoreCell}</td>
            <td>${speedCell}</td>
            <td class="cap-cell">${capCell}</td>
            <td class="text-right table-action-cell">
                <div class="actions">
                    <button class="btn-icon action-compare ${isSelected ? 'active text-accent' : ''}" title="Compare">
                        <i class="fas ${isSelected ? 'fa-check' : 'fa-plus'}"></i>
                    </button>
                    <button class="btn-primary-sm action-chat" title="Chat with ${escapeHtml(model.name)}">
                        <i class="fas fa-comment-alt"></i>
                        <span>Chat</span>
                    </button>
                    <button class="btn-icon btn-actions" title="More">
                        <i class="fas fa-ellipsis-v"></i>
                    </button>
                    <div class="action-menu glass-panel">
                        ${runtimeMenu}
                    </div>
                </div>
            </td>
        `;
    }

    getIconForSource(source) {
        if (source === 'ollama') return '<i class="fas fa-laptop-code"></i>';
        return '<i class="fas fa-cube"></i>';
    }

    /* ── Detail Drawer ──────────────────────────────────── */
    setupDetailDrawer() {
        document.getElementById('closeDetailDrawer')?.addEventListener('click', () => this.closeDetailDrawer());
        document.getElementById('detailDrawerBackdrop')?.addEventListener('click', () => this.closeDetailDrawer());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.closeDetailDrawer();
        });
    }

    openDetailDrawer(model) {
        const drawer = document.getElementById('modelDetailDrawer');
        const backdrop = document.getElementById('detailDrawerBackdrop');
        const title = document.getElementById('detailModelName');
        const body = document.getElementById('detailDrawerBody');
        if (!drawer || !body) return;

        title.textContent = model.displayName || model.name;
        body.innerHTML = this.buildDetailContent(model);
        drawer.classList.add('open');
        backdrop?.classList.add('open');
        document.body.style.overflow = 'hidden';
    }

    closeDetailDrawer() {
        document.getElementById('modelDetailDrawer')?.classList.remove('open');
        document.getElementById('detailDrawerBackdrop')?.classList.remove('open');
        document.body.style.overflow = '';
    }

    buildDetailContent(m) {
        const sections = [];

        // Identity
        const isGone = m.deployment?.status === 'gone';
        const detailLoaded = isGone ? null : this.isModelLoaded(m);
        const statusLabel = isGone
            ? '<span style="color:#f97316; font-weight:600;"><i class="fas fa-ghost" style="margin-right:4px;"></i>Removed from host</span>'
            : detailLoaded === true ? '<span style="color:#22c55e; font-weight:600;">Loaded in VRAM</span>'
            : detailLoaded === false ? '<span style="color:var(--muted);">Installed (idle)</span>'
            : '<span style="color:var(--muted);">--</span>';
        sections.push(`
            <div class="detail-section">
                <h3><i class="fas fa-id-card"></i> Identity</h3>
                <div class="detail-grid">
                    <div class="detail-kv"><span class="dk">Name</span><span class="dv">${escapeHtml(m.name)}</span></div>
                    <div class="detail-kv"><span class="dk">Status</span><span class="dv">${statusLabel}</span></div>
                    <div class="detail-kv"><span class="dk">Vendor</span><span class="dv">${escapeHtml(m.vendor || '--')}</span></div>
                    <div class="detail-kv"><span class="dk">Family</span><span class="dv">${escapeHtml(m.family || m.details?.family || '--')}</span></div>
                    <div class="detail-kv"><span class="dk">Params</span><span class="dv">${escapeHtml(m.details?.parameter_size || m.parameterSize || '--')}</span></div>
                    <div class="detail-kv"><span class="dk">Quantization</span><span class="dv">${escapeHtml(m.details?.quantization_level || m.quantization || '--')}</span></div>
                    <div class="detail-kv"><span class="dk">Source</span><span class="dv">${escapeHtml(m.provider || '--')}</span></div>
                    <div class="detail-kv"><span class="dk">Host</span><span class="dv">${escapeHtml(m.source?.hostName || m.source?.url || '--')}</span></div>
                </div>
                ${m.description ? `<p class="detail-desc">${escapeHtml(m.description)}</p>` : ''}
                ${m.userNote ? `<p class="detail-note"><i class="fas fa-sticky-note"></i> ${escapeHtml(m.userNote)}</p>` : ''}
            </div>
        `);

        // Categories & Tags
        const cats = (m.categories || []).map(c => {
            const col = CAT_COLORS[c] || CAT_COLORS.generalist;
            return `<span class="cat-badge" style="background:${col.bg}; border-color:${col.border}; color:${col.text};">${escapeHtml(c)}</span>`;
        }).join('') || '<span style="color:var(--muted);">None assigned</span>';

        const tags = (m.tags || []).map(t =>
            `<span class="micro-tag">${escapeHtml(t)}</span>`
        ).join('') || '<span style="color:var(--muted);">No tags</span>';

        sections.push(`
            <div class="detail-section">
                <h3><i class="fas fa-tags"></i> Categories & Tags</h3>
                <div style="margin-bottom:8px;">${cats}</div>
                <div class="detail-tags">${tags}</div>
            </div>
        `);

        // Capabilities
        const cap = m.capabilities || {};
        const fmtCtx = (v) => v ? (v >= 1024 ? Math.round(v / 1024) + 'k' : v) : '--';
        const effectiveCtx = m.executionOverrides?.num_ctx || m.executionDefaults?.num_ctx || cap.maxContext;
        const maxCtx = cap.maxContext;
        const isOverridden = m.executionOverrides?.num_ctx != null;
        const isAutoDetected = !isOverridden && m.executionDefaults?.num_ctx != null && m.executionDefaults.num_ctx !== maxCtx;
        const ctxLabel = isOverridden ? 'Override' : isAutoDetected ? 'Auto-detected' : 'Max';
        const ctxColor = isOverridden ? 'color:#fbbf24;' : isAutoDetected ? 'color:#60a5fa;' : '';
        sections.push(`
            <div class="detail-section">
                <h3><i class="fas fa-gauge-high"></i> Capabilities</h3>
                <div class="detail-grid">
                    <div class="detail-kv"><span class="dk">Context (${ctxLabel})</span><span class="dv" style="${ctxColor} font-weight:700;">${fmtCtx(effectiveCtx)}</span></div>
                    ${maxCtx && effectiveCtx !== maxCtx ? `<div class="detail-kv"><span class="dk">Context (Max)</span><span class="dv" style="color:var(--muted);">${fmtCtx(maxCtx)}</span></div>` : ''}
                    <div class="detail-kv"><span class="dk">Avg Tokens/sec</span><span class="dv">${cap.avgTokensPerSec ? cap.avgTokensPerSec.toFixed(1) : '--'}</span></div>
                    <div class="detail-kv"><span class="dk">Avg Latency</span><span class="dv">${cap.avgLatencyMs ? cap.avgLatencyMs.toFixed(0) + 'ms' : '--'}</span></div>
                    <div class="detail-kv"><span class="dk">P95 Latency</span><span class="dv">${cap.p95LatencyMs ? cap.p95LatencyMs.toFixed(0) + 'ms' : '--'}</span></div>
                    <div class="detail-kv"><span class="dk">Thinking</span><span class="dv">${cap.supportsThinking ? '<i class="fas fa-check" style="color:#22c55e;"></i> Yes' : 'No'}</span></div>
                    <div class="detail-kv"><span class="dk">Vision</span><span class="dv">${cap.supportsVision ? '<i class="fas fa-check" style="color:#22c55e;"></i> Yes' : 'No'}</span></div>
                    <div class="detail-kv"><span class="dk">Judge Tier</span><span class="dv">${escapeHtml(cap.curatedJudgeTier || cap.judgeTier || '--')}</span></div>
                    <div class="detail-kv"><span class="dk">Judge Reliability</span><span class="dv">${cap.judgeReliability != null ? (cap.judgeReliability * 100).toFixed(0) + '%' : '--'}</span></div>
                </div>
            </div>
        `);

        // Benchmark Stats
        const bs = m.benchmarkStats;
        if (bs && bs.avgCompositeScore > 0) {
            sections.push(`
                <div class="detail-section">
                    <h3><i class="fas fa-chart-bar"></i> Benchmark</h3>
                    <div class="detail-grid">
                        <div class="detail-kv"><span class="dk">Composite Score</span><span class="dv" style="color:${scoreColor(bs.avgCompositeScore)}; font-weight:700;">${bs.avgCompositeScore.toFixed(1)}</span></div>
                        <div class="detail-kv"><span class="dk">Quality Score</span><span class="dv">${bs.avgQualityScore ? bs.avgQualityScore.toFixed(1) : '--'}</span></div>
                        <div class="detail-kv"><span class="dk">Best Category</span><span class="dv">${escapeHtml(bs.bestCategory || '--')}</span></div>
                        <div class="detail-kv"><span class="dk">Worst Category</span><span class="dv">${escapeHtml(bs.worstCategory || '--')}</span></div>
                        <div class="detail-kv"><span class="dk">Total Tests</span><span class="dv">${bs.totalTests || 0}</span></div>
                        <div class="detail-kv"><span class="dk">Last Benchmarked</span><span class="dv">${bs.lastBenchmarked ? new Date(bs.lastBenchmarked).toLocaleDateString() : '--'}</span></div>
                    </div>
                </div>
            `);
        }

        // Routing Rules
        const rr = m.routingRules;
        if (rr && (rr.preferredFor?.length || rr.avoidFor?.length)) {
            sections.push(`
                <div class="detail-section">
                    <h3><i class="fas fa-route"></i> Routing Rules</h3>
                    ${rr.preferredFor?.length ? `<div class="detail-kv"><span class="dk">Preferred For</span><span class="dv">${rr.preferredFor.map(t => `<span class="micro-tag" style="background:rgba(34,197,94,0.15); color:#4ade80;">${escapeHtml(t)}</span>`).join(' ')}</span></div>` : ''}
                    ${rr.avoidFor?.length ? `<div class="detail-kv"><span class="dk">Avoid For</span><span class="dv">${rr.avoidFor.map(t => `<span class="micro-tag" style="background:rgba(239,68,68,0.15); color:#f87171;">${escapeHtml(t)}</span>`).join(' ')}</span></div>` : ''}
                    <div class="detail-kv"><span class="dk">Priority</span><span class="dv">${rr.priority || 5}</span></div>
                </div>
            `);
        }

        // Execution Config
        const ed = m.executionDefaults;
        const eo = m.executionOverrides;
        if (ed || eo) {
            sections.push(`
                <div class="detail-section">
                    <h3><i class="fas fa-sliders-h"></i> Execution Config</h3>
                    <div class="detail-grid">
                        <div class="detail-kv"><span class="dk">num_ctx (default)</span><span class="dv">${ed?.num_ctx || 'auto'}</span></div>
                        <div class="detail-kv"><span class="dk">temperature (default)</span><span class="dv">${ed?.temperature ?? 'auto'}</span></div>
                        ${eo?.num_ctx ? `<div class="detail-kv"><span class="dk">num_ctx (override)</span><span class="dv" style="color:#fbbf24;">${eo.num_ctx}</span></div>` : ''}
                        ${eo?.temperature != null ? `<div class="detail-kv"><span class="dk">temperature (override)</span><span class="dv" style="color:#fbbf24;">${eo.temperature}</span></div>` : ''}
                    </div>
                    <button class="btn-secondary-sm" style="margin-top:8px;" onclick="if(window.modelExecutionConfig) window.modelExecutionConfig.open('${escapeHtml(m.name)}');">
                        <i class="fas fa-cog"></i> Edit Config
                    </button>
                </div>
            `);
        }

        // Quick actions
        sections.push(`
            <div class="detail-section detail-actions">
                <button class="btn-primary" onclick="startChat('${escapeHtml(m.name)}')"><i class="fas fa-comment-alt"></i> Chat</button>
                <button class="btn-secondary" onclick="if(window.modelExecutionConfig) window.modelExecutionConfig.open('${escapeHtml(m.name)}')"><i class="fas fa-sliders-h"></i> Config</button>
            </div>
        `);

        return sections.join('');
    }

    /* ── Comparison ─────────────────────────────────────── */
    toggleCompare(model) {
        const id = model.id || model.name;
        if (this.comparisonList.has(id)) {
            this.comparisonList.delete(id);
        } else {
            if (this.comparisonList.size >= 4) { alert('Max 4 models'); return; }
            this.comparisonList.add(id);
        }
        this.renderComparisonDrawer();
        this.renderTable();
    }

    getSelectedModels() {
        return Array.from(this.comparisonList)
            .map(id => this.allModels.find(model => (model.id || model.name) === id))
            .filter(Boolean);
    }

    renderComparisonDrawer() {
        if (!this.compareDrawer || !this.compareListEl || !this.compareContentEl) return;

        const selectedModels = this.getSelectedModels();
        const count = selectedModels.length;
        const compareCountEl = document.getElementById('compareCount');
        const clearBtn = document.getElementById('clearCompare');

        if (compareCountEl) compareCountEl.innerText = count;
        if (clearBtn) clearBtn.hidden = count === 0;

        if (count === 0) {
            this.compareDrawer.hidden = true;
            this.compareListEl.innerHTML = '';
            this.compareContentEl.innerHTML = '';
            if (this.compareSubtitleEl) {
                this.compareSubtitleEl.textContent = 'Select one model for details or 2-4 to compare automatically.';
            }
            return;
        }

        this.compareDrawer.hidden = false;
        if (this.compareSubtitleEl) {
            this.compareSubtitleEl.textContent = count === 1
                ? 'Single selection shows a quick model detail view.'
                : 'Comparison updates automatically as you add or remove models.';
        }

        this.compareListEl.innerHTML = selectedModels.map(model => {
            const host = model.source?.hostName || model.provider || 'Unknown source';
            const params = model.details?.parameter_size || model.parameterSize || model.parameters || '--';
            return `
                <div class="compare-chip">
                    <span>${escapeHtml(model.name)}</span>
                    <span class="compare-chip-meta">${escapeHtml(host)} · ${escapeHtml(params)}</span>
                    <button
                        type="button"
                        class="compare-chip-remove"
                        data-model-id="${escapeHtml(model.id || model.name)}"
                        aria-label="Remove ${escapeHtml(model.name)} from selection"
                        title="Remove ${escapeHtml(model.name)}"
                    >
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            `;
        }).join('');

        this.compareListEl.querySelectorAll('.compare-chip-remove').forEach(button => {
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                const modelId = event.currentTarget.dataset.modelId;
                if (!modelId) return;
                const selectedModel = this.allModels.find(model => (model.id || model.name) === modelId);
                if (selectedModel) this.toggleCompare(selectedModel);
            });
        });

        this.comparator?.renderSelection(selectedModels);
    }

    /* ── Stat Popout Drawer ──────────────────────────────── */
    setupStatPopouts() {
        const close = () => this.closeStatPopout();
        document.getElementById('closeStatPopout')?.addEventListener('click', close);
        document.getElementById('statPopoutBackdrop')?.addEventListener('click', close);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.getElementById('statPopoutDrawer')?.classList.contains('open')) {
                close();
                e.stopImmediatePropagation();
            }
        });

        document.getElementById('statTotalCard')?.addEventListener('click', () => this.showTotalPopout());
        document.getElementById('statStorageCard')?.addEventListener('click', () => this.showStoragePopout());
        document.getElementById('statHostsCard')?.addEventListener('click', () => this.showHostsPopout());
        document.getElementById('statBenchmarkedCard')?.addEventListener('click', () => this.showBenchmarkPopout());
    }

    openStatPopout(title, html) {
        const drawer = document.getElementById('statPopoutDrawer');
        const backdrop = document.getElementById('statPopoutBackdrop');
        document.getElementById('statPopoutTitle').textContent = title;
        document.getElementById('statPopoutBody').innerHTML = html;
        drawer?.classList.add('open');
        backdrop?.classList.add('open');
        document.body.style.overflow = 'hidden';
    }

    closeStatPopout() {
        document.getElementById('statPopoutDrawer')?.classList.remove('open');
        document.getElementById('statPopoutBackdrop')?.classList.remove('open');
        document.body.style.overflow = '';
    }

    /* ── Total Models Popout ───────────────────────────── */
    showTotalPopout() { showTotalPopout(this); }

    /* ── Storage Popout ────────────────────────────────── */
    showStoragePopout() { showStoragePopout(this); }

    /* ── Hosts Popout ──────────────────────────────────── */
    showHostsPopout() { showHostsPopout(this); }

    /* ── Benchmark Popout ──────────────────────────────── */
    showBenchmarkPopout() { showBenchmarkPopout(this); }
}

function startChat(modelName) {
    window.location.href = `/chat?model=${encodeURIComponent(modelName)}`;
}

document.addEventListener('DOMContentLoaded', () => {
    window.unifiedModels = new UnifiedModels();
});
