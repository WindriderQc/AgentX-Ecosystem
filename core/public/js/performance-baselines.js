Object.assign(PerformanceDashboard, {
            // Load baselines
            async loadBaselines() {
                try {
                    document.getElementById('baselineLoading').classList.add('active');

                    const response = await fetch('/api/performance/baselines');
                    const result = await response.json();

                    document.getElementById('baselineLoading').classList.remove('active');

                    const baselines = result?.data?.baselines || [];
                    if (result.status === 'success' && Array.isArray(baselines) && baselines.length > 0) {
                        this.renderBaselines(baselines);
                        document.getElementById('baselinesEmpty').style.display = 'none';

                        // Load baseline comparison if there's an active one
                        const activeBaseline = baselines.find(b => b.active);
                        if (activeBaseline) {
                            await this.loadBaselineComparison();
                        }
                    } else {
                        document.getElementById('baselinesEmpty').style.display = 'block';
                    }
                } catch (err) {
                    console.error('Failed to load baselines:', err);
                    document.getElementById('baselineLoading').classList.remove('active');
                }
            },

            // Render baselines list
            renderBaselines(baselines) {
                const list = document.getElementById('baselineList');
                list.innerHTML = '';

                baselines.forEach(baseline => {
                    const item = document.createElement('div');
                    item.classList.add('baseline-item');
                    if (baseline.active) {
                        item.classList.add('active');
                    }

                    const date = new Date(baseline.created_at || baseline.createdAt || Date.now()).toLocaleDateString();

                    item.innerHTML = `
                        <div class="baseline-info">
                            <div class="baseline-name">${baseline.name}</div>
                            <div class="baseline-meta">
                                Created: ${date} ${baseline.active ? '• <strong style="color: var(--accent);">ACTIVE</strong>' : ''}
                            </div>
                        </div>
                        <div class="baseline-actions">
                            ${!baseline.active ? `
                                <button class="action-btn activate-baseline-btn" data-id="${baseline._id}">
                                    <i class="fas fa-check"></i> Activate
                                </button>
                            ` : ''}
                            <button class="action-btn delete-baseline-btn" data-id="${baseline._id}">
                                <i class="fas fa-trash"></i> Delete
                            </button>
                        </div>
                    `;

                    list.appendChild(item);

                    // Attach event listeners
                    const activateBtn = item.querySelector('.activate-baseline-btn');
                    if (activateBtn) {
                        activateBtn.addEventListener('click', () => this.activateBaseline(baseline._id));
                    }

                    item.querySelector('.delete-baseline-btn').addEventListener('click', () => {
                        if (confirm(`Delete baseline "${baseline.name}"?`)) {
                            this.deleteBaseline(baseline._id);
                        }
                    });
                });
            },

            // Load baseline comparison
            async loadBaselineComparison() {
                try {
                    const response = await fetch(`/api/performance/baseline-compare?hours=${this.currentTimeRange}`);
                    const result = await response.json();

                    if (result.status === 'success' && result.data) {
                        this.renderBaselineComparison(result.data);
                        this.checkForRegressions(result.data);
                    }
                } catch (err) {
                    console.error('Failed to load baseline comparison:', err);
                }
            },

            // Render baseline comparison
            renderBaselineComparison(data) {
                const card = document.getElementById('activeBaselineCard');
                card.style.display = 'block';

                document.getElementById('activeBaselineName').textContent = data.baseline.name;
                document.getElementById('activeBaselineDate').textContent = new Date().toLocaleDateString();

                const grid = document.getElementById('comparisonGrid');
                grid.innerHTML = '';

                const metrics = [
                    { key: 'avg_response_time', label: 'Avg Response Time', unit: 'ms', lowerIsBetter: true },
                    { key: 'p95_latency', label: 'P95 Latency', unit: 'ms', lowerIsBetter: true },
                    { key: 'throughput_rps', label: 'Throughput', unit: 'rps', lowerIsBetter: false },
                    { key: 'error_rate', label: 'Error Rate', unit: '%', lowerIsBetter: true }
                ];

                metrics.forEach(metric => {
                    const baselineValue = data.baseline.metrics[metric.key] || 0;
                    const currentValue = data.current[metric.key] || 0;
                    const diff = ((currentValue - baselineValue) / baselineValue) * 100;

                    const isImprovement = metric.lowerIsBetter ? diff < 0 : diff > 0;

                    const item = document.createElement('div');
                    item.classList.add('comparison-item');
                    item.innerHTML = `
                        <div class="metric-label">${metric.label}</div>
                        <div class="metric-values">
                            <span class="baseline-value">${baselineValue.toFixed(metric.unit === '%' ? 2 : 1)}${metric.unit}</span>
                            <span style="color: var(--muted);">→</span>
                            <span class="current-value">${currentValue.toFixed(metric.unit === '%' ? 2 : 1)}${metric.unit}</span>
                            <span class="diff ${isImprovement ? 'positive' : 'negative'}">
                                ${diff > 0 ? '+' : ''}${diff.toFixed(1)}%
                            </span>
                        </div>
                    `;
                    grid.appendChild(item);
                });
            },

            // Check for regressions
            checkForRegressions(comparison) {
                const alertsContainer = document.getElementById('regressionAlerts');
                alertsContainer.innerHTML = '';

                const regressions = [];

                // Check thresholds
                const baselineP95 = comparison.baseline.metrics.p95_latency || 0;
                const currentP95 = comparison.current.p95_latency || 0;
                const p95Increase = ((currentP95 - baselineP95) / baselineP95) * 100;

                if (p95Increase > 20) {
                    regressions.push(`P95 latency increased by ${p95Increase.toFixed(1)}% (${baselineP95.toFixed(0)}ms → ${currentP95.toFixed(0)}ms)`);
                }

                const baselineErrorRate = comparison.baseline.metrics.error_rate || 0;
                const currentErrorRate = comparison.current.error_rate || 0;
                if (currentErrorRate > baselineErrorRate * 1.5) {
                    regressions.push(`Error rate increased by ${((currentErrorRate / baselineErrorRate - 1) * 100).toFixed(1)}%`);
                }

                if (regressions.length > 0) {
                    regressions.forEach(regression => {
                        const alert = document.createElement('div');
                        alert.classList.add('alert-banner');
                        alert.innerHTML = `
                            <i class="fas fa-exclamation-triangle"></i>
                            <div class="alert-content">
                                <h4>Performance Regression Detected</h4>
                                <p>${regression}</p>
                            </div>
                        `;
                        alertsContainer.appendChild(alert);
                    });
                }
            },

            // Open create baseline modal
            openCreateBaselineModal() {
                // Populate load test dropdown
                fetch('/api/performance/load-tests?limit=10')
                    .then(res => res.json())
                    .then(result => {
                        const tests = result?.data?.tests || [];
                        if (result.status === 'success' && tests.length > 0) {
                            const select = document.getElementById('baselineLoadTest');
                            select.innerHTML = '<option value="">Select a load test...</option>';
                            tests.forEach(test => {
                                const option = document.createElement('option');
                                option.value = test._id;
                                option.textContent = `${test.scenario} - ${new Date(test.timestamp).toLocaleDateString()}`;
                                select.appendChild(option);
                            });
                        }
                    });

                document.getElementById('createBaselineModal').classList.add('active');
            },

            // Create baseline
            async createBaseline() {
                try {
                    const name = document.getElementById('baselineName').value;
                    const description = document.getElementById('baselineDescription').value;
                    const source = document.getElementById('baselineSource').value;
                    const loadTestId = document.getElementById('baselineLoadTest').value;

                    const data = { name, description };

                    if (source === 'loadtest' && loadTestId) {
                        data.source = 'load_test';
                        data.loadTestId = loadTestId;
                    } else {
                        data.source = 'manual';
                    }

                    const response = await fetch('/api/performance/baselines', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(data)
                    });

                    const result = await response.json();

                    if (result.status === 'success') {
                        alert('Baseline created successfully!');
                        document.getElementById('createBaselineModal').classList.remove('active');
                        document.getElementById('createBaselineForm').reset();
                        await this.loadBaselines();
                    } else {
                        alert('Failed to create baseline: ' + (result.message || 'Unknown error'));
                    }
                } catch (err) {
                    console.error('Create baseline failed:', err);
                    alert('Failed to create baseline: ' + err.message);
                }
            },

            // Set baseline from test
            setBaselineFromTest(testId) {
                document.getElementById('baselineSource').value = 'loadtest';
                document.getElementById('loadTestSelectGroup').style.display = 'block';
                document.getElementById('baselineLoadTest').value = testId;
                this.openCreateBaselineModal();
            },

            // Activate baseline
            async activateBaseline(id) {
                try {
                    const response = await fetch(`/api/performance/baselines/${id}/activate`, {
                        method: 'POST'
                    });

                    const result = await response.json();

                    if (result.status === 'success') {
                        await this.loadBaselines();
                    } else {
                        alert('Failed to activate baseline: ' + (result.message || 'Unknown error'));
                    }
                } catch (err) {
                    console.error('Activate baseline failed:', err);
                    alert('Failed to activate baseline: ' + err.message);
                }
            },

            // Delete baseline
            async deleteBaseline(id) {
                try {
                    const response = await fetch(`/api/performance/baselines/${id}`, {
                        method: 'DELETE'
                    });

                    const result = await response.json();

                    if (result.status === 'success') {
                        await this.loadBaselines();
                    } else {
                        alert('Failed to delete baseline: ' + (result.message || 'Unknown error'));
                    }
                } catch (err) {
                    console.error('Delete baseline failed:', err);
                    alert('Failed to delete baseline: ' + err.message);
                }
            }
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    PerformanceDashboard.init();
});
