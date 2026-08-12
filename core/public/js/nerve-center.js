/**
 * Nerve Center — Shared controller and summary strip.
 */

const NerveCenter = (() => {
    'use strict';

    const POLL_INTERVAL = 30_000;
    const STORAGE_KEY = 'nc_section_states';
    const HOT_STATES = new Set(['READY']);
    const HOST_ORDER = ['primary', 'secondary', 'tertiary'];

    let _poller = null;
    const _scriptPromises = {};

    function fetchJson(url, options) {
        return fetch(url, options).then(async response => {
            const json = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(json.message || `Request failed (${response.status})`);
            }
            return json;
        });
    }

    function normalizeHostUrl(hostUrl) {
        if (!hostUrl) return '';
        return String(hostUrl).replace(/\/+$/, '');
    }

    const escapeHtml = (value) => window.AgentXUtils.escapeHtml(value);

    function timeAgo(dateStr) {
        if (!dateStr) return 'never';
        const diff = Date.now() - new Date(dateStr).getTime();
        if (diff < 0) return 'just now';
        if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
        if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
        if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
        return `${Math.floor(diff / 86_400_000)}d ago`;
    }

    function shortModel(model) {
        if (!model) return '--';
        let short = String(model).replace(/:latest$/, '');
        if (short.length > 30) short = `${short.slice(0, 27)}...`;
        return short;
    }

    function hostStateBadge(state) {
        const map = {
            READY: { label: 'Ready', color: '#4ade80' },
            BUMPED: { label: 'Bumped', color: '#f59e0b' },
            RELOADING: { label: 'Reloading', color: '#f59e0b' },
            UNKNOWN: { label: 'UNKNOWN', color: '#f87171' }
        };
        const entry = map[state] || map.UNKNOWN;
        return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:0.04em;background:${entry.color}22;color:${entry.color};border:1px solid ${entry.color}44;">${entry.label}</span>`;
    }

    function hostKeyFromUrl(url, hosts) {
        if (!url || !hosts) return url || '--';
        const normalizedUrl = normalizeHostUrl(url);
        for (const [key, hostUrl] of Object.entries(hosts)) {
            if (normalizeHostUrl(hostUrl) === normalizedUrl) return key;
        }
        return url;
    }

    function formatUptime(seconds) {
        if (!seconds || seconds <= 0) return '--';
        const days = Math.floor(seconds / 86_400);
        const hours = Math.floor((seconds % 86_400) / 3_600);
        const minutes = Math.floor((seconds % 3_600) / 60);
        if (days > 0) return `${days}d ${hours}h`;
        if (hours > 0) return `${hours}h ${minutes}m`;
        return `${minutes}m`;
    }

    function formatCurrency(value) {
        if (!Number.isFinite(value)) return '--';
        if (value === 0) return '$0.00';
        if (value < 0.01) return `$${value.toFixed(4)}`;
        return `$${value.toFixed(2)}`;
    }

    function sortHostKeys(keys) {
        return [...keys].sort((left, right) => {
            const leftIndex = HOST_ORDER.indexOf(left);
            const rightIndex = HOST_ORDER.indexOf(right);
            if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
            if (leftIndex === -1) return 1;
            if (rightIndex === -1) return -1;
            return leftIndex - rightIndex;
        });
    }

    function getSectionLoader(name) {
        const loaders = {
            ecosystem: () => loadEcosystemSection(),
            fastlane: () => window.NerveCenterFastlane?.loadFastlane?.(),
            routing: () => window.NerveCenterRouting?.loadRouting?.(),
            cluster: () => window.NerveCenterCluster?.loadCluster?.(),
            health: () => window.NerveCenterHealth?.loadHealth?.(),
            performance: () => window.NerveCenterPerformance?.loadPerformance?.(),
            inference: () => window.NerveCenterInference?.loadInference?.(),
            'inference-health': () => window.NerveCenterInferenceHealth?.loadInferenceHealth?.(),
            capacity: () => window.NerveCenterCapacity?.loadCapacity?.(),
            alerts: () => window.NerveCenterAlerts?.loadAlerts?.(),
            rag: () => window.NerveCenterRag?.loadRag?.(),
            tasks: () => window.NerveCenterTasks?.loadTasks?.(),
            hermes: () => window.NerveCenterHermes?.loadHermes?.(),
            openclaw: () => window.NerveCenterOpenclaw?.loadOpenclaw?.()
        };
        return loaders[name];
    }

    function loadScriptOnce(src) {
        if (_scriptPromises[src]) return _scriptPromises[src];
        _scriptPromises[src] = new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[src="${src}"]`);
            if (existing) {
                existing.addEventListener('load', resolve, { once: true });
                existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
                return;
            }
            const script = document.createElement('script');
            script.src = src;
            script.async = false;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.head.appendChild(script);
        });
        return _scriptPromises[src];
    }

    async function loadEcosystemSection() {
        if (!window.NerveCenterEcosystem?.loadEcosystem) {
            await loadScriptOnce('/js/nerve-center-ecosystem.js');
        }
        return window.NerveCenterEcosystem?.loadEcosystem?.();
    }

    function loadSection(name) {
        const loader = getSectionLoader(name);
        if (typeof loader === 'function') {
            return loader();
        }
        return Promise.resolve();
    }

    function attachCollapsibleHandlers(root = document) {
        root.querySelectorAll('.nc-collapsible-header').forEach(header => {
            if (header.dataset.boundCollapse === 'true') return;
            header.dataset.boundCollapse = 'true';
            header.setAttribute('role', 'button');
            header.setAttribute('tabindex', '0');

            const toggle = () => {
                const container = header.closest('.nc-collapsible');
                if (!container) return;
                container.classList.toggle('open');
            };

            header.addEventListener('click', event => {
                if (event.target.closest('button, a, select, input')) return;
                toggle();
            });

            header.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                toggle();
            });
        });
    }

    function init() {
        restoreSectionStates();
        expandHashSection();
        setupWidgetClicks();
        setupControls();

        loadSummary();
        loadSection('ecosystem');
        loadSection('cluster');
        loadSection('routing');
        loadSection('fastlane');
        loadSection('health');
        loadSection('performance');
        loadSection('inference');
        loadSection('inference-health');
        loadSection('capacity');
        loadSection('alerts');
        loadSection('rag');
        loadSection('tasks');
        loadSection('hermes');
        loadSection('openclaw');

        _poller = new window.PollingController();
        _poller.addTask('summary', loadSummary, POLL_INTERVAL);
        _poller.start();
    }

    function toggleSection(sectionId) {
        const section = document.getElementById(sectionId);
        if (!section) return;
        section.classList.toggle('collapsed');
        saveSectionStates();
    }

    function saveSectionStates() {
        const sections = document.querySelectorAll('.nc-section');
        const states = {};
        sections.forEach(section => {
            states[section.id] = section.classList.contains('collapsed');
        });
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(states));
        } catch (_) {
            // Ignore storage failures.
        }
    }

    // Sections collapsed by default for new users (no saved prefs)
    const DEFAULT_COLLAPSED = ['sectionHealth', 'sectionInference', 'sectionAlerts', 'sectionPerformance', 'sectionRag', 'sectionTasks', 'sectionHermes', 'sectionOpenclaw'];

    function restoreSectionStates() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                // First visit — apply defaults
                DEFAULT_COLLAPSED.forEach(id => {
                    const section = document.getElementById(id);
                    if (section) section.classList.add('collapsed');
                });
                return;
            }
            const states = JSON.parse(raw);
            Object.entries(states).forEach(([id, collapsed]) => {
                const section = document.getElementById(id);
                if (section && collapsed) {
                    section.classList.add('collapsed');
                }
            });
        } catch (_) {
            // Ignore missing or invalid storage state.
        }
    }

    function expandHashSection() {
        const hash = String(window.location.hash || '').replace(/^#/, '');
        if (!hash) return;
        const section = document.getElementById(hash);
        if (!section || !section.classList.contains('collapsed')) return;
        section.classList.remove('collapsed');
        saveSectionStates();
    }

    function setupWidgetClicks() {
        const sectionMap = {
            cluster: 'sectionCluster',
            ecosystem: 'sectionEcosystem',
            routing: 'sectionRouting',
            fastlane: 'sectionFastlane',
            health: 'sectionHealth',
            performance: 'sectionPerformance'
        };

        document.querySelectorAll('.nc-widget[data-scroll]').forEach(widget => {
            widget.addEventListener('click', () => {
                const targetId = sectionMap[widget.dataset.scroll];
                if (!targetId) return;

                const section = document.getElementById(targetId);
                if (!section) return;

                if (section.classList.contains('collapsed')) {
                    section.classList.remove('collapsed');
                    saveSectionStates();
                }

                section.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        });
    }

    function setupControls() {
        // Wire section header toggles (replaces inline onclick handlers for CSP compliance)
        document.querySelectorAll('.nc-section-header[data-section]').forEach(header => {
            header.addEventListener('click', () => {
                toggleSection(header.getAttribute('data-section'));
            });
            // Prevent button clicks inside headers from toggling the section
            header.querySelectorAll('.nc-btn').forEach(btn => {
                btn.addEventListener('click', e => e.stopPropagation());
            });
        });

        const btnRefresh = document.getElementById('btnRefreshCluster');
        if (btnRefresh) {
            btnRefresh.addEventListener('click', async () => {
                Toast.info('Refreshing cluster data...');
                await Promise.all([loadSummary(), loadSection('cluster')]);
            });
        }

        const btnRefreshEcosystem = document.getElementById('btnRefreshEcosystem');
        if (btnRefreshEcosystem) {
            btnRefreshEcosystem.addEventListener('click', async () => {
                Toast.info('Refreshing ecosystem map...');
                await loadSection('ecosystem');
            });
        }

    }

    async function loadSummary() {
        const [intelligenceResult, inferenceResult] = await Promise.allSettled([
            fetchJson('/api/nerve-center/intelligence'),
            fetchJson('/api/nerve-center/inference-stats')
        ]);

        if (intelligenceResult.status === 'fulfilled' && intelligenceResult.value.status === 'success' && intelligenceResult.value.data) {
            const { cluster, routing, hostPreferences, alerts } = intelligenceResult.value.data;

            updateWidget('widgetHostsOnline', () => {
                const hosts = Array.isArray(cluster) ? cluster : [];
                const online = hosts.filter(host => host.status === 'online').length;
                const total = hosts.length;
                let state = 'nominal';
                if (online === 0) state = 'critical';
                else if (online < total) state = 'attention';
                return { value: `${online}/${total}`, state };
            });

            updateWidget('widgetActiveHost', () => {
                if (!routing) return { value: '--', state: 'nominal' };
                const hostKey = deriveHostKey(routing.currentHost, routing);
                const state = routing.isFailedOver ? 'attention' : 'nominal';
                return { value: hostKey.toUpperCase(), state };
            });

            updateWidget('widgetHostPrefs', () => {
                const prefs = Array.isArray(hostPreferences) ? hostPreferences : [];
                if (prefs.length === 0) return { value: '--', state: 'nominal' };
                const allReady = prefs.every(p => Array.isArray(p.pinnedModels) && p.pinnedModels.length > 0);
                return {
                    value: allReady ? 'Configured' : 'Partial',
                    state: allReady ? 'nominal' : 'attention'
                };
            });

            updateWidget('widgetAlerts', () => {
                const count = Array.isArray(alerts) ? alerts.length : 0;
                let state = 'nominal';
                if (count >= 3) state = 'critical';
                else if (count > 0) state = 'attention';
                return { value: String(count), state };
            });

            updateWidget('widgetRoutingMode', () => {
                if (!routing) return { value: '--', state: 'nominal' };
                return {
                    value: routing.isFailedOver ? 'FAILOVER' : 'AUTO',
                    state: routing.isFailedOver ? 'attention' : 'nominal'
                };
            });
        } else if (intelligenceResult.status === 'rejected') {
            console.error('[NerveCenter] Failed to load summary intelligence', intelligenceResult.reason);
        }

        if (inferenceResult.status === 'fulfilled' && inferenceResult.value.status === 'success') {
            updateWidget('widgetInferences', () => formatInferenceWidget(inferenceResult.value.data));
        } else {
            updateWidget('widgetInferences', () => ({ value: '—', state: 'nominal' }));
            if (inferenceResult.status === 'rejected') {
                console.error('[NerveCenter] Failed to load inference stats', inferenceResult.reason);
            }
        }
    }

    function formatInferenceWidget(stats) {
        if (!stats || typeof stats.count !== 'number') {
            return { value: '—', state: 'nominal' };
        }

        const count = Number(stats.count) || 0;
        const totalCost = Number(stats.totalCost);
        let value = count.toLocaleString('en-US');
        if (Number.isFinite(totalCost) && totalCost > 0) {
            value += ` · ${formatCurrency(totalCost)}`;
        }

        return { value, state: 'nominal' };
    }

    function updateWidget(widgetId, computeFn) {
        const widget = document.getElementById(widgetId);
        if (!widget) return;

        const { value, state } = computeFn();
        const valueEl = widget.querySelector('.nc-widget-value');
        if (!valueEl) return;

        const oldValue = valueEl.textContent;
        valueEl.textContent = value;

        widget.classList.remove('nominal', 'attention', 'critical');
        widget.classList.add(state);

        if (oldValue !== value && oldValue !== '--' && oldValue !== '—') {
            widget.classList.remove('pulse');
            void widget.offsetWidth;
            widget.classList.add('pulse');
        }
    }

    function deriveHostKey(hostUrl, routing) {
        if (!hostUrl) return '--';
        if (routing.primaryHost && normalizeHostUrl(hostUrl) === normalizeHostUrl(routing.primaryHost)) return 'primary';
        if (routing.secondaryHost && normalizeHostUrl(hostUrl) === normalizeHostUrl(routing.secondaryHost)) return 'secondary';
        if (routing.tertiaryHost && normalizeHostUrl(hostUrl) === normalizeHostUrl(routing.tertiaryHost)) return 'tertiary';
        try {
            const url = new URL(hostUrl);
            return url.hostname.split('.').pop() || hostUrl;
        } catch (_) {
            return hostUrl;
        }
    }

    window.NerveCenterShared = {
        fetchJson,
        normalizeHostUrl,
        escapeHtml,
        timeAgo,
        shortModel,
        hostStateBadge,
        hostKeyFromUrl,
        formatUptime,
        formatCurrency,
        sortHostKeys,
        attachCollapsibleHandlers
    };

    return {
        init,
        toggleSection,
        loadSummary,
        loadEcosystem: () => loadSection('ecosystem'),
        loadRouting: () => loadSection('routing'),
        loadFastlane: () => loadSection('fastlane'),
        loadCluster: () => loadSection('cluster'),
        loadHealth: () => loadSection('health'),
        loadPerformance: () => loadSection('performance')
    };
})();

window.NerveCenter = NerveCenter;
document.addEventListener('DOMContentLoaded', () => NerveCenter.init());
