/**
 * Nerve Center — Shared controller and summary strip.
 */

const NerveCenter = (() => {
    'use strict';

    const POLL_INTERVAL = 30_000;
    const ECOSYSTEM_SNAPSHOT_URL = '/api/nerve-center/ecosystem';
    const ECOSYSTEM_SNAPSHOT_TTL_MS = 2_000;
    const STORAGE_KEY = 'nc_section_states';
    const HOT_STATES = new Set(['READY']);
    const HOST_ORDER = ['primary', 'secondary', 'tertiary'];
    const CONTEXT_SECTIONS = {
        cluster: 'sectionCluster',
        routing: 'sectionRouting',
        health: 'sectionHealth',
        performance: 'sectionPerformance',
        inference: 'sectionInference',
        'inference-health': 'sectionInferenceHealth',
        alerts: 'sectionAlerts',
        rag: 'sectionRag'
    };

    let _poller = null;
    let _ecosystemSnapshot = null;
    let _ecosystemSnapshotExpiresAt = 0;
    let _ecosystemSnapshotInFlight = null;
    let _ecosystemSnapshotGeneration = 0;

    function fetchJson(url, options) {
        return fetch(url, options).then(async response => {
            const json = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(json.message || `Request failed (${response.status})`);
            }
            return json;
        });
    }

    function invalidateEcosystemSnapshot() {
        _ecosystemSnapshotGeneration += 1;
        _ecosystemSnapshot = null;
        _ecosystemSnapshotExpiresAt = 0;
        _ecosystemSnapshotInFlight = null;
    }

    function getEcosystemSnapshot(options = {}) {
        const force = options.force === true;
        const now = Date.now();
        if (!force && _ecosystemSnapshot && now < _ecosystemSnapshotExpiresAt) {
            return Promise.resolve(_ecosystemSnapshot);
        }
        if (!force && _ecosystemSnapshotInFlight) return _ecosystemSnapshotInFlight;

        if (force) invalidateEcosystemSnapshot();
        const generation = _ecosystemSnapshotGeneration;
        const request = fetchJson(ECOSYSTEM_SNAPSHOT_URL).then(envelope => {
            if (envelope?.status !== 'success' || !envelope.data || typeof envelope.data !== 'object') {
                throw new Error('Ecosystem snapshot returned no data');
            }
            if (Number(envelope.data.schemaVersion) !== 2) {
                throw new Error(`Unsupported ecosystem snapshot schema: ${envelope.data.schemaVersion ?? 'missing'}`);
            }
            if (generation === _ecosystemSnapshotGeneration) {
                _ecosystemSnapshot = envelope.data;
                _ecosystemSnapshotExpiresAt = Date.now() + ECOSYSTEM_SNAPSHOT_TTL_MS;
            }
            return envelope.data;
        });
        const inFlight = request.finally(() => {
            if (_ecosystemSnapshotInFlight === inFlight) _ecosystemSnapshotInFlight = null;
        });
        _ecosystemSnapshotInFlight = inFlight;
        return inFlight;
    }

    function normalizeHostUrl(hostUrl) {
        if (!hostUrl) return '';
        return String(hostUrl).replace(/\/+$/, '');
    }

    const escapeHtml = (value) => window.AgentXUtils.escapeHtml(value);

    function motionSafeScrollBehavior(preferred = 'smooth') {
        const reduceMotion = typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        return reduceMotion && preferred === 'smooth' ? 'auto' : preferred;
    }

    function setSectionBusy(body, busy) {
        if (!body) return;
        body.setAttribute('aria-busy', busy ? 'true' : 'false');
    }

    function renderSectionLoading(body, message) {
        if (!body) return;
        setSectionBusy(body, true);
        body.innerHTML = `<div class="nc-section-placeholder" role="status" aria-live="polite" aria-atomic="true"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ${escapeHtml(message)}</div>`;
    }

    function finishSectionLoad(body) {
        setSectionBusy(body, false);
    }

    function renderSectionError(body, message) {
        if (!body) return;
        body.innerHTML = `<div class="nc-section-placeholder nc-section-error" role="alert"><i class="fas fa-exclamation-triangle" aria-hidden="true"></i> ${escapeHtml(message)}</div>`;
        finishSectionLoad(body);
    }

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
            routing: () => window.NerveCenterRouting?.loadRouting?.(),
            cluster: () => window.NerveCenterCluster?.loadCluster?.(),
            health: () => window.NerveCenterHealth?.loadHealth?.(),
            performance: () => window.NerveCenterPerformance?.loadPerformance?.(),
            inference: () => window.NerveCenterInference?.loadInference?.(),
            'inference-health': () => window.NerveCenterInferenceHealth?.loadInferenceHealth?.(),
            alerts: () => window.NerveCenterAlerts?.loadAlerts?.(),
            rag: () => window.NerveCenterRag?.loadRag?.()
        };
        return loaders[name];
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
        setupHandoffContext();
        syncSectionDisclosures();
        setupWidgetClicks();
        setupControls();

        loadSummary();
        loadSection('cluster');
        loadSection('routing');
        loadSection('health');
        loadSection('performance');
        loadSection('inference');
        loadSection('inference-health');
        loadSection('alerts');
        loadSection('rag');

        _poller = new window.PollingController();
        _poller.addTask('summary', loadSummary, POLL_INTERVAL);
        _poller.start();
    }

    function boundedContextParam(params, key, pattern, maxLength) {
        const value = String(params.get(key) || '').trim();
        if (!value || value.length > maxLength || (pattern && !pattern.test(value))) return '';
        return value;
    }

    function setupHandoffContext() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('from') !== 'agent-ops') return;

        const focus = boundedContextParam(params, 'focus', /^(cluster|routing|health|performance|inference|inference-health|alerts|rag)$/, 24) || 'health';
        const source = boundedContextParam(params, 'source', /^[a-z0-9][a-z0-9 ._:/-]*$/i, 80);
        const agent = boundedContextParam(params, 'agent', /^[a-z0-9][a-z0-9 ._@-]*$/i, 80);
        const automation = boundedContextParam(params, 'automation', /^[a-z0-9][a-z0-9._:-]*$/i, 120);
        if (!source && !agent && !automation) return;

        const banner = document.getElementById('ncHandoffContext');
        const section = document.getElementById(CONTEXT_SECTIONS[focus]);
        const labels = [source && `source ${source}`, agent && `agent ${agent}`, automation && `automation ${automation}`].filter(Boolean);
        if (banner) {
            banner.hidden = false;
            document.getElementById('ncContextTitle').textContent = `Focused from Agent Ops · ${labels.join(' · ')}`;
            document.getElementById('ncContextDetail').textContent = `Showing the ${focus.replace(/-/g, ' ')} evidence surface; live Nerve Center data remains authoritative.`;
        }
        if (!section) return;
        setSectionCollapsed(section, false);
        section.classList.add('nc-context-focus');
        const actions = section.querySelector('.nc-section-actions');
        if (actions) {
            const chip = document.createElement('span');
            chip.className = 'nc-context-chip';
            chip.innerHTML = '<i class="fas fa-crosshairs"></i>';
            chip.append(document.createTextNode(` Agent Ops · ${[source, agent].filter(Boolean).join(' · ') || focus}`));
            actions.prepend(chip);
        }
        const container = section.closest('.nc-container') || document.body;
        const cancelEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
        let active = true;
        let alignTimer = 0;
        let stopTimer = 0;
        let hasResizeBaseline = false;
        const alignSection = (behavior) => {
            if (active) section.scrollIntoView({ behavior: motionSafeScrollBehavior(behavior), block: 'start' });
        };
        const observer = typeof window.ResizeObserver === 'function'
            ? new window.ResizeObserver(() => {
                if (!hasResizeBaseline) {
                    hasResizeBaseline = true;
                    return;
                }
                window.clearTimeout(alignTimer);
                alignTimer = window.setTimeout(() => alignSection('auto'), 80);
            })
            : null;
        const stopAlignment = () => {
            if (!active) return;
            active = false;
            observer?.disconnect();
            window.clearTimeout(alignTimer);
            window.clearTimeout(stopTimer);
            cancelEvents.forEach(eventName => window.removeEventListener(eventName, stopAlignment, true));
        };

        observer?.observe(container);
        cancelEvents.forEach(eventName => window.addEventListener(eventName, stopAlignment, {
            capture: true,
            once: true,
            passive: true
        }));
        window.setTimeout(() => alignSection('smooth'), 120);
        // Dynamic collectors can resize the sections above the target for a few
        // seconds. Follow those reflows only while the operator stays idle.
        stopTimer = window.setTimeout(() => {
            alignSection('auto');
            stopAlignment();
        }, 8000);
    }

    function toggleSection(sectionId) {
        const section = document.getElementById(sectionId);
        if (!section) return;
        setSectionCollapsed(section, !section.classList.contains('collapsed'));
        saveSectionStates();
    }

    function setSectionCollapsed(section, collapsed) {
        section.classList.toggle('collapsed', collapsed);
        syncSectionDisclosure(section);
    }

    function syncSectionDisclosure(section) {
        if (!section) return;
        const body = section.querySelector('.nc-section-body');
        if (!body) return;
        const collapsed = section.classList.contains('collapsed');

        if (collapsed) {
            body.setAttribute('aria-hidden', 'true');
            body.setAttribute('inert', '');
        } else {
            body.removeAttribute('aria-hidden');
            body.removeAttribute('inert');
        }

        document.querySelectorAll('[aria-controls]').forEach(control => {
            if (control.getAttribute('aria-controls') === body.id) {
                control.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            }
        });
    }

    function syncSectionDisclosures() {
        document.querySelectorAll('.nc-section').forEach(syncSectionDisclosure);
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
    const DEFAULT_COLLAPSED = ['sectionHealth', 'sectionInference', 'sectionAlerts', 'sectionPerformance', 'sectionRag'];

    function restoreSectionStates() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                // First visit — apply defaults
                DEFAULT_COLLAPSED.forEach(id => {
                    const section = document.getElementById(id);
                    if (section) setSectionCollapsed(section, true);
                });
                return;
            }
            const states = JSON.parse(raw);
            Object.entries(states).forEach(([id, collapsed]) => {
                const section = document.getElementById(id);
                if (section) setSectionCollapsed(section, Boolean(collapsed));
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
        setSectionCollapsed(section, false);
        saveSectionStates();
    }

    function setupWidgetClicks() {
        const sectionMap = {
            cluster: 'sectionCluster',
            routing: 'sectionRouting',
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
                    setSectionCollapsed(section, false);
                    saveSectionStates();
                }

                section.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: 'start' });
            });
        });
    }

    function setupControls() {
        document.querySelectorAll('.nc-section-toggle[data-section]').forEach(control => {
            control.addEventListener('click', () => {
                toggleSection(control.getAttribute('data-section'));
            });
        });

        const btnRefresh = document.getElementById('btnRefreshCluster');
        if (btnRefresh) {
            btnRefresh.addEventListener('click', async () => {
                Toast.info('Refreshing cluster data...');
                await Promise.all([loadSummary({ forceSnapshot: true }), loadSection('cluster')]);
            });
        }

    }

    function serviceBuildWidget(snapshot) {
        const serviceHealth = snapshot?.serviceHealth;
        const consistency = snapshot?.identityConsistency;
        if (!serviceHealth || typeof serviceHealth !== 'object' || !consistency || typeof consistency !== 'object') {
            return { value: 'ERROR', state: 'critical', title: 'Service and build identity evidence is unavailable.' };
        }

        const serviceStatus = String(serviceHealth.status || '').toLowerCase();
        const consistencyStatus = String(consistency.status || '').toLowerCase();
        const profiles = Array.isArray(consistency.profiles) ? consistency.profiles.filter(Boolean).map(String) : [];
        const issues = Array.isArray(consistency.issues) ? consistency.issues.filter(Boolean).map(String) : [];
        const down = Number(serviceHealth.down);
        const healthy = Number(serviceHealth.healthy);
        const total = Number(serviceHealth.total);
        const parts = [];

        if (serviceStatus && serviceStatus !== 'ok') parts.push(serviceStatus.toUpperCase());
        if (consistencyStatus === 'degraded' || profiles.length > 1) parts.push('MIXED');
        else if (consistencyStatus === 'unverified') parts.push('UNVERIFIED');
        else if (profiles.length === 1) parts.push(profiles[0].toUpperCase());

        const titleParts = [];
        if (Number.isFinite(healthy) && Number.isFinite(total)) titleParts.push(`${healthy}/${total} services healthy`);
        if (profiles.length > 0) titleParts.push(`Build profiles: ${profiles.join(', ')}`);
        titleParts.push(...issues);

        return {
            value: parts.join('/') || '—',
            state: Number.isFinite(down) && down > 0
                ? 'critical'
                : (serviceStatus !== 'ok' || consistencyStatus !== 'ok' ? 'attention' : 'nominal'),
            title: titleParts.join(' · ') || 'Service/build consistency evidence is incomplete.'
        };
    }

    function evidenceTrustWidget(evidenceTrust) {
        if (!evidenceTrust || typeof evidenceTrust !== 'object') {
            return { value: 'ERROR', state: 'critical', title: 'Evidence trust assessment is unavailable.' };
        }

        const status = String(evidenceTrust.status || '').toLowerCase();
        const labels = {
            verified: 'VERIFIED',
            partial: 'PARTIAL',
            stale: 'STALE',
            inconsistent: 'MIXED',
            contradictory: 'CONFLICT'
        };
        const contradictions = Number(evidenceTrust.contradictionBudget?.observed);
        const observedSources = Number(evidenceTrust.coverage?.observedSources);
        const expectedSources = Number(evidenceTrust.coverage?.expectedSources);
        const staleSources = Number(evidenceTrust.freshness?.stale);
        const missing = Array.isArray(evidenceTrust.coverage?.missing)
            ? evidenceTrust.coverage.missing.filter(Boolean).map(String)
            : [];
        const title = [
            Number.isFinite(contradictions) ? `${contradictions} contradictions (budget 0)` : 'Contradiction count unavailable',
            Number.isFinite(observedSources) && Number.isFinite(expectedSources)
                ? `${observedSources}/${expectedSources} evidence sources observed`
                : 'Evidence coverage unavailable',
            Number.isFinite(staleSources) ? `${staleSources} stale sources` : 'Freshness unavailable',
            missing.length > 0 ? `Missing: ${missing.join(', ')}` : '',
            `Operational state: ${evidenceTrust.operationalStatus || 'unknown'}`
        ].filter(Boolean).join(' · ');

        return {
            value: labels[status] || 'UNKNOWN',
            state: status === 'contradictory' ? 'critical' : (status === 'verified' ? 'nominal' : 'attention'),
            title
        };
    }

    function markEcosystemSummaryUnavailable(error) {
        const message = `Ecosystem snapshot unavailable: ${error?.message || 'unknown error'}`;
        [
            'widgetHostsOnline',
            'widgetActiveHost',
            'widgetHostPrefs',
            'widgetAlerts',
            'widgetRoutingMode',
            'widgetServiceBuild',
            'widgetEvidenceTrust'
        ].forEach(widgetId => {
            updateWidget(widgetId, () => ({ value: 'ERROR', state: 'critical', title: message }));
        });
    }

    async function loadSummary(options = {}) {
        const [ecosystemResult, inferenceResult, rulesResult] = await Promise.allSettled([
            getEcosystemSnapshot({ force: options.forceSnapshot === true }),
            fetchJson('/api/nerve-center/inference-stats'),
            fetchJson('/api/alerts/rules')
        ]);
        const detectorCoverage = rulesResult.status === 'fulfilled'
            ? rulesResult.value?.data?.detectorCoverage
            : null;

        if (ecosystemResult.status === 'fulfilled') {
            const snapshot = ecosystemResult.value;
            const { health, routing, hostPreferences, alertSummary, serviceHealth, identityConsistency, evidenceTrust } = snapshot;
            const snapshotAge = snapshot.generatedAt ? timeAgo(snapshot.generatedAt) : 'unknown';

            updateWidget('widgetHostsOnline', () => {
                const online = Number(health?.onlineHosts);
                const total = Number(health?.configuredHosts);
                if (!Number.isFinite(online) || !Number.isFinite(total)) {
                    return { value: 'ERROR', state: 'critical', title: 'Host-count evidence is unavailable in the ecosystem snapshot.' };
                }
                let state = 'nominal';
                if (online === 0) state = 'critical';
                else if (online < total) state = 'attention';
                return { value: `${online}/${total}`, state, title: `Ecosystem snapshot observed ${snapshotAge}.` };
            });

            updateWidget('widgetActiveHost', () => {
                if (!routing) return { value: 'ERROR', state: 'critical', title: 'Routing evidence is unavailable in the ecosystem snapshot.' };
                const actualHost = routing.observedRequest?.actualHost || routing.currentHost;
                const intentHost = routing.requestedIntent?.currentHost || routing.primaryHost;
                const actualKey = deriveHostKey(actualHost, routing).toUpperCase();
                const intentKey = deriveHostKey(intentHost, routing).toUpperCase();
                const diverged = normalizeHostUrl(actualHost) !== normalizeHostUrl(intentHost);
                const state = routing.isFailedOver || diverged ? 'attention' : 'nominal';
                return {
                    value: `${intentKey}→${actualKey}`,
                    state,
                    title: `Configured routing intent paired with the most recent successful chat or proxy route; embeddings are excluded. Snapshot observed ${snapshotAge}.`
                };
            });

            updateWidget('widgetHostPrefs', () => {
                const prefs = Array.isArray(hostPreferences) ? hostPreferences : [];
                if (prefs.length === 0) return { value: '—', state: 'attention', title: 'No host-default evidence is present in the ecosystem snapshot.' };
                const allReady = prefs.every(p => Array.isArray(p.pinnedModels) && p.pinnedModels.length > 0);
                return {
                    value: allReady ? 'Configured' : 'Partial',
                    state: allReady ? 'nominal' : 'attention',
                    title: `${prefs.length} host-default record${prefs.length === 1 ? '' : 's'} observed ${snapshotAge}.`
                };
            });

            updateWidget('widgetAlerts', () => {
                const reportedCount = Number(alertSummary?.activeCount);
                if (!Number.isFinite(reportedCount) || reportedCount < 0) {
                    return { value: 'ERROR', state: 'critical', title: 'Active-alert count evidence is unavailable in the ecosystem snapshot.' };
                }
                const count = reportedCount;
                const disabledValue = Number(detectorCoverage?.disabled);
                const disabled = Number.isFinite(disabledValue) ? disabledValue : null;
                let state = 'nominal';
                if (count >= 3) state = 'critical';
                else if (count > 0 || (disabled !== null && disabled > 0) || !detectorCoverage) state = 'attention';
                const detectorDetail = detectorCoverage
                    ? `${detectorCoverage.active || 0} active detectors · ${disabled || 0} disabled · ${detectorCoverage.retired_by_design || 0} retired by design`
                    : 'Detector coverage unavailable';
                const observedAt = alertSummary?.observedAt ? ` · alerts observed ${timeAgo(alertSummary.observedAt)}` : '';
                return {
                    value: disabled !== null && disabled > 0 ? `${count} · ${disabled} OFF` : String(count),
                    state,
                    title: `${detectorDetail}${observedAt}`
                };
            });

            updateWidget('widgetRoutingMode', () => {
                if (!routing) return { value: 'ERROR', state: 'critical', title: 'Routing evidence is unavailable in the ecosystem snapshot.' };
                return {
                    value: routing.isFailedOver ? 'FAILOVER' : 'AUTO',
                    state: routing.isFailedOver ? 'attention' : 'nominal',
                    title: `Routing authority: ${routing.authority || 'unavailable'} · snapshot observed ${snapshotAge}.`
                };
            });

            updateWidget('widgetServiceBuild', () => serviceBuildWidget({ serviceHealth, identityConsistency }));
            updateWidget('widgetEvidenceTrust', () => evidenceTrustWidget(evidenceTrust));
        } else {
            console.error('[NerveCenter] Failed to load ecosystem snapshot', ecosystemResult.reason);
            markEcosystemSummaryUnavailable(ecosystemResult.reason);
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

        const { value, state, title } = computeFn();
        const valueEl = widget.querySelector('.nc-widget-value');
        if (!valueEl) return;

        const oldValue = valueEl.textContent;
        valueEl.textContent = value;

        widget.classList.remove('nominal', 'attention', 'critical');
        widget.classList.add(state);
        if (typeof title === 'string') widget.title = title;

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
        attachCollapsibleHandlers,
        motionSafeScrollBehavior,
        setSectionBusy,
        renderSectionLoading,
        finishSectionLoad,
        renderSectionError,
        getEcosystemSnapshot,
        invalidateEcosystemSnapshot,
        serviceBuildWidget,
        evidenceTrustWidget
    };

    return {
        init,
        toggleSection,
        loadSummary,
        loadRouting: () => loadSection('routing'),
        loadCluster: () => loadSection('cluster'),
        loadHealth: () => loadSection('health'),
        loadPerformance: () => loadSection('performance')
    };
})();

window.NerveCenter = NerveCenter;
document.addEventListener('DOMContentLoaded', () => NerveCenter.init());
