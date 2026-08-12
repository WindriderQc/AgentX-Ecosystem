        // Helper: JSON request headers
        function jsonHeaders() {
            return { 'Content-Type': 'application/json' };
        }

        // Performance Dashboard Controller
        const PerformanceDashboard = {
            // State
            charts: {},
            data: {},
            refreshInterval: null,
            autoRefreshEnabled: false,
            refreshCountdown: 60,
            currentTimeRange: 24,
            currentEndpoint: '',
            sortColumn: null,
            sortDirection: 'desc',

            // Initialization
            async init() {
                console.log('Initializing Performance Dashboard...');
                this.bindEvents();
                await this.loadAll();
                this.startRefreshCountdown();
            },

            // Load dashboard stats
            async loadDashboard() {
                try {
                    const response = await fetch(`/api/performance/dashboard?hours=${this.currentTimeRange}`, {
                        headers: jsonHeaders()
                    });
                    const result = await response.json();
                    if (result.status === 'success' && result.data) {
                        this.updateStatsCards(result.data);
                    }
                } catch (err) {
                    console.error('Failed to load dashboard:', err);
                }
            },

            // Load all data
            async loadAll() {
                await Promise.all([
                    this.loadDashboard(),
                    this.loadLatencyTrends(),
                    this.loadPercentiles(),
                    this.loadThroughput(),
                    this.loadLoadTests(),
                    this.loadBaselines(),
                    this.populateEndpointFilter()
                ]);
            },

            // Bind event listeners
            bindEvents() {
                // Header controls
                document.getElementById('refreshBtn').addEventListener('click', () => this.loadAll());
                document.getElementById('timeRangeSelect').addEventListener('change', (e) => {
                    this.currentTimeRange = parseInt(e.target.value);
                    this.loadAll();
                });
                document.getElementById('endpointFilter').addEventListener('change', (e) => {
                    this.currentEndpoint = e.target.value;
                    this.loadLatencyTrends();
                    this.loadThroughput();
                });
                document.getElementById('autoRefreshToggle').addEventListener('change', (e) => {
                    this.autoRefreshEnabled = e.target.checked;
                    if (this.autoRefreshEnabled) {
                        this.startAutoRefresh();
                    } else {
                        this.stopAutoRefresh();
                    }
                });

                // Import test button
                document.getElementById('importTestBtn').addEventListener('click', () => {
                    document.getElementById('importTestModal').classList.add('active');
                });
                document.getElementById('cancelImportBtn').addEventListener('click', () => {
                    document.getElementById('importTestModal').classList.remove('active');
                });
                document.getElementById('importTestForm').addEventListener('submit', (e) => {
                    e.preventDefault();
                    this.importLoadTest();
                });

                // Create baseline button
                document.getElementById('createBaselineBtn').addEventListener('click', () => {
                    this.openCreateBaselineModal();
                });
                document.getElementById('cancelBaselineBtn').addEventListener('click', () => {
                    document.getElementById('createBaselineModal').classList.remove('active');
                });
                document.getElementById('createBaselineForm').addEventListener('submit', (e) => {
                    e.preventDefault();
                    this.createBaseline();
                });
                document.getElementById('baselineSource').addEventListener('change', (e) => {
                    const loadTestGroup = document.getElementById('loadTestSelectGroup');
                    loadTestGroup.style.display = e.target.value === 'loadtest' ? 'block' : 'none';
                });

                // Close modals on overlay click
                document.querySelectorAll('.modal-overlay').forEach(overlay => {
                    overlay.addEventListener('click', (e) => {
                        if (e.target === overlay) {
                            overlay.classList.remove('active');
                        }
                    });
                });
            },



            // Update stats cards
            updateStatsCards(data) {
                const statusBadge = document.getElementById('systemStatus');
                const status = data.system_health || 'unknown';
                statusBadge.className = `badge ${status}`;
                statusBadge.textContent = status.charAt(0).toUpperCase() + status.slice(1);

                const metrics = data.metrics_24h || {};
                const trends = data.trends || {};

                const avgTime = Number(metrics.avg_latency || 0);
                document.getElementById('avgResponseTime').textContent = `${avgTime.toFixed(0)}ms`;
                this.updateTrend('responseTrend', trends.avg_latency_pct);

                const throughput = Number(metrics.throughput_rps || 0);
                document.getElementById('throughput').textContent = throughput.toFixed(1);
                this.updateTrend('throughputTrend', trends.throughput_pct);

                const errorRate = Number(metrics.error_rate || 0);
                const errorEl = document.getElementById('errorRate');
                errorEl.textContent = `${errorRate.toFixed(2)}%`;
                errorEl.style.color = errorRate > 5 ? '#ef4444' : errorRate > 1 ? '#fbbf24' : 'inherit';
                this.updateTrend('errorTrend', trends.error_rate_pct);

                const uptime = Number(metrics.uptime_percent || 0);
                document.getElementById('uptime').textContent = `${uptime.toFixed(2)}%`;

                const p95 = Number(metrics.p95_latency || 0);
                document.getElementById('p95Latency').textContent = `${p95.toFixed(0)}ms`;
                this.updateTrend('p95Trend', trends.p95_latency_pct);

                // Sources / provenance indicator
                const indicator = document.getElementById('sourcesIndicator');
                if (indicator) {
                    const src = data.sources || {};

                    const prod = src.production || {};
                    const prodParts = [
                        `Production snapshots (hourly, last ${prod.hours || this.currentTimeRange}h)`
                    ];
                    if (Number.isFinite(prod.snapshots)) prodParts.push(`${prod.snapshots} snapshots`);
                    if (Number.isFinite(prod.total_requests)) prodParts.push(`${prod.total_requests} req`);
                    if (prod.last_snapshot_hour) prodParts.push(`last ${new Date(prod.last_snapshot_hour).toLocaleString()}`);

                    const breakdown = prod.breakdown || {};
                    const breakdownParts = [];
                    if (Number.isFinite(breakdown.api_requests)) breakdownParts.push(`API ${breakdown.api_requests}`);
                    if (Number.isFinite(breakdown.non_api_requests)) breakdownParts.push(`Non‑API ${breakdown.non_api_requests}`);
                    if (Number.isFinite(breakdown.total_endpoint_requests)) breakdownParts.push(`Total ${breakdown.total_endpoint_requests}`);
                    const delta = Number(breakdown.delta_vs_total_requests);
                    if (Number.isFinite(delta) && delta !== 0) {
                        const sign = delta > 0 ? '+' : '';
                        breakdownParts.push(`Δ ${sign}${delta}`);
                    }
                    const breakdownText = breakdownParts.length
                        ? `Breakdown: ${breakdownParts.join(' • ')}${(Number.isFinite(delta) && delta !== 0) ? ' (endpoint rollup vs total req)' : ''}`
                        : '';

                    const categoryLabel = (key) => {
                        switch (key) {
                            case 'chat': return 'Chat';
                            case 'conversations': return 'Conversations';
                            case 'history': return 'History';
                            case 'rag': return 'RAG/Search';
                            case 'batch_workflows': return 'Batch/Workflows';
                            case 'auth': return 'Auth';
                            case 'alerts': return 'Alerts';
                            case 'metrics': return 'Metrics';
                            case 'admin': return 'Admin';
                            case 'other_api': return 'Other API';
                            case 'batch_ui': return 'Batch (UI)';
                            case 'ui_pages': return 'UI Pages';
                            case 'ui_performance': return 'Performance UI';
                            case 'other_non_api': return 'Other Non‑API';
                            default: return key;
                        }
                    };

                    const categoryRows = Array.isArray(prod.category_breakdown) ? prod.category_breakdown : [];
                    const categoryText = categoryRows.length
                        ? `Categories: ${categoryRows
                            .filter(r => r && typeof r.category === 'string')
                            .slice(0, 6)
                            .map(r => {
                                const count = Number(r.count || 0);
                                const err = Number(r.error_rate || 0);
                                const lat = Number(r.avg_latency || 0);
                                const extras = [];
                                if (Number.isFinite(err) && err > 0) extras.push(`${err.toFixed(2)}% err`);
                                if (Number.isFinite(lat) && lat > 0) extras.push(`${lat.toFixed(0)}ms avg`);
                                return `${categoryLabel(r.category)} ${count}${extras.length ? ` (${extras.join(', ')})` : ''}`;
                            })
                            .join(' • ')}`
                        : '';

                    const hotspots = [];
                    for (const r of categoryRows) {
                        if (!r || typeof r.category !== 'string') continue;
                        const err = Number(r.error_rate || 0);
                        const lat = Number(r.avg_latency || 0);
                        const count = Number(r.count || 0);
                        if (!Number.isFinite(count) || count <= 0) continue;
                        if ((Number.isFinite(err) && err >= 2) || (Number.isFinite(lat) && lat >= 250)) {
                            const parts = [];
                            if (Number.isFinite(err) && err >= 2) parts.push(`${err.toFixed(2)}% err`);
                            if (Number.isFinite(lat) && lat >= 250) parts.push(`${lat.toFixed(0)}ms avg`);
                            hotspots.push(`${categoryLabel(r.category)} (${parts.join(', ')})`);
                        }
                    }

                    const top = Array.isArray(prod.top_endpoints) ? prod.top_endpoints : [];
                    const topText = top.length
                        ? `Top: ${top.map(e => {
                            const err = Number(e.error_rate || 0);
                            const lat = Number(e.avg_latency || 0);
                            const extras = [];
                            if (Number.isFinite(err) && err > 0) extras.push(`${err.toFixed(2)}% err`);
                            if (Number.isFinite(lat) && lat > 0) extras.push(`${lat.toFixed(0)}ms avg`);
                            return `${e.method} ${e.path} (${e.count}${extras.length ? `, ${extras.join(', ')}` : ''})`;
                        }).join(' • ')}`
                        : '';

                    const topErrors = Array.isArray(prod.top_error_endpoints) ? prod.top_error_endpoints : [];
                    const topErrorsText = topErrors.length
                        ? `Top errors: ${topErrors.map(e => {
                            const err = Number(e.error_rate || 0);
                            const count = Number(e.count || 0);
                            const extra = Number.isFinite(err) ? `${err.toFixed(2)}%` : '0%';
                            return `${e.method} ${e.path} (${extra}, ${count})`;
                        }).join(' • ')}`
                        : '';

                    const topSlow = Array.isArray(prod.top_slow_endpoints) ? prod.top_slow_endpoints : [];
                    const topSlowText = topSlow.length
                        ? `Top slow: ${topSlow.map(e => {
                            const lat = Number(e.avg_latency || 0);
                            const count = Number(e.count || 0);
                            return `${e.method} ${e.path} (${lat.toFixed(0)}ms, ${count})`;
                        }).join(' • ')}`
                        : '';

                    const hotspotText = hotspots.length ? `Hotspots: ${hotspots.slice(0, 4).join(' • ')}` : '';

                    const legendParts = [
                        'Legend: API = /api/*',
                        'Batch (UI) = /batch/*',
                        'UI Pages = /dashboard, /active-stats',
                        'Δ = endpoint rollup − total req'
                    ];
                    const legendText = legendParts.join(' • ');

                    const loadTest = src.latest_load_test;
                    const loadTestText = loadTest
                        ? `Latest load test: ${loadTest.scenario || loadTest.name || '—'} (${new Date(loadTest.timestamp).toLocaleString()})`
                        : 'Latest load test: none';

                    const baseline = src.active_baseline;
                    const baselineText = baseline
                        ? `Active baseline: ${baseline.name}`
                        : 'Active baseline: none';

                    const scopeText = src.tracking_scope
                        ? `Tracking scope: ${src.tracking_scope}`
                        : 'Tracking scope: non-static, non-health HTTP requests';

                    const extraLines = [breakdownText, categoryText, hotspotText, topText, topErrorsText, topSlowText, legendText].filter(Boolean);
                    const extraHtml = extraLines.length ? `<br>${extraLines.join('<br>')}` : '';

                    indicator.innerHTML = `<strong>Sources:</strong> ${prodParts.join(' • ')}<br>${loadTestText} • ${baselineText}${extraHtml}<br>${scopeText}`;
                }
            },

            // Update trend indicator
            updateTrend(elementId, trend) {
                const el = document.getElementById(elementId);
                if (!el) return;
                // null == no comparable prior window; render nothing rather than a fake 0%.
                if (trend === undefined || trend === null) {
                    el.innerHTML = '';
                    el.className = 'trend';
                    return;
                }

                if (trend > 0) {
                    el.innerHTML = `<i class="fas fa-arrow-up"></i> ${Math.abs(trend).toFixed(1)}%`;
                    el.className = 'trend up';
                } else if (trend < 0) {
                    el.innerHTML = `<i class="fas fa-arrow-down"></i> ${Math.abs(trend).toFixed(1)}%`;
                    el.className = 'trend down';
                } else {
                    el.innerHTML = '<i class="fas fa-minus"></i> 0%';
                    el.className = 'trend';
                }
            },

            // Load latency trends
            async loadLatencyTrends() {
                try {
                    const params = new URLSearchParams({
                        hours: this.currentTimeRange
                    });
                    if (this.currentEndpoint) {
                        params.append('endpoint', this.currentEndpoint);
                    }

                    const response = await fetch(`/api/performance/latency-trends?${params}`, {
                        headers: jsonHeaders()
                    });
                    const result = await response.json();

                    const trends = result?.data?.trends || [];
                    if (result.status === 'success' && Array.isArray(trends) && trends.length > 0) {
                        this.renderLatencyTrendChart(trends);
                        document.getElementById('latencyTrendsEmpty').classList.remove('visible');
                    } else {
                        document.getElementById('latencyTrendsEmpty').classList.add('visible');
                    }
                } catch (err) {
                    console.error('Failed to load latency trends:', err);
                    document.getElementById('latencyTrendsEmpty').classList.add('visible');
                }
            },


            // Load percentiles
            async loadPercentiles() {
                try {
                    const params = new URLSearchParams({
                        hours: this.currentTimeRange
                    });
                    if (this.currentEndpoint) {
                        params.append('endpoint', this.currentEndpoint);
                    }

                    const response = await fetch(`/api/performance/percentiles?${params}`, {
                        headers: jsonHeaders()
                    });
                    const result = await response.json();

                    const percentiles = result?.data?.percentiles || result?.data;
                    if (result.status === 'success' && percentiles) {
                        this.renderPercentileChart(percentiles);
                        document.getElementById('percentileEmpty').classList.remove('visible');
                    } else {
                        document.getElementById('percentileEmpty').classList.add('visible');
                    }
                } catch (err) {
                    console.error('Failed to load percentiles:', err);
                    document.getElementById('percentileEmpty').classList.add('visible');
                }
            },


            // Load throughput
            async loadThroughput() {
                try {
                    const params = new URLSearchParams({
                        hours: this.currentTimeRange
                    });
                    if (this.currentEndpoint) {
                        params.append('endpoint', this.currentEndpoint);
                    }

                    const response = await fetch(`/api/performance/throughput?${params}`, {
                        headers: jsonHeaders()
                    });
                    const result = await response.json();

                    const throughput = result?.data?.throughput || [];
                    if (result.status === 'success' && Array.isArray(throughput) && throughput.length > 0) {
                        this.renderThroughputChart(throughput);
                        document.getElementById('throughputEmpty').classList.remove('visible');
                    } else {
                        document.getElementById('throughputEmpty').classList.add('visible');
                    }
                } catch (err) {
                    console.error('Failed to load throughput:', err);
                    document.getElementById('throughputEmpty').classList.add('visible');
                }
            },


            // Populate endpoint filter
            async populateEndpointFilter() {
                try {
                    const response = await fetch('/api/performance/endpoints');
                    const contentType = response.headers.get('content-type') || '';
                    if (!response.ok) {
                        const body = await response.text();
                        throw new Error(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 200)}`);
                    }
                    if (!contentType.includes('application/json')) {
                        const body = await response.text();
                        throw new Error(`Expected JSON but got ${contentType || 'unknown content-type'}: ${body.slice(0, 200)}`);
                    }

                    const result = await response.json();

                    if (result.status === 'success' && result.data) {
                        const select = document.getElementById('endpointFilter');
                        result.data.forEach(endpoint => {
                            const option = document.createElement('option');
                            option.value = endpoint;
                            option.textContent = endpoint;
                            select.appendChild(option);
                        });
                    }
                } catch (err) {
                    console.error('Failed to load endpoints:', err);
                }
            },

            // Auto-refresh
            startAutoRefresh() {
                this.stopAutoRefresh();
                this.refreshInterval = setInterval(() => {
                    this.loadAll();
                    this.refreshCountdown = 60;
                }, 60000); // Refresh every 60 seconds
            },

            stopAutoRefresh() {
                if (this.refreshInterval) {
                    clearInterval(this.refreshInterval);
                    this.refreshInterval = null;
                }
            },

            startRefreshCountdown() {
                setInterval(() => {
                    if (this.autoRefreshEnabled && this.refreshCountdown > 0) {
                        this.refreshCountdown--;
                        document.getElementById('refreshCountdown').textContent = `(${this.refreshCountdown}s)`;
                    } else if (this.autoRefreshEnabled) {
                        this.refreshCountdown = 60;
                    } else {
                        document.getElementById('refreshCountdown').textContent = '';
                    }
                }, 1000);
            }
        };
