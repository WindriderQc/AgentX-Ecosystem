// Results Explorer - Advanced Benchmark Results Analysis

// Readiness badges (populated async after page load)
let _readinessMap = {};

// Global state
let allResults = [];
let filteredResults = [];
let _profilerHostMap = {};
let resultFacets = null;
let archiveTotal = 0;
let evidenceCounts = { recent: 0, aging: 0, historical: 0, undated: 0, legacy_scoring: 0 };
let evidencePolicy = { basis: 'timestamp', recent_max_age_days: 30, aging_max_age_days: 90 };
let resultsRequestSequence = 0;
let selectedResults = new Set();
let visibleColumns = new Set([
    'select', 'expand', 'inspect', 'model', 'category', 'level', 'evidence_age', 'quality_score',
    'latency', 'tokens_per_sec', 'success', 'timestamp'
]);

let currentSort = { field: 'timestamp', direction: 'desc' };

// Pagination state
let paginationState = { page: 1, limit: 50, total: 0, totalPages: 0 };

function renderExperienceState() {
    const empty = document.getElementById('results-empty-experience');
    const workbench = document.getElementById('results-data-workbench');
    const hasEvidence = archiveTotal > 0;
    setExperienceSurfaceHidden(empty, hasEvidence);
    setExperienceSurfaceHidden(workbench, !hasEvidence);
}

function setExperienceSurfaceHidden(element, hidden) {
    if (!element) return;
    element.hidden = hidden;
    element.inert = hidden;
    if (hidden) element.setAttribute('aria-hidden', 'true');
    else element.removeAttribute('aria-hidden');
}

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
    evidence_age: { label: 'Evidence age', sortable: false, width: '150px', tooltip: 'Recent means recorded within 30 days; aging means 31–90 days; historical means older than 90 days. This is based only on the recorded timestamp.' },
    timestamp: { label: 'Recorded at', sortable: true, width: '180px', tooltip: 'Exact time when this result was recorded. Newest results are shown first by default.' }
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

// ── Server-backed filtering and URL state ───────────────────────────────────

const SERVER_SORT_FIELDS = {
    model: 'model',
    host: 'host',
    category: 'prompt_category',
    level: 'prompt_level',
    quality_score: 'quality_score',
    composite_score: 'composite_score',
    latency: 'latency',
    tokens: 'tokens',
    tokens_per_sec: 'tokens_per_sec',
    backend: 'hardware_snapshot.backend',
    quantization: 'hardware_snapshot.quantization',
    scoring_method: 'scoring_method',
    success: 'success',
    batch_id: 'batch_id',
    timestamp: 'timestamp'
};

function selectedValues(containerSelector) {
    return Array.from(document.querySelectorAll(`${containerSelector} input[type="checkbox"]:checked`))
        .map(cb => cb.value);
}

function readFilterState() {
    return {
        dateFrom: document.getElementById('dateFrom')?.value || '',
        dateTo: document.getElementById('dateTo')?.value || '',
        models: selectedValues('#modelSelectContainer'),
        categories: selectedValues('#categorySelectContainer'),
        levelMin: document.getElementById('levelMin')?.value || '1',
        levelMax: document.getElementById('levelMax')?.value || '5',
        qualityMin: document.getElementById('qualityMin')?.value || '0',
        qualityMax: document.getElementById('qualityMax')?.value || '10',
        host: document.getElementById('hostFilter')?.value || '',
        backend: document.getElementById('backendFilter')?.value || '',
        quantization: document.getElementById('quantizationFilter')?.value || '',
        success: document.getElementById('successFilter')?.value || '',
        batchId: document.getElementById('batchIdFilter')?.value.trim() || '',
        scoringMethod: document.getElementById('scoringMethodFilter')?.value || '',
        evidenceEra: document.getElementById('evidenceEraFilter')?.value || ''
    };
}

function parseURLState() {
    const params = new URLSearchParams(location.search);
    const sortParam = params.get('sort') || '';
    const [sortField, sortDirection] = sortParam.split(':');
    if (SERVER_SORT_FIELDS[sortField]) currentSort.field = sortField;
    if (sortDirection === 'asc' || sortDirection === 'desc') currentSort.direction = sortDirection;

    const page = parseInt(params.get('page'), 10);
    paginationState.page = page > 0 ? page : 1;
    return {
        dateFrom: params.get('dateFrom') || '',
        dateTo: params.get('dateTo') || '',
        models: (params.get('models') || '').split(',').filter(Boolean),
        categories: (params.get('categories') || '').split(',').filter(Boolean),
        levelMin: params.get('levelMin') || '1',
        levelMax: params.get('levelMax') || '5',
        qualityMin: params.get('qualityMin') || '0',
        qualityMax: params.get('qualityMax') || '10',
        host: params.get('host') || '',
        backend: params.get('backend') || '',
        quantization: params.get('quantization') || '',
        success: params.get('success') || '',
        batchId: params.get('batchId') || params.get('batch') || '',
        scoringMethod: params.get('scoringMethod') || params.get('scoring') || '',
        evidenceEra: params.get('evidenceEra') || ''
    };
}

function applyFilterState(state = {}) {
    const valuesById = {
        dateFrom: state.dateFrom,
        dateTo: state.dateTo,
        levelMin: state.levelMin,
        levelMax: state.levelMax,
        qualityMin: state.qualityMin,
        qualityMax: state.qualityMax,
        hostFilter: state.host,
        backendFilter: state.backend,
        quantizationFilter: state.quantization,
        successFilter: state.success,
        batchIdFilter: state.batchId,
        scoringMethodFilter: state.scoringMethod,
        evidenceEraFilter: state.evidenceEra
    };
    Object.entries(valuesById).forEach(([id, value]) => {
        const element = document.getElementById(id);
        if (element && value !== undefined && value !== null) element.value = value;
    });

    const wantedModels = new Set(state.models || []);
    const wantedCategories = new Set(state.categories || []);
    document.querySelectorAll('#modelSelectContainer input[type="checkbox"]').forEach(cb => {
        cb.checked = wantedModels.has(cb.value);
    });
    document.querySelectorAll('#categorySelectContainer input[type="checkbox"]').forEach(cb => {
        cb.checked = wantedCategories.has(cb.value);
    });
    updateRangeDisplayText('levelMin', 'levelMax', 'levelRangeDisplay');
    updateRangeDisplayText('qualityMin', 'qualityMax', 'qualityRangeDisplay');
}

function saveURLState() {
    const state = readFilterState();
    const params = new URLSearchParams();
    if (state.dateFrom) params.set('dateFrom', state.dateFrom);
    if (state.dateTo) params.set('dateTo', state.dateTo);
    if (state.models.length) params.set('models', state.models.join(','));
    if (state.categories.length) params.set('categories', state.categories.join(','));
    if (state.levelMin !== '1') params.set('levelMin', state.levelMin);
    if (state.levelMax !== '5') params.set('levelMax', state.levelMax);
    if (state.qualityMin !== '0') params.set('qualityMin', state.qualityMin);
    if (state.qualityMax !== '10') params.set('qualityMax', state.qualityMax);
    if (state.host) params.set('host', state.host);
    if (state.backend) params.set('backend', state.backend);
    if (state.quantization) params.set('quantization', state.quantization);
    if (state.success) params.set('success', state.success);
    if (state.batchId) params.set('batchId', state.batchId);
    if (state.scoringMethod) params.set('scoringMethod', state.scoringMethod);
    if (state.evidenceEra) params.set('evidenceEra', state.evidenceEra);
    if (currentSort.field !== 'timestamp' || currentSort.direction !== 'desc') {
        params.set('sort', `${currentSort.field}:${currentSort.direction}`);
    }
    if (paginationState.page > 1) params.set('page', paginationState.page);

    const qs = params.toString();
    const url = qs ? `${location.pathname}?${qs}` : location.pathname;
    history.replaceState(null, '', url);
}

function buildResultsParams(page, filterState = {}, includeFacets = false) {
    const params = new URLSearchParams({
        limit: String(paginationState.limit),
        offset: String((Math.max(1, page) - 1) * paginationState.limit),
        sort: SERVER_SORT_FIELDS[currentSort.field] || 'timestamp',
        sortDir: currentSort.direction,
        includeEvidenceMeta: 'true'
    });
    if (includeFacets) params.set('includeFacets', 'true');
    ['dateFrom', 'dateTo', 'host', 'backend', 'quantization', 'success', 'batchId', 'scoringMethod', 'evidenceEra']
        .forEach(key => {
            if (filterState[key] !== undefined && filterState[key] !== '') params.set(key, filterState[key]);
        });
    if (filterState.models?.length) params.set('models', filterState.models.join(','));
    if (filterState.categories?.length) params.set('categories', filterState.categories.join(','));
    if (String(filterState.levelMin || '1') !== '1') params.set('levelMin', filterState.levelMin);
    if (String(filterState.levelMax || '5') !== '5') params.set('levelMax', filterState.levelMax);
    if (String(filterState.qualityMin || '0') !== '0') params.set('qualityMin', filterState.qualityMin);
    if (String(filterState.qualityMax || '10') !== '10') params.set('qualityMax', filterState.qualityMax);
    return params;
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
    // Load readiness badges in the background; re-render table when ready
    try {
        const mod = await import('/js/model-profiler/components/readiness-cache.js');
        _readinessMap = await mod.getReadinessMap();
    } catch (_) {}

    const initialState = parseURLState();
    const loaded = await loadResults(paginationState.page, {
        filterState: initialState,
        includeFacets: true,
        render: false
    });
    initializeFilters();
    applyFilterState(initialState);
    setupEventListeners();
    if (loaded) renderExplorerData();
});

// Load benchmark results for the current page
async function loadResults(page, { filterState = readFilterState(), includeFacets = false, render = true } = {}) {
    if (page !== undefined) paginationState.page = page;
    const requestId = ++resultsRequestSequence;
    try {
        const params = buildResultsParams(paginationState.page, filterState, includeFacets);
        const [resultsRes, hostsRes] = await Promise.all([
            fetch(`/api/benchmark/results/advanced?${params.toString()}`),
            includeFacets ? fetch('/api/profiler/hosts').catch(() => null) : Promise.resolve(null)
        ]);
        if (!resultsRes.ok) throw new Error('Failed to fetch results');

        const data = await resultsRes.json();
        if (requestId !== resultsRequestSequence) return false;
        const payload = data.data || {};
        allResults = payload.results || [];
        filteredResults = [...allResults];

        // Update pagination state from server response
        paginationState.page = payload.page || 1;
        paginationState.limit = payload.limit || 50;
        paginationState.total = Number(payload.total) || 0;
        paginationState.totalPages = Number(payload.totalPages) || 0;
        archiveTotal = Number(payload.archiveTotal) || 0;
        evidenceCounts = { ...evidenceCounts, ...(payload.evidenceCounts || {}) };
        evidencePolicy = { ...evidencePolicy, ...(payload.evidencePolicy || {}) };
        if (payload.facets) resultFacets = payload.facets;

        // Build host name map from profiler for friendly display
        if (hostsRes) {
            _profilerHostMap = {};
            try {
                const hostData = await hostsRes.json();
                const hosts = hostData?.data || hostData || [];
                if (Array.isArray(hosts)) {
                    hosts.forEach(h => {
                        const url = h.hostUrl || h.url || '';
                        if (url && h.name) _profilerHostMap[url] = h.name;
                    });
                }
            } catch (_) {}
        }

        // A saved page can become invalid after filters or deletions. Land on
        // the final real page rather than showing an impossible empty page.
        if (paginationState.totalPages > 0 && paginationState.page > paginationState.totalPages) {
            return loadResults(paginationState.totalPages, { filterState, render });
        }

        selectedResults.clear();
        updateSelectedCount();
        if (render) renderExplorerData();

        console.log(`Loaded ${allResults.length} results (page ${paginationState.page}/${paginationState.totalPages}, total ${paginationState.total})`);
        return true;
    } catch (error) {
        if (requestId !== resultsRequestSequence) return false;
        console.error('Error loading results:', error);
        showError('Failed to load results: ' + error.message);
        return false;
    }
}

function renderExplorerData() {
    renderExperienceState();
    renderTable();
    updateCharts();
    updateResultsCount();
    renderSummaryStats();
    renderPagination();
    renderEvidenceScope();
}

// Navigate to a specific page
async function goToPage(page) {
    if (page < 1 || page > paginationState.totalPages) return;
    await loadResults(page, { filterState: readFilterState() });
    saveURLState();
}

// Initialize filter options
function initializeFilters() {
    // Populate model multi-select
    const models = [...new Set((resultFacets?.models || allResults.map(r => r.model)).filter(Boolean))].sort();
    populateMultiSelect('modelSelectContainer', models, 'model');

    // Populate category multi-select
    populateMultiSelect('categorySelectContainer', CATEGORIES, 'category');

    // Populate host dropdown — merge result hosts + profiler hosts
    const resultHosts = [...new Set((resultFacets?.hosts || allResults.map(r => r.host)).filter(Boolean))];
    const profilerHosts = Object.keys(_profilerHostMap);
    const allHosts = [...new Set([...resultHosts, ...profilerHosts])].sort();
    const hostSelect = document.getElementById('hostFilter');
    hostSelect.querySelectorAll('option:not(:first-child)').forEach(option => option.remove());
    allHosts.forEach(url => {
        const name = _profilerHostMap[url];
        const opt = document.createElement('option');
        opt.value = url;
        opt.textContent = name ? `${name} (${url})` : url;
        hostSelect.appendChild(opt);
    });

    // Populate quantization dropdown
    const quantizations = [...new Set((resultFacets?.quantizations || allResults
        .filter(r => r.hardware_snapshot?.quantization)
        .map(r => r.hardware_snapshot.quantization)).filter(Boolean))].sort();
    populateDropdown('quantizationFilter', quantizations);

    // Populate backend dropdown
    const backends = [...new Set((resultFacets?.backends || allResults
        .filter(r => r.hardware_snapshot?.backend)
        .map(r => r.hardware_snapshot.backend)).filter(Boolean))].sort();
    populateDropdown('backendFilter', backends);

    // Populate scoring method dropdown
    const methods = [...new Set((resultFacets?.scoring_methods || allResults
        .filter(r => r.scoring_method)
        .map(r => r.scoring_method)).filter(Boolean))].sort();
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
function updateRangeDisplayText(minId, maxId, displayId) {
    const min = document.getElementById(minId);
    const max = document.getElementById(maxId);
    const display = document.getElementById(displayId);
    if (!min || !max || !display) return;
    display.textContent = `${min.value} - ${max.value}`;
}

function updateRangeDisplay(minId, maxId, displayId) {
    const min = document.getElementById(minId);
    const max = document.getElementById(maxId);
    const display = document.getElementById(displayId);

    const update = () => {
        const minVal = Number(min.value);
        const maxVal = Number(max.value);

        // Ensure min <= max
        if (minVal > maxVal) {
            if (min === document.activeElement) {
                max.value = minVal;
            } else {
                min.value = maxVal;
            }
        }

        updateRangeDisplayText(minId, maxId, displayId);
    };

    min.addEventListener('input', update);
    max.addEventListener('input', update);
    update();
}

// Setup event listeners
function setupEventListeners() {
    // Refresh button
    document.getElementById('refreshBtn').addEventListener('click', async () => {
        await loadResults(paginationState.page, { filterState: readFilterState() });
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
async function handleFilterChange() {
    await applyFilters({ page: 1 });
}

// Apply all filters
async function applyFilters({ page = 1 } = {}) {
    await loadResults(page, { filterState: readFilterState() });
    saveURLState();
}

// Clear all filters
async function clearAllFilters() {
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
    updateRangeDisplayText('levelMin', 'levelMax', 'levelRangeDisplay');
    updateRangeDisplayText('qualityMin', 'qualityMax', 'qualityRangeDisplay');

    // Reset dropdowns
    document.getElementById('hostFilter').value = '';
    document.getElementById('backendFilter').value = '';
    document.getElementById('quantizationFilter').value = '';
    document.getElementById('successFilter').value = '';
    document.getElementById('batchIdFilter').value = '';
    document.getElementById('scoringMethodFilter').value = '';
    document.getElementById('evidenceEraFilter').value = '';

    // Clear model search
    document.getElementById('modelSearch').value = '';
    document.querySelectorAll('#modelSelectContainer .multi-select-item').forEach(item => {
        item.style.display = 'flex';
    });

    await applyFilters({ page: 1 });
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

    // The API owns ordering so pagination and sorting describe the same full
    // result set. Never re-sort only the visible page in the browser.
    const sorted = filteredResults;

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
    const evidenceEra = ['recent', 'aging', 'historical', 'undated'].includes(result.evidence_era)
        ? result.evidence_era
        : 'undated';

    let html = `<tr data-id="${result._id}" class="result-era-${evidenceEra}">`;

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
    if (visibleColumns.has('evidence_age')) {
        html += `<td>${renderEvidenceAge(result)}</td>`;
    }
    if (visibleColumns.has('timestamp')) {
        html += `<td>${formatRecordedAt(result)}</td>`;
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

function renderEvidenceAge(result) {
    const era = ['recent', 'aging', 'historical', 'undated'].includes(result.evidence_era)
        ? result.evidence_era
        : 'undated';
    const labels = {
        recent: 'Recent',
        aging: 'Aging',
        historical: 'Historical',
        undated: 'Undated'
    };
    const rawAge = result.evidence_age_days;
    const age = rawAge === null || rawAge === undefined ? null : Number(rawAge);
    const ageText = Number.isFinite(age)
        ? (age < 1 ? '<1 day old' : (age === 1 ? '1 day old' : `${age} days old`))
        : 'age unavailable';
    const legacy = result.legacy_scoring
        ? '<span class="evidence-era-badge evidence-era-legacy" title="This record explicitly stores composite_formula=legacy.">Legacy scoring</span>'
        : '';
    return `<span class="evidence-age-cell">
        <span class="evidence-era-badge evidence-era-${era}">${labels[era]}</span>
        <small>${ageText}</small>${legacy}
    </span>`;
}

function formatRecordedAt(result) {
    const raw = result.evidence_recorded_at || result.timestamp;
    const date = new Date(raw);
    if (!raw || !Number.isFinite(date.getTime())) return '<span class="evidence-undated-text">Not recorded</span>';
    return `<time datetime="${date.toISOString()}" title="${date.toISOString()}">${escapeHtml(date.toLocaleString())}</time>`;
}

function renderEvidenceScope() {
    const scope = document.getElementById('resultsEvidenceScope');
    const policyRule = document.getElementById('evidenceAgeGuideRule');
    if (policyRule) {
        const recentMax = Number(evidencePolicy.recent_max_age_days) || 30;
        const agingMax = Number(evidencePolicy.aging_max_age_days) || 90;
        policyRule.textContent = `Recent: within ${recentMax} days. Aging: more than ${recentMax} through ${agingMax} days. Historical: more than ${agingMax} days. “Legacy scoring” appears only when that exact formula is stored on the result.`;
    }
    if (!scope) return;
    if (paginationState.total === 0) {
        scope.textContent = archiveTotal > 0
            ? `No archive results match these filters. ${archiveTotal} total result${archiveTotal === 1 ? '' : 's'} remain in the archive.`
            : 'No recorded evaluation evidence is available.';
        return;
    }
    const start = (paginationState.page - 1) * paginationState.limit + 1;
    const end = start + allResults.length - 1;
    scope.textContent = `Showing ${start}–${end} of ${paginationState.total} matching results, newest first by default. Charts and detailed aggregates summarize this visible page.`;
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
        container.innerHTML = `<span class="pagination-info">${total} matching result${total !== 1 ? 's' : ''}</span>`;
        return;
    }

    const start = Math.min((page - 1) * limit + 1, total);
    const end = Math.min(start + allResults.length - 1, total);

    container.innerHTML = `
        <button class="btn-action pagination-btn" id="paginationPrev" ${page <= 1 ? 'disabled' : ''}>
            <i class="fas fa-chevron-left"></i> Previous
        </button>
        <span class="pagination-info">
            Page ${page} of ${totalPages} &nbsp;&middot;&nbsp; ${start}-${end} of ${total} matching results
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
        th.addEventListener('click', async (e) => {
            const field = e.currentTarget.dataset.sort;

            if (currentSort.field === field) {
                currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                currentSort.field = field;
                currentSort.direction = 'desc';
            }

            await loadResults(1, { filterState: readFilterState() });
            saveURLState();
        });
    });
}
