// Results Explorer — Sort, Export, Charts & URL State
// Continuation of results-explorer.js — loaded after it in results-explorer.html

// Sort results
function sortResults(results) {
    const { field, direction } = currentSort;
    const multiplier = direction === 'asc' ? 1 : -1;

    return results.sort((a, b) => {
        let aVal = a[field];
        let bVal = b[field];

        // Handle nested fields
        if (field === 'backend') {
            aVal = a.hardware_snapshot?.backend;
            bVal = b.hardware_snapshot?.backend;
        } else if (field === 'quantization') {
            aVal = a.hardware_snapshot?.quantization;
            bVal = b.hardware_snapshot?.quantization;
        }

        // Handle null values - always sort to bottom regardless of direction
        if (aVal === null || aVal === undefined) return 1;
        if (bVal === null || bVal === undefined) return -1;

        // Compare
        if (typeof aVal === 'string') {
            return aVal.localeCompare(bVal) * multiplier;
        } else {
            return (aVal - bVal) * multiplier;
        }
    });
}

// Update results count
function updateResultsCount() {
    const countEl = document.getElementById('resultsCount');
    const showing = allResults.length;
    const total = paginationState.total;
    if (total === 0) {
        countEl.textContent = '0 matching results';
        return;
    }
    const start = (paginationState.page - 1) * paginationState.limit + 1;
    const end = start + showing - 1;
    countEl.textContent = `Showing ${start}–${end} of ${total} matching results`;
}

// Update selected count
function updateSelectedCount() {
    const countEl = document.getElementById('selectedCount');
    const count = selectedResults.size;

    if (count === 0) {
        countEl.style.display = 'none';
    } else {
        countEl.style.display = 'block';
        countEl.textContent = `${count} selected`;
    }

    // Enable/disable action buttons
    const hasSelection = count > 0;
    document.getElementById('exportCsvBtn').disabled = !hasSelection;
    document.getElementById('exportJsonBtn').disabled = !hasSelection;
    document.getElementById('compareBtn').disabled = count < 2 || count > 4;
}

// Export data
function exportData(format) {
    const selectedData = allResults.filter(r => selectedResults.has(r._id));

    if (selectedData.length === 0) {
        alert('No results selected');
        return;
    }

    if (format === 'csv') {
        exportCSV(selectedData);
    } else if (format === 'json') {
        exportJSON(selectedData);
    }
}

// Export to CSV
function exportCSV(data) {
    const headers = [
        'model', 'host', 'category', 'level', 'quality_score', 'composite_score',
        'latency', 'tokens', 'tokens_per_sec', 'backend', 'quantization',
        'scoring_method', 'success', 'batch_id', 'evidence_era',
        'evidence_age_days', 'legacy_scoring', 'timestamp'
    ];

    const csvContent = [
        headers.join(','),
        ...data.map(row => headers.map(header => {
            let value;
            if (header === 'category') value = row.prompt_category ?? '';
            else if (header === 'level') value = row.prompt_level ?? '';
            else if (header === 'backend') value = row.hardware_snapshot?.backend ?? '';
            else if (header === 'quantization') value = row.hardware_snapshot?.quantization ?? '';
            else value = row[header] ?? '';

            // Escape commas and quotes
            if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
                value = `"${value.replace(/"/g, '""')}"`;
            }
            return value;
        }).join(','))
    ].join('\n');

    downloadFile(csvContent, 'benchmark-results.csv', 'text/csv');
}

// Export to JSON
function exportJSON(data) {
    const jsonContent = JSON.stringify(data, null, 2);
    downloadFile(jsonContent, 'benchmark-results.json', 'application/json');
}

// Download file
function downloadFile(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Open columns modal
function openColumnsModal() {
    const modal = document.getElementById('columnsModal');
    const grid = document.getElementById('columnsGrid');

    grid.innerHTML = Object.entries(AVAILABLE_COLUMNS)
        .filter(([key]) => key !== 'select' && key !== 'expand' && key !== 'inspect')
        .map(([key, config]) => `
            <div class="column-toggle">
                <input type="checkbox" id="col-${key}" value="${key}"
                    ${visibleColumns.has(key) ? 'checked' : ''}>
                <label for="col-${key}">${config.label}</label>
            </div>
        `).join('');

    // Add event listeners
    grid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const col = e.target.value;
            if (e.target.checked) {
                visibleColumns.add(col);
            } else {
                visibleColumns.delete(col);
            }
            renderTable();
        });
    });

    modal.style.display = 'block';
}

// Close columns modal
function closeColumnsModal() {
    document.getElementById('columnsModal').style.display = 'none';
}

// Open comparison modal
function openComparisonModal() {
    const selectedData = allResults.filter(r => selectedResults.has(r._id));

    if (selectedData.length < 2 || selectedData.length > 4) {
        alert('Please select 2-4 results to compare');
        return;
    }

    const modal = document.getElementById('comparisonModal');
    const content = document.getElementById('comparisonContent');

    content.innerHTML = `
        <div class="comparison-grid">
            ${selectedData.map(result => renderComparisonCard(result)).join('')}
        </div>
    `;

    modal.style.display = 'block';
}

// Render comparison card
function renderComparisonCard(result) {
    return `
        <div class="comparison-card">
            <h3>${escapeHtml(result.model)}</h3>
            <div class="comparison-field">
                <label>Category</label>
                <div class="value">${result.prompt_category}</div>
            </div>
            <div class="comparison-field">
                <label>Level</label>
                <div class="value">${result.prompt_level}</div>
            </div>
            <div class="comparison-field">
                <label>Quality Score</label>
                <div class="value">${renderScore(result.quality_score)}</div>
            </div>
            <div class="comparison-field">
                <label>Composite Score</label>
                <div class="value">${renderScore(result.composite_score, '0-100')}</div>
            </div>
            <div class="comparison-field">
                <label>Latency</label>
                <div class="value">${result.latency ? result.latency.toFixed(0) + ' ms' : 'N/A'}</div>
            </div>
            <div class="comparison-field">
                <label>Tokens/sec</label>
                <div class="value">${result.tokens_per_sec ? parseFloat(result.tokens_per_sec).toFixed(1) : 'N/A'}</div>
            </div>
            <div class="comparison-field">
                <label>Backend</label>
                <div class="value">${result.hardware_snapshot?.backend || 'N/A'}</div>
            </div>
            <div class="comparison-field">
                <label>Quantization</label>
                <div class="value">${result.hardware_snapshot?.quantization || 'N/A'}</div>
            </div>
            <div class="comparison-field">
                <label>Status</label>
                <div class="value"><span class="badge badge-${result.success ? 'success' : 'failed'}">
                    ${result.success ? 'Success' : 'Failed'}
                </span></div>
            </div>
            <div class="comparison-field">
                <label>Evidence age</label>
                <div class="value">${renderEvidenceAge(result)}</div>
            </div>
            <div class="comparison-field">
                <label>Recorded at</label>
                <div class="value">${formatRecordedAt(result)}</div>
            </div>
        </div>
    `;
}

// Close comparison modal
function closeComparisonModal() {
    document.getElementById('comparisonModal').style.display = 'none';
}

// Close detail modal
function closeDetailModal() {
    document.getElementById('detailModal').style.display = 'none';
}

// Toggle filters panel
function toggleFiltersPanel() {
    const body = document.getElementById('filtersPanelBody');
    const btn = document.getElementById('filtersCollapseBtn');

    body.classList.toggle('collapsed');
    btn.classList.toggle('collapsed');
}

// Update charts
function updateCharts() {
    updateQualityDistChart();
    updateLatencyScatterChart();
    updateCategoryRadarChart();
    updateModelBarChart();
    renderCategoryStats();
}

// Update quality distribution chart - ENHANCED
function updateQualityDistChart() {
    const ctx = document.getElementById('qualityDistChart');
    if (!ctx) return;

    const scores = filteredResults
        .filter(r => r.quality_score !== null)
        .map(r => r.quality_score);

    // Create histogram buckets for 0-10 scale
    const buckets = Array(10).fill(0);
    scores.forEach(score => {
        const bucket = Math.min(Math.floor(score), 9);
        buckets[bucket]++;
    });

    if (charts.qualityDist) {
        charts.qualityDist.destroy();
    }

    charts.qualityDist = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['0-1', '1-2', '2-3', '3-4', '4-5', '5-6', '6-7', '7-8', '8-9', '9-10'],
            datasets: [{
                label: 'Count',
                data: buckets,
                backgroundColor: [
                    'rgba(239, 68, 68, 0.7)',    // 0-1: red
                    'rgba(245, 126, 32, 0.7)',   // 1-2: orange-red
                    'rgba(249, 115, 22, 0.7)',   // 2-3: orange
                    'rgba(251, 146, 60, 0.7)',   // 3-4: orange-light
                    'rgba(248, 113, 113, 0.7)',  // 4-5: red-light
                    'rgba(234, 179, 8, 0.7)',    // 5-6: yellow
                    'rgba(132, 204, 22, 0.7)',   // 6-7: lime
                    'rgba(74, 222, 128, 0.7)',   // 7-8: green-light
                    'rgba(34, 197, 94, 0.7)',    // 8-9: green
                    'rgba(20, 184, 166, 0.7)'    // 9-10: teal
                ],
                borderColor: [
                    'rgba(239, 68, 68, 1)',
                    'rgba(245, 126, 32, 1)',
                    'rgba(249, 115, 22, 1)',
                    'rgba(251, 146, 60, 1)',
                    'rgba(248, 113, 113, 1)',
                    'rgba(234, 179, 8, 1)',
                    'rgba(132, 204, 22, 1)',
                    'rgba(74, 222, 128, 1)',
                    'rgba(34, 197, 94, 1)',
                    'rgba(20, 184, 166, 1)'
                ],
                borderWidth: 2,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            animation: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: 'rgba(255, 255, 255, 0.8)',
                        font: { size: 11, weight: '600' }
                    },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                },
                x: {
                    ticks: {
                        color: 'rgba(255, 255, 255, 0.8)',
                        font: { size: 11, weight: '600' }
                    },
                    grid: { display: false }
                }
            }
        }
    });
}

// Update latency scatter chart - ENHANCED
function updateLatencyScatterChart() {
    const ctx = document.getElementById('latencyScatterChart');
    if (!ctx) return;

    const data = filteredResults
        .filter(r => r.quality_score !== null && r.latency)
        .map(r => ({
            x: r.prompt_level,
            y: r.latency,
            quality: r.quality_score
        }));

    if (charts.latencyScatter) {
        charts.latencyScatter.destroy();
    }

    // Group data by quality tier
    const topTier = data.filter(d => d.quality >= 8);
    const midTier = data.filter(d => d.quality >= 6 && d.quality < 8);
    const lowTier = data.filter(d => d.quality < 6);

    charts.latencyScatter = new Chart(ctx, {
        type: 'scatter',
        data: {
            datasets: [
                {
                    label: `Excellent (8+) - ${topTier.length}`,
                    data: topTier,
                    backgroundColor: 'rgba(34, 197, 94, 0.7)',
                    borderColor: 'rgba(22, 163, 74, 1)',
                    borderWidth: 2,
                    pointRadius: 6,
                    pointHoverRadius: 8
                },
                {
                    label: `Good (6-8) - ${midTier.length}`,
                    data: midTier,
                    backgroundColor: 'rgba(234, 179, 8, 0.7)',
                    borderColor: 'rgba(202, 138, 4, 1)',
                    borderWidth: 2,
                    pointRadius: 6,
                    pointHoverRadius: 8
                },
                {
                    label: `Needs Work (<6) - ${lowTier.length}`,
                    data: lowTier,
                    backgroundColor: 'rgba(239, 68, 68, 0.7)',
                    borderColor: 'rgba(220, 38, 38, 1)',
                    borderWidth: 2,
                    pointRadius: 6,
                    pointHoverRadius: 8
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            animation: false,
            layout: {
                padding: {
                    bottom: 35
                }
            },
            interaction: {
                intersect: false,
                mode: 'nearest'
            },
            plugins: {
                legend: {
                    display: true,
                    labels: {
                        color: '#fff',
                        font: { size: 12, weight: 'bold' },
                        padding: 12,
                        usePointStyle: true,
                        pointStyle: 'circle'
                    }
                },
                tooltip: {
                    enabled: true,
                    backgroundColor: 'rgba(0, 0, 0, 0.9)',
                    borderColor: 'rgba(99, 102, 241, 1)',
                    borderWidth: 2,
                    titleColor: '#fff',
                    bodyColor: '#fff',
                    padding: 10,
                    displayColors: false,
                    callbacks: {
                        label: (ctx) => [
                            `Level: ${ctx.raw.x}`,
                            `Latency: ${ctx.raw.y.toFixed(0)}ms`,
                            `Quality: ${ctx.raw.quality.toFixed(1)}/10`
                        ]
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'Latency (ms)', color: 'rgba(255, 255, 255, 0.8)' },
                    ticks: { color: 'rgba(255, 255, 255, 0.8)', font: { size: 11, weight: '600' } },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                },
                x: {
                    title: { display: true, text: 'Complexity Level', color: 'rgba(255, 255, 255, 0.8)' },
                    ticks: { color: 'rgba(255, 255, 255, 0.8)', font: { size: 11, weight: '600' } },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                }
            }
        }
    });
}

// Update category radar chart - SIMPLE & EFFECTIVE - Numbers visible in legend
function updateCategoryRadarChart() {
    const ctx = document.getElementById('categoryRadarChart');
    if (!ctx) return;

    // Calculate statistics per category
    const categoryData = {};
    filteredResults.forEach(r => {
        if (r.quality_score !== null && r.prompt_category) {
            if (!categoryData[r.prompt_category]) {
                categoryData[r.prompt_category] = { total: 0, count: 0, min: 10, max: 0 };
            }
            categoryData[r.prompt_category].total += r.quality_score;
            categoryData[r.prompt_category].count++;
            categoryData[r.prompt_category].min = Math.min(categoryData[r.prompt_category].min, r.quality_score);
            categoryData[r.prompt_category].max = Math.max(categoryData[r.prompt_category].max, r.quality_score);
        }
    });

    const labels = Object.keys(categoryData).sort();
    const avgData = labels.map(cat => (categoryData[cat].total / categoryData[cat].count).toFixed(2));
    const countData = labels.map(cat => categoryData[cat].count);
    const minData = labels.map(cat => categoryData[cat].min);
    const maxData = labels.map(cat => categoryData[cat].max);

    if (charts.categoryRadar) {
        charts.categoryRadar.destroy();
    }

    // Create enhanced labels that show the actual scores
    const enhancedLabels = labels.map((label, i) => `${label} (${avgData[i]})`);

    charts.categoryRadar = new Chart(ctx, {
        type: 'radar',
        data: {
            labels: enhancedLabels,
            datasets: [
                {
                    label: 'Average Quality Score',
                    data: avgData,
                    backgroundColor: 'rgba(99, 102, 241, 0.35)',
                    borderColor: 'rgba(99, 102, 241, 1)',
                    borderWidth: 3,
                    pointRadius: 8,
                    pointBorderWidth: 3,
                    pointBorderColor: '#fff',
                    pointBackgroundColor: 'rgba(99, 102, 241, 1)',
                    pointHoverRadius: 10,
                    fill: true,
                    tension: 0.3
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            animation: false,
            interaction: {
                intersect: false,
                mode: 'nearest'
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    enabled: true,
                    backgroundColor: 'rgba(0, 0, 0, 0.95)',
                    borderColor: 'rgba(99, 102, 241, 1)',
                    borderWidth: 2,
                    titleColor: '#fff',
                    bodyColor: '#fff',
                    padding: 12,
                    titleFont: { size: 13, weight: 'bold' },
                    bodyFont: { size: 12, weight: '600' },
                    displayColors: false,
                    usePointStyle: false,
                    callbacks: {
                        title: (ctx) => {
                            // Extract category name from label (remove the score part)
                            const labelText = ctx[0].label;
                            const categoryName = labelText.substring(0, labelText.lastIndexOf(' ('));
                            return categoryName;
                        },
                        label: (ctx) => {
                            const idx = ctx.dataIndex;
                            return `Quality: ${avgData[idx]}/10`;
                        },
                        afterLabel: (ctx) => {
                            const idx = ctx.dataIndex;
                            return [
                                `Samples: ${countData[idx]}`,
                                `Range: ${minData[idx].toFixed(1)} - ${maxData[idx].toFixed(1)}`
                            ];
                        }
                    }
                }
            },
            scales: {
                r: {
                    beginAtZero: true,
                    max: 10,
                    ticks: {
                        color: 'rgba(255, 255, 255, 0.95)',
                        font: { size: 12, weight: 'bold' },
                        stepSize: 2,
                        backdropColor: 'transparent'
                    },
                    pointLabels: {
                        color: 'rgba(255, 255, 255, 0.95)',
                        font: { size: 10, weight: 'bold' },
                        padding: 5
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.2)',
                        circular: true,
                        drawBorder: true
                    }
                }
            }
        }
    });
}

// Update model comparison bar chart
function updateModelBarChart() {
    const ctx = document.getElementById('modelBarChart');
    if (!ctx) return;

    // Calculate stats per model
    const modelData = {};
    filteredResults.forEach(r => {
        if (r.quality_score !== null && r.model) {
            if (!modelData[r.model]) {
                modelData[r.model] = { total: 0, count: 0, latency: 0 };
            }
            modelData[r.model].total += r.quality_score;
            modelData[r.model].count++;
            if (r.latency) modelData[r.model].latency += r.latency;
        }
    });

    // If no model data, show empty state
    if (Object.keys(modelData).length === 0) {
        setChartEmptyState(ctx, true, 'No scored model data on this visible page');
        if (charts.modelBar) {
            charts.modelBar.destroy();
            charts.modelBar = null;
        }
        return;
    }
    setChartEmptyState(ctx, false);

    const models = Object.keys(modelData)
        .sort((a, b) => (modelData[b].total / modelData[b].count) - (modelData[a].total / modelData[a].count))
        .slice(0, 12); // Top 12 models

    const avgScores = models.map(m => parseFloat((modelData[m].total / modelData[m].count).toFixed(2)));
    const counts = models.map(m => modelData[m].count);

    if (charts.modelBar) {
        charts.modelBar.destroy();
    }

    try {
        charts.modelBar = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: models,
                datasets: [{
                    label: 'Average Quality Score',
                    data: avgScores,
                    backgroundColor: avgScores.map(score => {
                        if (score >= 8) return 'rgba(34, 197, 94, 0.7)';
                        if (score >= 6) return 'rgba(234, 179, 8, 0.7)';
                        return 'rgba(239, 68, 68, 0.7)';
                    }),
                    borderColor: avgScores.map(score => {
                        if (score >= 8) return 'rgba(22, 163, 74, 1)';
                        if (score >= 6) return 'rgba(202, 138, 4, 1)';
                        return 'rgba(220, 38, 38, 1)';
                    }),
                    borderWidth: 2,
                    borderRadius: 6
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: true,
                animation: false,
                plugins: {
                    legend: {
                        display: true,
                        labels: {
                            color: '#fff',
                            font: { size: 11, weight: 'bold' },
                            padding: 10
                        }
                    },
                    tooltip: {
                        enabled: true,
                        backgroundColor: 'rgba(0, 0, 0, 0.9)',
                        borderColor: 'rgba(99, 102, 241, 1)',
                        borderWidth: 2,
                        titleColor: '#fff',
                        bodyColor: '#fff',
                        padding: 10,
                        displayColors: false,
                        callbacks: {
                            label: (ctx) => {
                                const idx = ctx.dataIndex;
                                return [
                                    `Quality: ${avgScores[idx].toFixed(1)}/10`,
                                    `Samples: ${counts[idx]}`
                                ];
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        beginAtZero: true,
                        max: 10,
                        ticks: { color: 'rgba(255, 255, 255, 0.8)', font: { size: 10, weight: '600' } },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    y: {
                        ticks: { color: 'rgba(255, 255, 255, 0.8)', font: { size: 10, weight: '600' } },
                        grid: { display: false }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Error rendering model bar chart:', error);
    }
}

function setChartEmptyState(canvas, empty, message = '') {
    if (!canvas?.parentElement) return;
    const marker = `chart-empty-${canvas.id}`;
    let emptyState = canvas.parentElement.querySelector(`[data-chart-empty="${marker}"]`);
    if (!emptyState) {
        emptyState = document.createElement('div');
        emptyState.className = 'chart-empty-state';
        emptyState.dataset.chartEmpty = marker;
        emptyState.hidden = true;
        canvas.insertAdjacentElement('afterend', emptyState);
    }
    canvas.hidden = empty;
    canvas.style.display = empty ? 'none' : 'block';
    emptyState.hidden = !empty;
    if (empty) emptyState.textContent = message;
}

// Render category statistics table
function renderCategoryStats() {
    const container = document.getElementById('categoryStatsContainer');
    if (!container) return;

    // Calculate comprehensive stats per category
    const categoryData = {};
    filteredResults.forEach(r => {
        if (r.quality_score !== null && r.prompt_category) {
            if (!categoryData[r.prompt_category]) {
                categoryData[r.prompt_category] = {
                    total: 0,
                    count: 0,
                    min: 10,
                    max: 0,
                    latencyTotal: 0,
                    latencyCount: 0,
                    successCount: 0
                };
            }
            const stats = categoryData[r.prompt_category];
            stats.total += r.quality_score;
            stats.count++;
            stats.min = Math.min(stats.min, r.quality_score);
            stats.max = Math.max(stats.max, r.quality_score);
            if (r.latency) {
                stats.latencyTotal += r.latency;
                stats.latencyCount++;
            }
            if (r.success) stats.successCount++;
        }
    });

    // Sort by average quality descending
    const sorted = Object.entries(categoryData)
        .sort((a, b) => (b[1].total / b[1].count) - (a[1].total / a[1].count));

    // Build HTML table
    let html = `
        <table class="stats-table">
            <thead>
                <tr>
                    <th>Category</th>
                    <th>Samples</th>
                    <th>Avg Quality</th>
                    <th>Range</th>
                    <th>Avg Latency</th>
                    <th>Success Rate</th>
                    <th>Trend</th>
                </tr>
            </thead>
            <tbody>
    `;

    sorted.forEach(([category, stats]) => {
        const avg = (stats.total / stats.count).toFixed(2);
        const avgLatency = stats.latencyCount > 0 ? (stats.latencyTotal / stats.latencyCount).toFixed(0) : 'N/A';
        const successRate = ((stats.successCount / stats.count) * 100).toFixed(1);
        const range = `${stats.min.toFixed(1)} - ${stats.max.toFixed(1)}`;

        // Determine quality color
        const qualityClass = avg >= 8 ? 'excellent' : (avg >= 6 ? 'good' : 'needs-work');

        // Simple trend indicator
        const trend = avg >= 7 ? '↑' : (avg >= 5 ? '→' : '↓');

        html += `
            <tr>
                <td><strong>${escapeHtml(category)}</strong></td>
                <td class="stat-center">${stats.count}</td>
                <td class="stat-quality stat-${qualityClass}">${avg}</td>
                <td class="stat-center">${range}</td>
                <td class="stat-center">${avgLatency}ms</td>
                <td class="stat-center"><span class="badge badge-success">${successRate}%</span></td>
                <td class="stat-center trend-${qualityClass}">${trend}</td>
            </tr>
        `;
    });

    html += `
            </tbody>
        </table>
    `;

    container.innerHTML = html;
}

// Render summary statistics bar
function renderSummaryStats() {
    const container = document.getElementById('summaryStatsBar');
    if (!container) return;

    const pageTotal = filteredResults.length;
    const successCount = filteredResults.filter(r => r.success).length;
    const successRate = pageTotal > 0 ? ((successCount / pageTotal) * 100).toFixed(1) : '0.0';

    const scores = filteredResults
        .filter(r => r.quality_score !== null && r.quality_score !== undefined)
        .map(r => r.quality_score);
    const avgQuality = scores.length > 0
        ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)
        : 'N/A';

    const latencies = filteredResults
        .filter(r => r.latency)
        .map(r => r.latency);
    const avgLatency = latencies.length > 0
        ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0)
        : 'N/A';

    const models = new Set(filteredResults.map(r => r.model)).size;

    function qualityClass(val) {
        if (val === 'N/A') return '';
        const n = parseFloat(val);
        if (n >= 8) return 'score-high';
        if (n >= 6) return 'score-medium';
        return 'score-low';
    }
    const successClass = Number(successRate) >= 90
        ? 'score-high'
        : (Number(successRate) >= 70 ? 'score-medium' : 'score-low');

    container.innerHTML = `
        <div class="summary-stat-card">
            <div class="stat-value">${paginationState.total}</div>
            <div class="stat-label">Matching Results</div>
        </div>
        <div class="summary-stat-card">
            <div class="stat-value evidence-count-recent">${Number(evidenceCounts.recent) || 0}</div>
            <div class="stat-label">Recent · ≤30d</div>
        </div>
        <div class="summary-stat-card">
            <div class="stat-value evidence-count-aging">${Number(evidenceCounts.aging) || 0}</div>
            <div class="stat-label">Aging · 31–90d</div>
        </div>
        <div class="summary-stat-card">
            <div class="stat-value evidence-count-historical">${Number(evidenceCounts.historical) || 0}</div>
            <div class="stat-label">Historical · 91d+</div>
        </div>
        <div class="summary-stat-card">
            <div class="stat-value">${models}</div>
            <div class="stat-label">Models on Page</div>
        </div>
        <div class="summary-stat-card">
            <div class="stat-value ${qualityClass(avgQuality)}">${avgQuality}</div>
            <div class="stat-label">Page Avg Quality</div>
        </div>
        <div class="summary-stat-card">
            <div class="stat-value">${avgLatency === 'N/A' ? 'N/A' : avgLatency + 'ms'}</div>
            <div class="stat-label">Page Avg Latency</div>
        </div>
        <div class="summary-stat-card">
            <div class="stat-value ${successClass}">${successRate}%</div>
            <div class="stat-label">Page Success Rate</div>
        </div>
        ${Number(evidenceCounts.undated) > 0 ? `
        <div class="summary-stat-card">
            <div class="stat-value">${Number(evidenceCounts.undated)}</div>
            <div class="stat-label">Undated</div>
        </div>` : ''}
        ${Number(evidenceCounts.legacy_scoring) > 0 ? `
        <div class="summary-stat-card">
            <div class="stat-value evidence-count-legacy">${Number(evidenceCounts.legacy_scoring)}</div>
            <div class="stat-label">Explicit Legacy Scoring</div>
        </div>` : ''}
    `;
}

// Utility function to escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Show error
function showError(message) {
    const container = document.getElementById('resultsTable');
    container.innerHTML = `
        <div class="error-state">
            <i class="fas fa-exclamation-triangle"></i>
            <p>${escapeHtml(message)}</p>
            <button onclick="location.reload()" class="btn-primary">Reload</button>
        </div>
    `;
}

// Close modals when clicking outside
window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
        e.target.style.display = 'none';
    }
});

// Close topmost modal on ESC
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const open = document.querySelectorAll('.modal[style*="display: block"], .modal[style*="display:block"]');
        if (open.length) open[open.length - 1].style.display = 'none';
    }
});

// ==========================================
// Test Inspector Functionality
// ==========================================

let currentInspectorResult = null;
let currentInspectorTab = 'warmup';
