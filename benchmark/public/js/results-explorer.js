// Results Explorer - Advanced Benchmark Results Analysis

// Readiness badges (populated async after page load)
let _readinessMap = {};

// Global state
let allResults = [];
let filteredResults = [];
let _profilerHostMap = {};
let selectedResults = new Set();
let visibleColumns = new Set([
    'select', 'expand', 'inspect', 'model', 'category', 'level', 'quality_score',
    'latency', 'tokens_per_sec', 'success', 'timestamp'
]);

let currentSort = { field: 'timestamp', direction: 'desc' };

// Pagination state
let paginationState = { page: 1, limit: 50, total: 0, totalPages: 0 };

// Available columns configuration
const AVAILABLE_COLUMNS = {
    select: { label: 'Select', sortable: false, width: '40px' },
    expand: { label: 'Expand', sortable: false, width: '40px' },
    inspect: { label: 'Inspect', sortable: false, width: '70px' },
    courthouse: { label: 'Review', sortable: false, width: '60px', tooltip: 'Open in Courthouse for human review.' },
    model: { label: 'Model', sortable: true, width: 'auto', tooltip: 'The model that generated this response.' },
    host: { label: 'Host', sortable: true, width: 'auto', tooltip: 'The Ollama host that ran this model.' },
    category: { label: 'Category', sortable: true, width: '120px', tooltip: 'Which of the 7 evaluation categories this prompt belongs to (coding, reasoning, math, knowledge, instruction, creative, translation).' },
    level: { label: 'Level', sortable: true, width: '80px', tooltip: 'Difficulty level (1=basic, 5=master). Higher levels test harder tasks requiring deeper expertise.' },
    quality_score: { label: 'Quality', sortable: true, width: '90px', tooltip: 'Judge-assigned quality score (0-10). Based on category-specific dimensions such as accuracy, clarity, and completeness.' },
    composite_score: { label: 'Composite', sortable: true, width: '100px', tooltip: 'Combined score (0-100) blending quality, latency, and speed. Weights vary by category (e.g., coding weights quality more heavily).' },
    latency: { label: 'Latency (ms)', sortable: true, width: '110px', tooltip: 'Time in milliseconds from sending the request to receiving the complete response.' },
    tokens: { label: 'Tokens', sortable: true, width: '80px', tooltip: 'Total number of tokens in the model response.' },
    tokens_per_sec: { label: 'Tokens/sec', sortable: true, width: '100px', tooltip: 'Response generation speed. Higher = faster model. Useful for comparing throughput across hardware.' },
    backend: { label: 'Backend', sortable: true, width: '90px', tooltip: 'Compute backend used (CUDA, Metal, CPU, ROCm, Vulkan). Affects performance characteristics.' },
    quantization: { label: 'Quantization', sortable: true, width: '110px', tooltip: 'Model quantization level (e.g., Q4_K_M, Q8_0). Lower quantization = smaller memory footprint but potentially lower quality.' },
    scoring_method: { label: 'Scoring', sortable: true, width: '100px', tooltip: 'How this result was scored: decomposed (binary question voting), deterministic (pattern matching), reference (compared to expert answer), quick (heuristic).' },
    success: { label: 'Status', sortable: true, width: '90px', tooltip: 'Whether the model successfully completed the task without errors or timeouts.' },
    batch_id: { label: 'Batch ID', sortable: true, width: '100px', tooltip: 'The benchmark batch run this result belongs to.' },
    timestamp: { label: 'Timestamp', sortable: true, width: '160px', tooltip: 'When this result was recorded.' }
};

// Chart instances
let charts = {
    qualityDist: null,
    latencyScatter: null,
    categoryRadar: null,
    modelBar: null
};

// Categories for filters
const CATEGORIES = [
    'coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'
];

// ── URL state persistence ────────────────────────────────────────────────────

const URL_FILTER_KEYS = [
    { param: 'host',     id: 'hostFilter' },
    { param: 'category', id: 'categoryFilter' },
    { param: 'level',    id: 'levelFilter' },
    { param: 'success',  id: 'successFilter' },
    { param: 'batch',    id: 'batchIdFilter' },
    { param: 'scoring',  id: 'scoringMethodFilter' },
];

function saveURLState() {
    const params = new URLSearchParams();
    for (const { param, id } of URL_FILTER_KEYS) {
        const el = document.getElementById(id);
        if (el && el.value) params.set(param, el.value);
    }
    // Model multi-select
    const models = Array.from(document.querySelectorAll('#modelSelectContainer input[type="checkbox"]:checked'))
        .map(cb => cb.value);
    if (models.length) params.set('models', models.join(','));
    // Sort
    if (currentSort.field !== 'timestamp' || currentSort.direction !== 'desc') {
        params.set('sort', `${currentSort.field}:${currentSort.direction}`);
    }
    // Page
    if (paginationState.page > 1) params.set('page', paginationState.page);

    const qs = params.toString();
    const url = qs ? `${location.pathname}?${qs}` : location.pathname;
    history.replaceState(null, '', url);
}

function loadURLState() {
    const params = new URLSearchParams(location.search);
    for (const { param, id } of URL_FILTER_KEYS) {
        const val = params.get(param);
        const el = document.getElementById(id);
        if (val && el) el.value = val;
    }
    // Model multi-select
    const modelsCsv = params.get('models');
    if (modelsCsv) {
        const wantedModels = new Set(modelsCsv.split(','));
        document.querySelectorAll('#modelSelectContainer input[type="checkbox"]').forEach(cb => {
            cb.checked = wantedModels.has(cb.value);
        });
    }
    // Sort
    const sortParam = params.get('sort');
    if (sortParam) {
        const [field, dir] = sortParam.split(':');
        if (field) currentSort.field = field;
        if (dir === 'asc' || dir === 'desc') currentSort.direction = dir;
    }
    // Page
    const page = parseInt(params.get('page'), 10);
    if (page > 0) paginationState.page = page;

    applyFilters();
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
    // Load readiness badges in the background; re-render table when ready
    try {
        const mod = await import('/js/model-profiler/components/readiness-cache.js');
        _readinessMap = await mod.getReadinessMap();
    } catch (_) {}

    await loadResults();
    initializeFilters();
    setupEventListeners();
    loadURLState();
    renderTable();
    updateCharts();
    renderSummaryStats();
    renderPagination();
});

// Load benchmark results for the current page
async function loadResults(page) {
    if (page !== undefined) paginationState.page = page;
    try {
        const [resultsRes, hostsRes] = await Promise.all([
            fetch(`/api/benchmark/results?page=${paginationState.page}&limit=${paginationState.limit}`),
            fetch('/api/profiler/hosts').catch(() => null),
        ]);
        if (!resultsRes.ok) throw new Error('Failed to fetch results');

        const data = await resultsRes.json();
        allResults = data.data.results || [];
        filteredResults = [...allResults];

        // Update pagination state from server response
        paginationState.page = data.data.page || 1;
        paginationState.limit = data.data.limit || 50;
        paginationState.total = data.data.total || 0;
        paginationState.totalPages = data.data.totalPages || 0;

        // Build host name map from profiler for friendly display
        _profilerHostMap = {};
        try {
            const hostData = hostsRes ? await hostsRes.json() : null;
            const hosts = hostData?.data || hostData || [];
            if (Array.isArray(hosts)) {
                hosts.forEach(h => {
                    const url = h.hostUrl || h.url || '';
                    if (url && h.name) _profilerHostMap[url] = h.name;
                });
            }
        } catch (_) {}

        console.log(`Loaded ${allResults.length} results (page ${paginationState.page}/${paginationState.totalPages}, total ${paginationState.total})`);
    } catch (error) {
        console.error('Error loading results:', error);
        showError('Failed to load results: ' + error.message);
    }
}

// Navigate to a specific page
async function goToPage(page) {
    if (page < 1 || page > paginationState.totalPages) return;
    await loadResults(page);
    initializeFilters();
    applyFilters();
    renderPagination();
}

// Initialize filter options
function initializeFilters() {
    // Populate model multi-select
    const models = [...new Set(allResults.map(r => r.model))].sort();
    populateMultiSelect('modelSelectContainer', models, 'model');

    // Populate category multi-select
    populateMultiSelect('categorySelectContainer', CATEGORIES, 'category');

    // Populate host dropdown — merge result hosts + profiler hosts
    const resultHosts = [...new Set(allResults.map(r => r.host))];
    const profilerHosts = Object.keys(_profilerHostMap);
    const allHosts = [...new Set([...resultHosts, ...profilerHosts])].sort();
    const hostSelect = document.getElementById('hostFilter');
    allHosts.forEach(url => {
        const name = _profilerHostMap[url];
        const opt = document.createElement('option');
        opt.value = url;
        opt.textContent = name ? `${name} (${url})` : url;
        hostSelect.appendChild(opt);
    });

    // Populate quantization dropdown
    const quantizations = [...new Set(allResults
        .filter(r => r.hardware_snapshot?.quantization)
        .map(r => r.hardware_snapshot.quantization))].sort();
    populateDropdown('quantizationFilter', quantizations);

    // Populate backend dropdown
    const backends = [...new Set(allResults
        .filter(r => r.hardware_snapshot?.backend)
        .map(r => r.hardware_snapshot.backend))].sort();
    populateDropdown('backendFilter', backends);

    // Populate scoring method dropdown
    const methods = [...new Set(allResults
        .filter(r => r.scoring_method)
        .map(r => r.scoring_method))].sort();
    populateDropdown('scoringMethodFilter', methods);

    // Setup range slider displays
    updateRangeDisplay('levelMin', 'levelMax', 'levelRangeDisplay');
    updateRangeDisplay('qualityMin', 'qualityMax', 'qualityRangeDisplay');
}

// Populate multi-select checkbox list
function populateMultiSelect(containerId, items, name) {
    const container = document.getElementById(containerId);
    container.innerHTML = items.map(item => `
        <div class="multi-select-item">
            <input type="checkbox" id="${name}-${item}" value="${item}" data-filter="${name}">
            <label for="${name}-${item}">${item}</label>
        </div>
    `).join('');
}

// Populate dropdown
function populateDropdown(selectId, options) {
    const select = document.getElementById(selectId);
    const currentOptions = Array.from(select.querySelectorAll('option')).map(o => o.value);

    options.forEach(opt => {
        if (!currentOptions.includes(opt)) {
            const option = document.createElement('option');
            option.value = opt;
            option.textContent = opt;
            select.appendChild(option);
        }
    });
}

// Update range slider display
function updateRangeDisplay(minId, maxId, displayId) {
    const min = document.getElementById(minId);
    const max = document.getElementById(maxId);
    const display = document.getElementById(displayId);

    const update = () => {
        const minVal = parseInt(min.value);
        const maxVal = parseInt(max.value);

        // Ensure min <= max
        if (minVal > maxVal) {
            if (min === document.activeElement) {
                max.value = minVal;
            } else {
                min.value = maxVal;
            }
        }

        display.textContent = `${min.value} - ${max.value}`;
    };

    min.addEventListener('input', update);
    max.addEventListener('input', update);
    update();
}

// Setup event listeners
function setupEventListeners() {
    // Refresh button
    document.getElementById('refreshBtn').addEventListener('click', async () => {
        await loadResults();
        initializeFilters();
        applyFilters();
        renderPagination();
    });

    // Clear filters button
    document.getElementById('clearFiltersBtn').addEventListener('click', clearAllFilters);

    // Export buttons
    document.getElementById('exportCsvBtn').addEventListener('click', () => exportData('csv'));
    document.getElementById('exportJsonBtn').addEventListener('click', () => exportData('json'));

    // Compare button
    document.getElementById('compareBtn').addEventListener('click', openComparisonModal);

    // Toggle columns button
    document.getElementById('toggleColumnsBtn').addEventListener('click', openColumnsModal);

    // Filter change listeners
    document.querySelectorAll('.filter-group input, .filter-group select').forEach(el => {
        el.addEventListener('change', handleFilterChange);
    });

    document.querySelectorAll('.multi-select-item input[type="checkbox"]').forEach(el => {
        el.addEventListener('change', handleFilterChange);
    });

    // Model search
    document.getElementById('modelSearch').addEventListener('input', (e) => {
        const search = e.target.value.toLowerCase();
        document.querySelectorAll('#modelSelectContainer .multi-select-item').forEach(item => {
            const label = item.querySelector('label').textContent.toLowerCase();
            item.style.display = label.includes(search) ? 'flex' : 'none';
        });
    });
}

// Handle filter changes
function handleFilterChange() {
    applyFilters();
    saveURLState();
}

// Apply all filters
function applyFilters() {
    filteredResults = allResults.filter(result => {
        // Date range
        const dateFrom = document.getElementById('dateFrom').value;
        const dateTo = document.getElementById('dateTo').value;

        if (dateFrom || dateTo) {
            const resultDate = new Date(result.timestamp);
            if (dateFrom && resultDate < new Date(dateFrom)) return false;
            if (dateTo && resultDate > new Date(dateTo + 'T23:59:59')) return false;
        }

        // Model filter
        const selectedModels = Array.from(document.querySelectorAll('#modelSelectContainer input:checked'))
            .map(cb => cb.value);
        if (selectedModels.length > 0 && !selectedModels.includes(result.model)) return false;

        // Category filter
        const selectedCategories = Array.from(document.querySelectorAll('#categorySelectContainer input:checked'))
            .map(cb => cb.value);
        if (selectedCategories.length > 0 && !selectedCategories.includes(result.prompt_category)) return false;

        // Level range
        const levelMin = parseInt(document.getElementById('levelMin').value);
        const levelMax = parseInt(document.getElementById('levelMax').value);
        if (result.prompt_level < levelMin || result.prompt_level > levelMax) return false;

        // Quality range
        const qualityMinInput = parseFloat(document.getElementById('qualityMin').value);
        const qualityMaxInput = parseFloat(document.getElementById('qualityMax').value);
        const qualityMin = Number.isNaN(qualityMinInput) ? 0 : qualityMinInput;
        const qualityMax = Number.isNaN(qualityMaxInput) ? 10 : qualityMaxInput;

        const isQualityFilterActive = qualityMin > 0 || qualityMax < 10;

        if (isQualityFilterActive) {
            if (result.quality_score === null || result.quality_score === undefined) return false;
            if (result.quality_score < qualityMin || result.quality_score > qualityMax) return false;
        }

        // Host filter
        const hostFilter = document.getElementById('hostFilter').value;
        if (hostFilter && result.host !== hostFilter) return false;

        // Backend filter
        const backendFilter = document.getElementById('backendFilter').value;
        if (backendFilter && result.hardware_snapshot?.backend !== backendFilter) return false;

        // Quantization filter
        const quantizationFilter = document.getElementById('quantizationFilter').value;
        if (quantizationFilter && result.hardware_snapshot?.quantization !== quantizationFilter) return false;

        // Success filter
        const successFilter = document.getElementById('successFilter').value;
        if (successFilter !== '') {
            if (successFilter === 'true' && !result.success) return false;
            if (successFilter === 'false' && result.success) return false;
        }

        // Batch ID filter
        const batchIdFilter = document.getElementById('batchIdFilter').value.trim();
        if (batchIdFilter && result.batch_id !== batchIdFilter) return false;

        // Scoring method filter
        const scoringMethodFilter = document.getElementById('scoringMethodFilter').value;
        if (scoringMethodFilter && result.scoring_method !== scoringMethodFilter) return false;

        return true;
    });

    renderTable();
    updateCharts();
    updateResultsCount();
    renderSummaryStats();
}

// Clear all filters
function clearAllFilters() {
    // Reset date inputs
    document.getElementById('dateFrom').value = '';
    document.getElementById('dateTo').value = '';

    // Uncheck all checkboxes
    document.querySelectorAll('.multi-select-item input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
    });

    // Reset ranges
    document.getElementById('levelMin').value = 1;
    document.getElementById('levelMax').value = 5;
    document.getElementById('qualityMin').value = 0;
    document.getElementById('qualityMax').value = 10;
    updateRangeDisplay('levelMin', 'levelMax', 'levelRangeDisplay');
    updateRangeDisplay('qualityMin', 'qualityMax', 'qualityRangeDisplay');

    // Reset dropdowns
    document.getElementById('hostFilter').value = '';
    document.getElementById('backendFilter').value = '';
    document.getElementById('quantizationFilter').value = '';
    document.getElementById('successFilter').value = '';
    document.getElementById('batchIdFilter').value = '';
    document.getElementById('scoringMethodFilter').value = '';

    // Clear model search
    document.getElementById('modelSearch').value = '';
    document.querySelectorAll('#modelSelectContainer .multi-select-item').forEach(item => {
        item.style.display = 'flex';
    });

    applyFilters();
    saveURLState();
}

// Render results table
function renderTable() {
    const container = document.getElementById('resultsTable');

    if (filteredResults.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-inbox"></i>
                <p>No results found matching your filters</p>
            </div>
        `;
        return;
    }

    // Apply sorting
    const sorted = sortResults([...filteredResults]);

    // Build table HTML
    const tableHtml = `
        <table class="results-table">
            <thead>
                <tr>
                    ${renderTableHeaders()}
                </tr>
            </thead>
            <tbody>
                ${sorted.map(result => renderTableRow(result)).join('')}
            </tbody>
        </table>
    `;

    container.innerHTML = tableHtml;

    // Add event listeners for checkboxes, expand buttons, and sorting
    setupTableEventListeners();
}

// Render table headers
function renderTableHeaders() {
    return Object.entries(AVAILABLE_COLUMNS)
        .filter(([key]) => visibleColumns.has(key))
        .map(([key, config]) => {
            const titleAttr = config.tooltip ? ` title="${config.tooltip}"` : '';
            if (!config.sortable) {
                return `<th style="width: ${config.width}"${titleAttr}>${config.label}</th>`;
            }

            const sortClass = currentSort.field === key
                ? (currentSort.direction === 'asc' ? 'sort-asc' : 'sort-desc')
                : '';

            return `<th class="sortable ${sortClass}" data-sort="${key}" style="width: ${config.width}"${titleAttr}>
                ${config.label}
            </th>`;
        })
        .join('');
}

// Render single table row
function renderTableRow(result) {
    const isSelected = selectedResults.has(result._id);
    const rowId = `row-${result._id}`;

    let html = `<tr data-id="${result._id}">`;

    // Select checkbox
    if (visibleColumns.has('select')) {
        html += `<td class="checkbox-cell">
            <input type="checkbox" class="result-checkbox" data-id="${result._id}" ${isSelected ? 'checked' : ''}>
        </td>`;
    }

    // Expand button
    if (visibleColumns.has('expand')) {
        html += `<td class="expand-cell">
            <button class="expand-btn" data-id="${result._id}">
                <i class="fas fa-chevron-right"></i>
            </button>
        </td>`;
    }

    // Inspect button
    if (visibleColumns.has('inspect')) {
        html += `<td>
            <button class="inspect-btn" onclick="openTestInspector('${result._id}')">
                <i class="fas fa-microscope"></i> View
            </button>
        </td>`;
    }

    // Courthouse review link
    if (visibleColumns.has('courthouse')) {
        html += `<td>
            <a href="/courthouse?result=${result._id}" class="action-link" title="Review in Courthouse" style="color:var(--accent-secondary,#d29922);font-size:0.75rem;text-decoration:none;">
                <i class="fas fa-gavel"></i>
            </a>
        </td>`;
    }

    // Data columns
    if (visibleColumns.has('model')) {
        const modelBadge = _readinessMap[result.model]
            ? (() => {
                const BADGE_CFG = {
                    profiled:    { label: '✓ Profiled',    bg: '#1a3a5c', color: '#4ecdc4' },
                    benchmarked: { label: '★ Benchmarked', bg: '#1a3a2a', color: '#2ecc71' }
                };
                const info = _readinessMap[result.model];
                const cfg = BADGE_CFG[info.stage];
                if (!cfg) return '';
                const suffix = info.totalHosts > 0 ? ` ${info.hostCount}/${info.totalHosts}` : '';
                return `<span class="ax-badge" style="background:${cfg.bg};color:${cfg.color};padding:2px 6px;border-radius:3px;font-size:10px;font-weight:600;margin-left:6px;white-space:nowrap;">${cfg.label}${suffix}</span>`;
              })()
            : '';
        html += `<td>${escapeHtml(result.model)}${modelBadge}</td>`;
    }
    if (visibleColumns.has('host')) {
        html += `<td>${escapeHtml(result.host)}</td>`;
    }
    if (visibleColumns.has('category')) {
        html += `<td><span class="badge badge-category">${result.prompt_category || 'N/A'}</span></td>`;
    }
    if (visibleColumns.has('level')) {
        html += `<td><span class="badge badge-level">L${result.prompt_level || '?'}</span></td>`;
    }
    if (visibleColumns.has('quality_score')) {
        html += `<td>${renderScore(result.quality_score)}</td>`;
    }
    if (visibleColumns.has('composite_score')) {
        html += `<td>${renderScore(result.composite_score, '0-100')}</td>`;
    }
    if (visibleColumns.has('latency')) {
        html += `<td>${result.latency ? result.latency.toFixed(0) : 'N/A'}</td>`;
    }
    if (visibleColumns.has('tokens')) {
        html += `<td>${result.tokens != null ? result.tokens : 'N/A'}</td>`;
    }
    if (visibleColumns.has('tokens_per_sec')) {
        html += `<td>${result.tokens_per_sec ? parseFloat(result.tokens_per_sec).toFixed(1) : 'N/A'}</td>`;
    }
    if (visibleColumns.has('backend')) {
        html += `<td>${result.hardware_snapshot?.backend || 'N/A'}</td>`;
    }
    if (visibleColumns.has('quantization')) {
        html += `<td>${result.hardware_snapshot?.quantization || 'N/A'}</td>`;
    }
    if (visibleColumns.has('scoring_method')) {
        html += `<td>${result.scoring_method || 'N/A'}</td>`;
    }
    if (visibleColumns.has('success')) {
        html += `<td><span class="badge badge-${result.success ? 'success' : 'failed'}">
            ${result.success ? 'Success' : 'Failed'}
        </span></td>`;
    }
    if (visibleColumns.has('batch_id')) {
        html += `<td>${result.batch_id || 'N/A'}</td>`;
    }
    if (visibleColumns.has('timestamp')) {
        html += `<td>${new Date(result.timestamp).toLocaleString()}</td>`;
    }

    html += '</tr>';

    // Add expandable row
    html += `<tr class="expanded-content" id="expanded-${result._id}" style="display: none;">
        <td colspan="${visibleColumns.size}">
            ${renderExpandedContent(result)}
        </td>
    </tr>`;

    return html;
}

// Render expanded row content
function renderExpandedContent(result) {
    return `
        <div class="expanded-grid">
            <div class="expanded-section">
                <h4>Test Details</h4>
                <div class="expanded-field">
                    <label>Prompt (${result.prompt?.length || 0} chars)</label>
                    <div class="response-box">${escapeHtml(result.prompt || 'N/A')}</div>
                </div>
                <div class="expanded-field">
                    <label>Response</label>
                    <div class="response-box">${escapeHtml(result.response || result.error || 'No response')}</div>
                </div>
            </div>
            <div class="expanded-section">
                <h4>Scoring Details</h4>
                <div class="expanded-field">
                    <label>Quality Score</label>
                    <div class="value">${result.quality_score != null ? result.quality_score.toFixed(1) : 'N/A'}</div>
                </div>
                <div class="expanded-field">
                    <label>Composite Score</label>
                    <div class="value">${result.composite_score != null ? result.composite_score.toFixed(1) : 'N/A'}</div>
                </div>
                <div class="expanded-field">
                    <label>Scoring Method</label>
                    <div class="value">${result.scoring_method || 'N/A'}</div>
                </div>
                <div class="expanded-field">
                    <label>Judge Model</label>
                    <div class="value">${result.judge_model || 'N/A'}</div>
                </div>
                ${result.quality_explanation ? `
                <div class="expanded-field">
                    <label>Explanation</label>
                    <div class="response-box">${escapeHtml(result.quality_explanation)}</div>
                </div>
                ` : ''}
                <h4 style="margin-top: 1.5rem;">Hardware Profile</h4>
                <div class="expanded-field">
                    <label>Backend</label>
                    <div class="value">${result.hardware_snapshot?.backend || 'N/A'}</div>
                </div>
                <div class="expanded-field">
                    <label>VRAM Usage</label>
                    <div class="value">${result.hardware_snapshot?.vram_usage_mb ? result.hardware_snapshot.vram_usage_mb + ' MB' : 'N/A'}</div>
                </div>
                <div class="expanded-field">
                    <label>Quantization</label>
                    <div class="value">${result.hardware_snapshot?.quantization || 'N/A'}</div>
                </div>
            </div>
        </div>
    `;
}

// Render score with color coding
// scale: '0-10' (quality_score) or '0-100' (composite_score)
function renderScore(score, scale = '0-10') {
    if (score === null || score === undefined) return 'N/A';

    let className = 'score-low';
    if (scale === '0-100') {
        if (score >= 80) className = 'score-high';
        else if (score >= 60) className = 'score-medium';
    } else {
        if (score >= 8) className = 'score-high';
        else if (score >= 6) className = 'score-medium';
    }

    return `<span class="score-display ${className}">${score.toFixed(1)}</span>`;
}

// Render pagination controls below the results table
function renderPagination() {
    let container = document.getElementById('paginationControls');
    if (!container) {
        container = document.createElement('div');
        container.id = 'paginationControls';
        container.className = 'pagination-controls';
        const tableContainer = document.querySelector('.results-table-container');
        tableContainer.parentNode.insertBefore(container, tableContainer.nextSibling);
    }

    const { page, totalPages, total, limit } = paginationState;

    if (totalPages <= 1) {
        container.innerHTML = `<span class="pagination-info">${total} result${total !== 1 ? 's' : ''}</span>`;
        return;
    }

    const start = Math.min((page - 1) * limit + 1, total);
    const end = Math.min(page * limit, total);

    container.innerHTML = `
        <button class="btn-action pagination-btn" id="paginationPrev" ${page <= 1 ? 'disabled' : ''}>
            <i class="fas fa-chevron-left"></i> Previous
        </button>
        <span class="pagination-info">
            Page ${page} of ${totalPages} &nbsp;&middot;&nbsp; ${start}-${end} of ${total} results
        </span>
        <button class="btn-action pagination-btn" id="paginationNext" ${page >= totalPages ? 'disabled' : ''}>
            Next <i class="fas fa-chevron-right"></i>
        </button>
    `;

    document.getElementById('paginationPrev').addEventListener('click', () => goToPage(page - 1));
    document.getElementById('paginationNext').addEventListener('click', () => goToPage(page + 1));
}

// Setup table event listeners
function setupTableEventListeners() {
    // Checkbox listeners
    document.querySelectorAll('.result-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const id = e.target.dataset.id;
            if (e.target.checked) {
                selectedResults.add(id);
            } else {
                selectedResults.delete(id);
            }
            updateSelectedCount();
        });
    });

    // Expand button listeners
    document.querySelectorAll('.expand-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.currentTarget.dataset.id;
            const expandedRow = document.getElementById(`expanded-${id}`);
            const button = e.currentTarget;

            if (expandedRow.style.display === 'none') {
                expandedRow.style.display = 'table-row';
                button.classList.add('expanded');
                button.closest('tr').classList.add('expanded');
            } else {
                expandedRow.style.display = 'none';
                button.classList.remove('expanded');
                button.closest('tr').classList.remove('expanded');
            }
        });
    });

    // Sort header listeners
    document.querySelectorAll('.sortable').forEach(th => {
        th.addEventListener('click', (e) => {
            const field = e.currentTarget.dataset.sort;

            if (currentSort.field === field) {
                currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                currentSort.field = field;
                currentSort.direction = 'desc';
            }

            renderTable();
        });
    });
}
