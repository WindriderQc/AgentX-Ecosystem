/**
 * Models Unified — Stat Popout Drawers
 *
 * Extracted from models-unified.js for file-size discipline.
 * Depends on globals defined in models-unified.js (loaded first):
 *   escapeHtml, scoreColor, CAT_COLORS
 * Each function receives the UnifiedModels instance as `self`.
 */

function showTotalPopout(self) {
    const active = self.getActiveModels();
    const gone = self.getGoneModels();
    if (!active.length && !gone.length) {
        self.openStatPopout('Total Models', '<div class="popout-empty"><i class="fas fa-cubes"></i><div>No models found</div><div class="popout-muted">Models will appear here after sources sync.</div></div>');
        return;
    }

    // By provider
    const providers = {};
    for (const m of active) {
        const p = m.provider || 'unknown';
        providers[p] = (providers[p] || 0) + 1;
    }

    // By category
    const catCounts = {};
    for (const m of active) {
        for (const c of (m.categories || [])) {
            catCounts[c] = (catCounts[c] || 0) + 1;
        }
    }
    const catSorted = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);

    // By host
    const hostCounts = self.getHostSummaries().map(host => [host.name, host.models.length]);

    const html = `
        <div class="popout-summary-grid">
            <div class="popout-summary-card">
                <span class="popout-summary-label">Active</span>
                <span class="popout-summary-value">${active.length}</span>
            </div>
            <div class="popout-summary-card">
                <span class="popout-summary-label">Gone</span>
                <span class="popout-summary-value">${gone.length}</span>
            </div>
            <div class="popout-summary-card">
                <span class="popout-summary-label">Providers</span>
                <span class="popout-summary-value">${Object.keys(providers).length}</span>
            </div>
        </div>
        <div class="popout-section">
            <h3 class="popout-heading"><i class="fas fa-layer-group"></i> By Provider</h3>
            <div class="popout-bar-list">
                ${Object.entries(providers).map(([p, c]) => `
                    <div class="popout-bar-row">
                        <span class="popout-bar-label">${escapeHtml(p)}</span>
                        <div class="popout-bar"><div class="popout-bar-fill" style="width:${(c / active.length * 100).toFixed(0)}%; background:var(--accent);"></div></div>
                        <span class="popout-bar-value">${c}</span>
                    </div>
                `).join('')}
            </div>
        </div>
        <div class="popout-section">
            <h3 class="popout-heading"><i class="fas fa-server"></i> By Host</h3>
            <div class="popout-bar-list">
                ${hostCounts.map(([h, c]) => `
                    <div class="popout-bar-row">
                        <span class="popout-bar-label">${escapeHtml(h)}</span>
                        <div class="popout-bar"><div class="popout-bar-fill" style="width:${(c / active.length * 100).toFixed(0)}%; background:#fb923c;"></div></div>
                        <span class="popout-bar-value">${c}</span>
                    </div>
                `).join('')}
            </div>
        </div>
        <div class="popout-section">
            <h3 class="popout-heading"><i class="fas fa-tags"></i> By Category</h3>
            <div class="popout-bar-list">
                ${catSorted.map(([cat, c]) => {
                    const col = CAT_COLORS[cat] || CAT_COLORS.generalist;
                    return `
                    <div class="popout-bar-row">
                        <span class="popout-bar-label"><span class="cat-badge" style="background:${col.bg}; border-color:${col.border}; color:${col.text};">${escapeHtml(cat)}</span></span>
                        <div class="popout-bar"><div class="popout-bar-fill" style="width:${(c / active.length * 100).toFixed(0)}%; background:${col.border};"></div></div>
                        <span class="popout-bar-value">${c}</span>
                    </div>`;
                }).join('')}
            </div>
        </div>
        ${gone.length ? `
        <div class="popout-section">
            <h3 class="popout-heading"><i class="fas fa-ghost"></i> Guest Book (${gone.length} removed)</h3>
            <div class="popout-model-list">
                ${gone.slice(0, 15).map(m => `
                    <div class="popout-model-row gone">
                        <span>${escapeHtml(m.name)}</span>
                        <span class="popout-muted">${escapeHtml(m.source?.hostName || '--')}</span>
                    </div>
                `).join('')}
                ${gone.length > 15 ? `<div class="popout-muted" style="text-align:center; padding:8px;">+${gone.length - 15} more</div>` : ''}
            </div>
        </div>` : ''}
    `;
    self.openStatPopout(`Total Models: ${active.length}${gone.length ? ' + ' + gone.length + ' gone' : ''}`, html);
}

function showStoragePopout(self) {
    const active = self.getActiveModels();
    if (!active.length) {
        self.openStatPopout('Storage', '<div class="popout-empty"><i class="fas fa-hdd"></i><div>No storage to report</div><div class="popout-muted">Add or sync models to populate storage stats.</div></div>');
        return;
    }

    // By host
    const hostStorage = {};
    for (const m of active) {
        if (m.provider !== 'ollama') continue;
        const h = m.source?.hostName || 'Unknown';
        hostStorage[h] = (hostStorage[h] || 0) + (m.size || 0);
    }
    const totalBytes = active.reduce((s, m) => s + (m.size || 0), 0);

    // Top 10 largest
    const sorted = [...active].filter(m => m.size > 0).sort((a, b) => b.size - a.size).slice(0, 10);
    const maxSize = sorted[0]?.size || 1;

    const html = `
        <div class="popout-summary-grid">
            <div class="popout-summary-card">
                <span class="popout-summary-label">Tracked Storage</span>
                <span class="popout-summary-value">${self.formatBytes(totalBytes)}</span>
            </div>
            <div class="popout-summary-card">
                <span class="popout-summary-label">Hosts</span>
                <span class="popout-summary-value">${Object.keys(hostStorage).length}</span>
            </div>
            <div class="popout-summary-card">
                <span class="popout-summary-label">Largest Model</span>
                <span class="popout-summary-value">${sorted[0] ? self.formatBytes(sorted[0].size) : '--'}</span>
            </div>
        </div>
        <div class="popout-section">
            <h3 class="popout-heading"><i class="fas fa-database"></i> By Host</h3>
            <div class="popout-bar-list">
                ${Object.entries(hostStorage).sort((a,b) => b[1]-a[1]).map(([h, s]) => `
                    <div class="popout-bar-row">
                        <span class="popout-bar-label">${escapeHtml(h)}</span>
                        <div class="popout-bar"><div class="popout-bar-fill" style="width:${(s / totalBytes * 100).toFixed(0)}%; background:#a78bfa;"></div></div>
                        <span class="popout-bar-value">${self.formatBytes(s)}</span>
                    </div>
                `).join('')}
            </div>
        </div>
        <div class="popout-section">
            <h3 class="popout-heading"><i class="fas fa-weight-hanging"></i> Top 10 Largest</h3>
            <div class="popout-bar-list">
                ${sorted.map(m => `
                    <div class="popout-bar-row">
                        <span class="popout-bar-label">${escapeHtml(m.name)}</span>
                        <div class="popout-bar"><div class="popout-bar-fill" style="width:${(m.size / maxSize * 100).toFixed(0)}%; background:#eeb0ff;"></div></div>
                        <span class="popout-bar-value">${self.formatBytes(m.size)}</span>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
    self.openStatPopout(`Storage: ${self.formatBytes(totalBytes)}`, html);
}

function showHostsPopout(self) {
    const active = self.getActiveModels();
    const ollamaHosts = self.getHostSummaries();

    const hostCards = ollamaHosts.map((host) => {
        const statusColor = host.status === 'online' ? '#22c55e' : host.status === 'offline' ? '#ef4444' : '#94a3b8';
        const statusIcon = host.status === 'online' ? 'fa-circle-check' : host.status === 'offline' ? 'fa-circle-xmark' : 'fa-circle-question';
        const metaBits = [host.gpu];
        if (host.vramGb) metaBits.push(`${host.vramGb} GB VRAM`);
        if (host.url) metaBits.push(host.url.replace(/^https?:\/\//, ''));

        return `
            <div class="popout-host-card">
                <div class="popout-host-header">
                    <div>
                        <div class="popout-host-name">${escapeHtml(host.name)}</div>
                        <div class="popout-host-meta">${escapeHtml(metaBits.join(' · '))}</div>
                    </div>
                    <div class="popout-host-status">
                        <i class="fas ${statusIcon}" style="color:${statusColor};"></i>
                        <span style="color:${statusColor}; font-weight:600; text-transform:capitalize;">${host.status}</span>
                    </div>
                </div>
                <div class="popout-host-stats">
                    <div class="popout-host-stat">
                        <span class="popout-host-stat-val">${host.models.length}</span>
                        <span class="popout-host-stat-lbl">Models</span>
                    </div>
                    <div class="popout-host-stat">
                        <span class="popout-host-stat-val">${self.formatBytes(host.totalSize)}</span>
                        <span class="popout-host-stat-lbl">Storage</span>
                    </div>
                    <div class="popout-host-stat">
                        <span class="popout-host-stat-val" style="color:#22c55e;">${host.loadedModels.length}</span>
                        <span class="popout-host-stat-lbl">Loaded</span>
                    </div>
                </div>
                ${host.loadedModels.length ? `
                    <div class="popout-host-loaded">
                        <div class="popout-sub-heading"><i class="fas fa-bolt" style="color:#22c55e;"></i> Loaded in VRAM</div>
                        <div class="popout-model-chips">
                            ${host.loadedModels.map(model => `<span class="popout-model-chip loaded">${escapeHtml(model.name)}</span>`).join('')}
                        </div>
                    </div>
                ` : ''}
                <div class="popout-host-models">
                    <div class="popout-sub-heading"><i class="fas fa-hard-drive"></i> Installed (${host.idleModels.length})</div>
                    <div class="popout-model-chips">
                        ${host.idleModels.slice(0, 12).map(model => `<span class="popout-model-chip">${escapeHtml(model.name)}</span>`).join('')}
                        ${host.idleModels.length > 12 ? `<span class="popout-model-chip more">+${host.idleModels.length - 12}</span>` : ''}
                        ${!host.models.length ? '<span class="popout-muted">No active models on this host.</span>' : ''}
                    </div>
                </div>
            </div>
        `;
    }).join('');

    const customModels = active.filter(m => m.provider === 'custom');
    const otherSection = customModels.length ? `
        <div class="popout-section">
            <h3 class="popout-heading"><i class="fas fa-plug-circle-bolt"></i> Other Providers</h3>
                            ${customModels.length ? `
                <div class="popout-sub-heading"><i class="fas fa-cube"></i> Custom (${customModels.length})</div>
                <div class="popout-model-chips">
                    ${customModels.map(m => `<span class="popout-model-chip">${escapeHtml(m.name)}</span>`).join('')}
                </div>
            ` : ''}
        </div>
    ` : '';

    const summaryHtml = `
        <div class="popout-summary-grid">
            <div class="popout-summary-card">
                <span class="popout-summary-label">Ollama Hosts</span>
                <span class="popout-summary-value">${ollamaHosts.length}</span>
            </div>
            <div class="popout-summary-card">
                <span class="popout-summary-label">Online</span>
                <span class="popout-summary-value">${ollamaHosts.filter(host => host.status === 'online').length}</span>
            </div>
            <div class="popout-summary-card">
                <span class="popout-summary-label">Loaded Models</span>
                <span class="popout-summary-value">${ollamaHosts.reduce((sum, host) => sum + host.loadedModels.length, 0)}</span>
            </div>
        </div>
    `;

    self.openStatPopout(
        'Hosts',
        summaryHtml +
        (hostCards ? `<div class="popout-host-grid">${hostCards}</div>` : '<div class="popout-empty"><i class="fas fa-server"></i><div>No Ollama hosts found</div><div class="popout-muted">Configured or discovered hosts will appear here.</div></div>') +
        otherSection
    );
}

function showBenchmarkPopout(self) {
    const benchmarked = self.allModels.filter(m => m.benchmarkStats?.avgCompositeScore > 0);
    const unbenchmarked = self.allModels.filter(m => !m.benchmarkStats?.avgCompositeScore && m.deployment?.status !== 'gone');

    if (!benchmarked.length) {
        self.openStatPopout('Benchmarks', '<div class="popout-empty"><i class="fas fa-flask-vial" style="font-size:32px; opacity:0.3;"></i><div>No models benchmarked yet</div><div class="popout-muted">Run benchmarks from the Benchmark page</div></div>');
        return;
    }

    // Top performers
    const top = [...benchmarked].sort((a, b) => b.benchmarkStats.avgCompositeScore - a.benchmarkStats.avgCompositeScore);
    const maxScore = top[0]?.benchmarkStats.avgCompositeScore || 100;

    // Score distribution buckets
    const buckets = { '80-100': 0, '60-79': 0, '40-59': 0, '0-39': 0 };
    for (const m of benchmarked) {
        const s = m.benchmarkStats.avgCompositeScore;
        if (s >= 80) buckets['80-100']++;
        else if (s >= 60) buckets['60-79']++;
        else if (s >= 40) buckets['40-59']++;
        else buckets['0-39']++;
    }
    const bucketColors = { '80-100': '#22c55e', '60-79': '#3b82f6', '40-59': '#f59e0b', '0-39': '#ef4444' };

    // By category performance
    const catScores = {};
    for (const m of benchmarked) {
        for (const c of (m.categories || [])) {
            if (!catScores[c]) catScores[c] = [];
            catScores[c].push(m.benchmarkStats.avgCompositeScore);
        }
    }
    const catAvgs = Object.entries(catScores).map(([cat, scores]) => ({
        cat, avg: scores.reduce((s, v) => s + v, 0) / scores.length, count: scores.length
    })).sort((a, b) => b.avg - a.avg);

    const avg = benchmarked.reduce((s, m) => s + m.benchmarkStats.avgCompositeScore, 0) / benchmarked.length;

    const html = `
        <div class="popout-summary-grid">
            <div class="popout-summary-card">
                <span class="popout-summary-label">Benchmarked</span>
                <span class="popout-summary-value">${benchmarked.length}</span>
            </div>
            <div class="popout-summary-card">
                <span class="popout-summary-label">Average Score</span>
                <span class="popout-summary-value">${avg.toFixed(1)}</span>
            </div>
            <div class="popout-summary-card">
                <span class="popout-summary-label">Pending</span>
                <span class="popout-summary-value">${unbenchmarked.length}</span>
            </div>
        </div>
        <div class="popout-section">
            <h3 class="popout-heading"><i class="fas fa-chart-simple"></i> Score Distribution</h3>
            <div class="popout-bar-list">
                ${Object.entries(buckets).map(([range, count]) => `
                    <div class="popout-bar-row">
                        <span class="popout-bar-label" style="color:${bucketColors[range]};">${range}</span>
                        <div class="popout-bar"><div class="popout-bar-fill" style="width:${(count / benchmarked.length * 100).toFixed(0)}%; background:${bucketColors[range]};"></div></div>
                        <span class="popout-bar-value">${count}</span>
                    </div>
                `).join('')}
            </div>
        </div>
        <div class="popout-section">
            <h3 class="popout-heading"><i class="fas fa-trophy"></i> Top Performers</h3>
            <div class="popout-bar-list">
                ${top.slice(0, 10).map((m, i) => {
                    const s = m.benchmarkStats.avgCompositeScore;
                    const color = scoreColor(s);
                    const medal = i === 0 ? '<i class="fas fa-crown" style="color:#fbbf24; margin-right:4px;"></i>' : '';
                    const isGone = m.deployment?.status === 'gone';
                    return `
                    <div class="popout-bar-row${isGone ? ' gone' : ''}">
                        <span class="popout-bar-label">${medal}${escapeHtml(m.name)}${isGone ? ' <i class="fas fa-ghost" style="font-size:10px; opacity:0.5;"></i>' : ''}</span>
                        <div class="popout-bar"><div class="popout-bar-fill" style="width:${(s / maxScore * 100).toFixed(0)}%; background:${color};"></div></div>
                        <span class="popout-bar-value" style="color:${color}; font-weight:700;">${s.toFixed(1)}</span>
                    </div>`;
                }).join('')}
            </div>
        </div>
        ${catAvgs.length ? `
        <div class="popout-section">
            <h3 class="popout-heading"><i class="fas fa-tags"></i> Average by Category</h3>
            <div class="popout-bar-list">
                ${catAvgs.map(({ cat, avg: cavg, count }) => {
                    const col = CAT_COLORS[cat] || CAT_COLORS.generalist;
                    return `
                    <div class="popout-bar-row">
                        <span class="popout-bar-label"><span class="cat-badge" style="background:${col.bg}; border-color:${col.border}; color:${col.text};">${escapeHtml(cat)}</span> <span class="popout-muted">(${count})</span></span>
                        <div class="popout-bar"><div class="popout-bar-fill" style="width:${(cavg / 100 * 100).toFixed(0)}%; background:${col.border};"></div></div>
                        <span class="popout-bar-value">${cavg.toFixed(1)}</span>
                    </div>`;
                }).join('')}
            </div>
        </div>` : ''}
        ${unbenchmarked.length ? `
        <div class="popout-section">
            <h3 class="popout-heading"><i class="fas fa-circle-question"></i> Not Yet Benchmarked (${unbenchmarked.length})</h3>
            <div class="popout-model-chips">
                ${unbenchmarked.slice(0, 15).map(m => `<span class="popout-model-chip">${escapeHtml(m.name)}</span>`).join('')}
                ${unbenchmarked.length > 15 ? `<span class="popout-model-chip more">+${unbenchmarked.length - 15}</span>` : ''}
            </div>
        </div>` : ''}
    `;
    self.openStatPopout(`Benchmarks — Avg ${avg.toFixed(1)}`, html);
}
