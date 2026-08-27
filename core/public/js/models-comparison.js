/**
 * Model Comparison Logic
 * Powers both the inline selection workspace and the full comparison modal.
 */

function escapeComparisonHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
}

function formatContext(model) {
    const rawContext = model.executionOverrides?.num_ctx
        || model.capabilities?.maxContext
        || model.details?.context_length;

    if (!rawContext) return '--';
    return rawContext >= 1024 ? `${Math.round(rawContext / 1024)}k` : String(rawContext);
}

function formatProvider(provider) {
    if (provider === 'ollama') return 'Ollama';
    return provider || 'Custom';
}

function providerBadgeClass(provider) {
    if (provider === 'ollama') return 'badge-orange';
    return 'badge-indigo';
}

function formatSize(bytes) {
    if (!bytes) return '--';
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatStatus(model, unifiedModels) {
    if (model.deployment?.status === 'gone') return 'Removed from host';

    const loaded = unifiedModels.isModelLoaded(model);
    if (loaded === true) return 'Loaded in VRAM';
    if (loaded === false) return 'Installed';
    return 'Unknown';
}

class ModelComparator {
    constructor(unifiedModels) {
        this.unifiedModels = unifiedModels;
        this.modal = document.getElementById('comparisonModal');
        this.container = document.getElementById('comparisonContainer');

        this.setupEventListeners();
    }

    setupEventListeners() {
        this.modal?.querySelector('.close-modal')?.addEventListener('click', () => {
            this.modal.classList.remove('active');
        });
    }

    renderSelection(models) {
        const target = this.unifiedModels.compareContentEl;
        if (!target) return;
        target.className = 'compare-content';

        if (models.length === 0) {
            target.innerHTML = '<div class="compare-empty">Select models with the + button in the table to inspect or compare them here.</div>';
            return;
        }

        if (models.length === 1) {
            this.renderSingleModel(models[0], target);
            return;
        }

        this.renderComparison(models, target, { inline: true });
    }

    openComparison() {
        const models = this.unifiedModels.getSelectedModels();
        if (models.length < 2) {
            alert('Please select at least 2 models to compare.');
            return;
        }

        this.renderComparison(models, this.container, { inline: false });
        this.modal?.classList.add('active');
    }

    renderSingleModel(model, target) {
        const provider = formatProvider(model.provider);
        const source = model.provider || 'custom';
        const host = model.source?.hostName || model.source?.url || '--';
        const score = model.benchmarkStats?.avgCompositeScore;
        const speed = model.capabilities?.avgTokensPerSec;
        const tags = (model.tags || []).map(tag => `<span class="micro-tag">${escapeComparisonHtml(tag)}</span>`).join('');
        const categories = (model.categories || []).map(category => `<span class="micro-tag">${escapeComparisonHtml(category)}</span>`).join('');

        target.innerHTML = `
            <div class="single-model-panel">
                <div class="single-model-hero">
                    <div class="single-model-title">
                        <div class="model-icon ${escapeComparisonHtml(source)}">${this.unifiedModels.getIconForSource(source)}</div>
                        <div>
                            <h4>${escapeComparisonHtml(model.displayName || model.name)}</h4>
                            <p>${escapeComparisonHtml(model.vendor || provider)}${host !== '--' ? ` · ${escapeComparisonHtml(host)}` : ''}</p>
                            ${model.description ? `<p style="margin-top:8px;">${escapeComparisonHtml(model.description)}</p>` : ''}
                        </div>
                    </div>
                    <div class="single-model-actions">
                        <button type="button" class="btn-primary compare-action-chat"><i class="fas fa-comment-alt"></i> Chat</button>
                        <button type="button" class="btn-secondary compare-action-details"><i class="fas fa-circle-info"></i> Full Details</button>
                        <button type="button" class="btn-secondary compare-action-config"><i class="fas fa-sliders-h"></i> Config</button>
                    </div>
                </div>
                <div class="single-model-grid">
                    <div class="single-model-stat">
                        <span class="single-model-stat-label">Provider</span>
                        <span class="single-model-stat-value"><span class="badge ${providerBadgeClass(model.provider)}">${escapeComparisonHtml(provider)}</span></span>
                    </div>
                    <div class="single-model-stat">
                        <span class="single-model-stat-label">Status</span>
                        <span class="single-model-stat-value">${escapeComparisonHtml(formatStatus(model, this.unifiedModels))}</span>
                    </div>
                    <div class="single-model-stat">
                        <span class="single-model-stat-label">Parameters</span>
                        <span class="single-model-stat-value">${escapeComparisonHtml(model.details?.parameter_size || model.parameterSize || model.parameters || '--')}</span>
                    </div>
                    <div class="single-model-stat">
                        <span class="single-model-stat-label">Context</span>
                        <span class="single-model-stat-value">${escapeComparisonHtml(formatContext(model))}</span>
                    </div>
                    <div class="single-model-stat">
                        <span class="single-model-stat-label">Benchmark Score</span>
                        <span class="single-model-stat-value">${score ? score.toFixed(1) : '--'}</span>
                    </div>
                    <div class="single-model-stat">
                        <span class="single-model-stat-label">Speed</span>
                        <span class="single-model-stat-value">${speed ? `${speed.toFixed(1)} t/s` : '--'}</span>
                    </div>
                    <div class="single-model-stat">
                        <span class="single-model-stat-label">Quantization</span>
                        <span class="single-model-stat-value">${escapeComparisonHtml(model.details?.quantization_level || model.quantization || '--')}</span>
                    </div>
                    <div class="single-model-stat">
                        <span class="single-model-stat-label">Disk Size</span>
                        <span class="single-model-stat-value">${escapeComparisonHtml(formatSize(model.size))}</span>
                    </div>
                </div>
                <div class="single-model-tags">
                    ${categories || '<span class="micro-tag">No categories</span>'}
                    ${tags || '<span class="micro-tag">No tags</span>'}
                </div>
            </div>
        `;

        target.querySelector('.compare-action-chat')?.addEventListener('click', () => {
            window.location.href = `/playground?model=${encodeURIComponent(model.name)}`;
        });
        target.querySelector('.compare-action-details')?.addEventListener('click', () => {
            this.unifiedModels.openDetailDrawer(model);
        });
        target.querySelector('.compare-action-config')?.addEventListener('click', () => {
            if (window.modelExecutionConfig) window.modelExecutionConfig.open(model.name);
        });
    }

    renderComparison(models, target = this.container, options = {}) {
        if (!target) return;

        const rows = [
            {
                label: 'Provider',
                render: (model) => `<span class="badge ${providerBadgeClass(model.provider)}">${escapeComparisonHtml(formatProvider(model.provider))}</span>`
            },
            {
                label: 'Host',
                render: (model) => escapeComparisonHtml(model.source?.hostName || model.source?.url || '--')
            },
            {
                label: 'Status',
                render: (model) => escapeComparisonHtml(formatStatus(model, this.unifiedModels))
            },
            {
                label: 'Parameters',
                render: (model) => escapeComparisonHtml(model.details?.parameter_size || model.parameterSize || model.parameters || '--')
            },
            {
                label: 'Context',
                render: (model) => escapeComparisonHtml(formatContext(model)),
                value: (model) => model.executionOverrides?.num_ctx || model.capabilities?.maxContext || model.details?.context_length || 0
            },
            {
                label: 'Benchmark Score',
                render: (model) => {
                    const score = model.benchmarkStats?.avgCompositeScore;
                    return score ? score.toFixed(1) : '--';
                },
                value: (model) => model.benchmarkStats?.avgCompositeScore || 0,
                cellClass: 'comp-cell--score'
            },
            {
                label: 'Speed',
                render: (model) => {
                    const speed = model.capabilities?.avgTokensPerSec;
                    return speed ? `${speed.toFixed(1)} t/s` : '--';
                },
                value: (model) => model.capabilities?.avgTokensPerSec || 0
            },
            {
                label: 'Thinking',
                render: (model) => model.capabilities?.supportsThinking ? 'Yes' : 'No'
            },
            {
                label: 'Vision',
                render: (model) => model.capabilities?.supportsVision ? 'Yes' : 'No'
            },
            {
                label: 'Judge Tier',
                render: (model) => escapeComparisonHtml(model.capabilities?.judgeTier || model.capabilities?.curatedJudgeTier || '--')
            },
            {
                label: 'Quantization',
                render: (model) => escapeComparisonHtml(model.details?.quantization_level || model.quantization || '--')
            },
            {
                label: 'Categories',
                render: (model) => escapeComparisonHtml((model.categories || []).join(', ') || '--')
            },
            {
                label: 'Tags',
                render: (model) => escapeComparisonHtml((model.tags || []).slice(0, 4).join(', ') || '--')
            }
        ];

        target.className = options.inline
            ? 'compare-content comparison-grid comparison-grid-inline'
            : 'comparison-grid';
        target.style.gridTemplateColumns = `180px repeat(${models.length}, minmax(220px, 1fr))`;

        let html = '<div class="comp-header">Model</div>';
        models.forEach(model => {
            const meta = [
                model.vendor,
                model.source?.hostName || model.source?.url,
                model.details?.parameter_size || model.parameterSize || model.parameters
            ].filter(Boolean).join(' · ');
            html += `
                <div class="comp-cell model-header-cell">
                    <div class="model-header-name">${escapeComparisonHtml(model.name)}</div>
                    <div class="model-header-meta">${escapeComparisonHtml(meta || formatProvider(model.provider))}</div>
                </div>
            `;
        });

        rows.forEach(row => {
            const numericValues = typeof row.value === 'function'
                ? models.map(model => row.value(model)).filter(value => typeof value === 'number' && value > 0)
                : [];
            const bestValue = numericValues.length ? Math.max(...numericValues) : null;

            html += `<div class="comp-header">${row.label}</div>`;
            models.forEach(model => {
                const value = typeof row.value === 'function' ? row.value(model) : null;
                const winnerClass = bestValue != null && value === bestValue ? ' comp-cell--winner' : '';
                const extraClass = row.cellClass ? ` ${row.cellClass}` : '';
                html += `<div class="comp-cell${winnerClass}${extraClass}">${row.render(model)}</div>`;
            });
        });

        target.innerHTML = html;
    }
}

window.ModelComparator = ModelComparator;
