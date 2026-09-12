const fs = require('fs');
const path = require('path');
const vm = require('vm');
const workloadHelpers = {};
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../../public/js/benchmark-v2/helpers.js'), 'utf8').replace(/export /g, ''), workloadHelpers);

class FakeClassList {
    constructor() {
        this._classes = new Set();
    }

    add(...names) {
        names.forEach((name) => this._classes.add(name));
    }

    remove(...names) {
        names.forEach((name) => this._classes.delete(name));
    }

    contains(name) {
        return this._classes.has(name);
    }
}

class FakeElement {
    constructor(tagName, opts = {}) {
        this.tagName = tagName.toUpperCase();
        this.id = opts.id || '';
        this.className = opts.className || '';
        this.dataset = { ...(opts.dataset || {}) };
        this.style = {};
        this.children = [];
        this.parentNode = null;
        this.textContent = opts.textContent || '';
        this.listeners = new Map();
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    insertBefore(child, referenceNode) {
        child.parentNode = this;
        if (!referenceNode) {
            this.children.push(child);
            return child;
        }

        const index = this.children.indexOf(referenceNode);
        if (index === -1) {
            this.children.push(child);
            return child;
        }

        this.children.splice(index, 0, child);
        return child;
    }

    addEventListener(type, handler) {
        this.listeners.set(type, handler);
    }

    remove() {
        if (!this.parentNode) return;
        const index = this.parentNode.children.indexOf(this);
        if (index >= 0) {
            this.parentNode.children.splice(index, 1);
        }
        this.parentNode = null;
    }

    querySelector(selector) {
        for (const child of this.children) {
            if (matchesSelector(child, selector)) return child;
            const nested = child.querySelector(selector);
            if (nested) return nested;
        }
        return null;
    }

    querySelectorAll(selector) {
        const out = [];
        for (const child of this.children) {
            if (matchesSelector(child, selector)) out.push(child);
            const nested = child.querySelectorAll(selector);
            if (nested.length) out.push(...nested);
        }
        return out;
    }
}

function matchesSelector(element, selector) {
    if (selector.startsWith('#')) {
        return element.id === selector.slice(1);
    }
    if (selector.startsWith('.')) {
        return element.className.split(/\s+/).filter(Boolean).includes(selector.slice(1));
    }
    if (selector === '[data-idle-poll-status]') {
        return Object.prototype.hasOwnProperty.call(element.dataset, 'idlePollStatus');
    }
    return false;
}

function flushPromises() {
    return new Promise((resolve) => setImmediate(resolve));
}

function buildActionZone() {
    const actionZone = new FakeElement('header', { id: 'action-zone' });
    const idleRow = new FakeElement('div', { id: 'az-idle' });
    const liveRow = new FakeElement('div', { id: 'az-live' });
    const pipeline = new FakeElement('div', { id: 'pipeline-bar-wrap' });
    const hostPills = new FakeElement('div', { id: 'host-pills' });
    const actions = new FakeElement('div', { className: 'az-actions' });

    idleRow.appendChild(hostPills);
    idleRow.appendChild(actions);
    actionZone.appendChild(idleRow);
    actionZone.appendChild(liveRow);
    actionZone.appendChild(pipeline);

    return { actionZone, idleRow, liveRow, hostPills, actions };
}

function buildDocument(elementsById = {}) {
    const listeners = new Map();
    return {
        visibilityState: 'visible',
        hidden: false,
        body: { classList: new FakeClassList() },
        createElement: (tagName) => new FakeElement(tagName),
        createDocumentFragment: () => new FakeElement('fragment'),
        createTextNode: text => new FakeElement('text', { textContent: text }),
        getElementById: (id) => elementsById[id] || null,
        addEventListener: (type, handler) => listeners.set(type, handler),
        dispatchEvent: jest.fn(),
        removeEventListener: (type) => listeners.delete(type),
        __listeners: listeners,
    };
}

function loadEngineRoomModule(overrides = {}) {
    const sourcePath = path.join(__dirname, '../../../public/js/benchmark-v2/index.js');
    let source = fs.readFileSync(sourcePath, 'utf8');
    source = source.replace(/^import[\s\S]*?;\r?\n/gm, '');
    source += `
module.exports = {
    _enterIdle,
    _enterLive,
    _handleStop,
    _handleLaunch,
    _pollBatch,
    _handleNewComparison,
    _checkForActiveBatchDuringIdle,
    __setElements(elements) {
        $actionZone = elements.actionZone ?? $actionZone;
        $idleSections = elements.idleSections ?? $idleSections;
        $liveSections = elements.liveSections ?? $liveSections;
        $batchCard = elements.batchCard ?? $batchCard;
        $liveDetail = elements.liveDetail ?? $liveDetail;
        $modelArena = elements.modelArena ?? $modelArena;
        $anomalies = elements.anomalies ?? $anomalies;
        $eventLog = elements.eventLog ?? $eventLog;
        $infrastructure = elements.infrastructure ?? $infrastructure;
        $batchConfig = elements.batchConfig ?? $batchConfig;
        $launchSummary = elements.launchSummary ?? $launchSummary;
        $btnStop = elements.btnStop ?? $btnStop;
        $stopStatus = elements.stopStatus ?? $stopStatus;
    },
    __getState() {
        return {
            batchId: _batchId,
            idlePoller: _idlePoller,
            livePoller: _poller,
            idlePollSession: _idlePollSession,
            stopRequestInFlight: _stopRequestInFlight,
        };
    },
};
`;

    const pollerInstances = [];
    class FakePollingController {
        constructor() {
            this.tasks = new Map();
            this.started = false;
            this.destroyed = false;
            pollerInstances.push(this);
        }

        addTask(name, fn, intervalMs, opts = {}) {
            this.tasks.set(name, {
                fn,
                intervalMs,
                runOnStart: opts.runOnStart !== false,
            });
        }

        start() {
            this.started = true;
            for (const task of this.tasks.values()) {
                if (task.runOnStart) {
                    Promise.resolve().then(() => task.fn());
                }
            }
        }

        stop() {
            this.started = false;
        }

        destroy() {
            this.destroyed = true;
            this.tasks.clear();
        }

        async run(name) {
            const task = this.tasks.get(name);
            if (task) {
                await task.fn();
            }
        }
    }

    const doc = overrides.document || buildDocument();
    const context = {
        module: { exports: {} },
        exports: {},
        console,
        document: doc,
        window: { setTimeout, clearTimeout },
        setInterval,
        clearInterval,
        setTimeout,
        clearTimeout,
        EventSource: undefined,
        CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts.detail; } },
        PollingController: FakePollingController,
        fetchActiveBatch: jest.fn().mockResolvedValue(null),
        fetchBatchProgress: jest.fn(),
        fetchTimeline: jest.fn(),
        fetchHosts: jest.fn().mockResolvedValue([]),
        fetchProfilerHosts: jest.fn().mockResolvedValue([]),
        fetchProfilerModels: jest.fn().mockResolvedValue([]),
        fetchProfilerDashboard: jest.fn().mockResolvedValue({ data: {} }),
        fetchPrompts: jest.fn().mockResolvedValue({ data: [] }),
        fetchConfig: jest.fn().mockResolvedValue({ data: {} }),
        fetchBatches: jest.fn().mockResolvedValue({ data: { batches: [] } }),
        fetchJudgeRoster: jest.fn().mockResolvedValue(null),
        startBatch: jest.fn(),
        stopBatch: jest.fn(),
        fetchResumableBatch: jest.fn().mockResolvedValue(null),
        resumeBatch: jest.fn(),
        renderActionZoneIdle: jest.fn(),
        renderActionZoneLive: jest.fn(),
        updatePipelineBar: jest.fn(),
        startElapsedTimer: jest.fn(),
        stopElapsedTimer: jest.fn(),
        renderHostSelection: jest.fn().mockResolvedValue(null),
        getSelectedHost: jest.fn(() => null),
        getSelectedJudge: jest.fn(() => ({})),
        renderBatchConfig: jest.fn(),
        renderLaunchSummary: jest.fn(),
        updateLaunchSummary: jest.fn(),
        renderResumeBanner: jest.fn(),
        renderBatchCard: jest.fn(),
        updateBatchCard: jest.fn(),
        renderLiveDetail: jest.fn(),
        updateLiveDetail: jest.fn(),
        renderModelArena: jest.fn(),
        updateModelArena: jest.fn(),
        renderAnomalies: jest.fn(),
        updateAnomalies: jest.fn(),
        renderEventLog: jest.fn(),
        appendEvents: jest.fn(),
        showFatalError: jest.fn(() => new FakeElement('div')),
        showToast: jest.fn(),
        ensureBv2Schema: jest.fn(),
        readComparisonWorkload: workloadHelpers.readComparisonWorkload,
        getSelectedJudge: jest.fn(() => ({})),
        ...overrides.stubs,
    };
    context.global = context;
    context.globalThis = context;

    vm.runInNewContext(source, context, { filename: sourcePath });
    return {
        engineRoom: context.module.exports,
        context,
        document: doc,
        pollerInstances,
    };
}

describe('benchmark-v2 idle poller', () => {
    it('starts idle polling after idle UI render and adds the polling status affordance', async () => {
        const actionZoneBits = buildActionZone();
        const { engineRoom, context, pollerInstances } = loadEngineRoomModule({
            document: buildDocument(),
        });

        engineRoom.__setElements({
            actionZone: actionZoneBits.actionZone,
            idleSections: new FakeElement('div', { id: 'idle-sections' }),
            liveSections: new FakeElement('div', { id: 'live-sections' }),
            infrastructure: new FakeElement('div', { id: 'host-cards' }),
            batchConfig: new FakeElement('div', { id: 'batch-config' }),
            launchSummary: new FakeElement('div', { id: 'launch-summary' }),
        });

        await engineRoom._enterIdle();
        await flushPromises();

        expect(context.renderActionZoneIdle).toHaveBeenCalledWith(actionZoneBits.actionZone, []);
        expect(actionZoneBits.idleRow.querySelector('[data-idle-poll-status]')).not.toBeNull();
        expect(actionZoneBits.idleRow.querySelector('[data-idle-poll-status]').textContent).toBe('Checking for active batches…');
        expect(pollerInstances).toHaveLength(1);
        expect(pollerInstances[0].started).toBe(true);
        expect(context.fetchActiveBatch).toHaveBeenCalledTimes(1);
    });

    it('skips idle polling while hidden and transitions to LIVE when an active batch appears', async () => {
        const actionZoneBits = buildActionZone();
        const idleSections = new FakeElement('div', { id: 'idle-sections' });
        const liveSections = new FakeElement('div', { id: 'live-sections' });
        const doc = buildDocument();
        const { engineRoom, context, pollerInstances } = loadEngineRoomModule({ document: doc });

        engineRoom.__setElements({
            actionZone: actionZoneBits.actionZone,
            idleSections,
            liveSections,
            infrastructure: new FakeElement('div', { id: 'host-cards' }),
            batchConfig: new FakeElement('div', { id: 'batch-config' }),
            launchSummary: new FakeElement('div', { id: 'launch-summary' }),
            batchCard: new FakeElement('div', { id: 'batch-card' }),
            liveDetail: new FakeElement('div', { id: 'live-detail' }),
            modelArena: new FakeElement('div', { id: 'model-arena' }),
            anomalies: new FakeElement('div', { id: 'anomalies' }),
            eventLog: new FakeElement('div', { id: 'event-log' }),
            btnStop: new FakeElement('button', { id: 'btn-stop' }),
        });

        await engineRoom._enterIdle();
        await flushPromises();

        const idlePoller = pollerInstances[0];
        expect(idlePoller).toBeDefined();

        doc.visibilityState = 'hidden';
        doc.hidden = true;
        await idlePoller.run('active-batch');
        expect(context.fetchActiveBatch).toHaveBeenCalledTimes(1);

        doc.visibilityState = 'visible';
        doc.hidden = false;
        context.fetchActiveBatch.mockResolvedValueOnce({ data: [{ _id: 'batch-42', status: 'running' }] });
        await idlePoller.run('active-batch');
        await flushPromises();

        expect(engineRoom.__getState().batchId).toBe('batch-42');
        expect(engineRoom.__getState().idlePoller).toBeNull();
        expect(idlePoller.destroyed).toBe(true);
        expect(idleSections.style.display).toBe('none');
        expect(liveSections.style.display).toBe('');
        expect(context.renderActionZoneLive).toHaveBeenCalledWith(actionZoneBits.actionZone, expect.objectContaining({ _id: 'batch-42' }));
        expect(engineRoom.__getState().livePoller).not.toBeNull();
    });
});

describe('benchmark-v2 acknowledged stop flow', () => {
    it('stays live after a failed stop and preserves diagnostics after an acknowledged retry', async () => {
        const actionZoneBits = buildActionZone();
        const idleSections = new FakeElement('div', { id: 'idle-sections' });
        const liveSections = new FakeElement('div', { id: 'live-sections' });
        const btnStop = new FakeElement('button', { id: 'btn-stop', textContent: 'Stop' });
        const stopStatus = new FakeElement('span', { id: 'stop-status' });
        stopStatus.hidden = true;
        const stopFailure = Object.assign(new Error('request failed'), {
            payload: { error: 'Fixture stop acknowledgement unavailable' },
        });
        const doc = buildDocument();
        const { engineRoom, context } = loadEngineRoomModule({
            document: doc,
            stubs: {
                stopBatch: jest.fn()
                    .mockRejectedValueOnce(stopFailure)
                    .mockResolvedValueOnce({
                        status: 'success',
                        message: 'Batch stopped',
                        data: { status: 'stopped' },
                    }),
            },
        });

        engineRoom.__setElements({
            actionZone: actionZoneBits.actionZone,
            idleSections,
            liveSections,
            infrastructure: new FakeElement('div', { id: 'host-cards' }),
            batchConfig: new FakeElement('div', { id: 'batch-config' }),
            launchSummary: new FakeElement('div', { id: 'launch-summary' }),
            batchCard: new FakeElement('div', { id: 'batch-card' }),
            liveDetail: new FakeElement('div', { id: 'live-detail' }),
            modelArena: new FakeElement('div', { id: 'model-arena' }),
            anomalies: new FakeElement('div', { id: 'anomalies' }),
            eventLog: new FakeElement('div', { id: 'event-log' }),
            btnStop,
            stopStatus,
        });

        engineRoom._enterLive({
            _id: 'batch-stop-contract',
            status: 'running',
            total_tests: 2,
            completed: 1,
            current_test: { stage: 'executing' },
        });
        const livePoller = engineRoom.__getState().livePoller;

        await expect(engineRoom._handleStop()).resolves.toBe(false);

        expect(context.stopBatch).toHaveBeenCalledTimes(1);
        expect(engineRoom.__getState().batchId).toBe('batch-stop-contract');
        expect(engineRoom.__getState().livePoller).toBe(livePoller);
        expect(livePoller.destroyed).toBe(false);
        expect(doc.body.classList.contains('state-live')).toBe(true);
        expect(idleSections.style.display).toBe('none');
        expect(liveSections.style.display).toBe('');
        expect(btnStop.disabled).toBe(false);
        expect(btnStop.dataset.stopState).toBe('failed');
        expect(btnStop.textContent).toBe('Retry stop');
        expect(stopStatus.hidden).toBe(false);
        expect(stopStatus.textContent).toContain('The batch is still running');
        expect(context.showFatalError).toHaveBeenCalledWith(expect.stringContaining('Stop failed'));

        await expect(engineRoom._handleStop()).resolves.toBe(true);
        await flushPromises();

        expect(context.stopBatch).toHaveBeenCalledTimes(2);
        expect(livePoller.destroyed).toBe(true);
        expect(engineRoom.__getState().batchId).toBe('batch-stop-contract');
        expect(engineRoom.__getState().livePoller).toBeNull();
        expect(doc.body.classList.contains('state-live')).toBe(true);
        expect(doc.body.classList.contains('state-finished')).toBe(true);
        expect(idleSections.style.display).toBe('none');
        expect(liveSections.style.display).toBe('');
        expect(btnStop.hidden).toBe(true);
        expect(context.renderEventLog).toHaveBeenCalledTimes(1);
        expect(stopStatus.hidden).toBe(true);
        expect(context.showToast).toHaveBeenCalledWith('Batch stopped', 'success', 8000);

        await engineRoom._handleNewComparison();
        expect(engineRoom.__getState().batchId).toBeNull();
        expect(liveSections.style.display).toBe('none');
    });
});

function setupTracking(stubs = {}) {
    const outcome = new FakeElement('section', { id: 'batch-outcome' });
    outcome.hidden = true;
    const title = outcome.appendChild(new FakeElement('strong', { id: 'batch-outcome-title' }));
    const detail = outcome.appendChild(new FakeElement('span', { id: 'batch-outcome-detail' }));
    const newComparison = outcome.appendChild(new FakeElement('button', { id: 'btn-new-comparison' }));
    const doc = buildDocument({ 'batch-outcome': outcome, 'btn-new-comparison': newComparison });
    const loaded = loadEngineRoomModule({ document: doc, stubs });
    const elements = {
        idleSections: new FakeElement('div'), liveSections: new FakeElement('div'),
        batchCard: new FakeElement('div'), eventLog: new FakeElement('div'),
        btnStop: new FakeElement('button'),
    };
    loaded.engineRoom.__setElements(elements);
    loaded.engineRoom._enterLive({ _id: 'batch-a', status: 'running', total_tests: 214, completed: 0 });
    return { ...loaded, ...elements, outcome, title, detail, newComparison };
}

describe('benchmark-v2 persistent tracking', () => {
    afterEach(() => jest.useRealTimers());

    test('enters tracking from the launch response and keeps an immediate startup failure visible', async () => {
        const page = setupTracking();
        page.context.startBatch.mockResolvedValue({ data: { batch_id: 'launched-batch', status: 'pending' } });
        await page.engineRoom._handleLaunch({ models: ['fixture-model'] });
        expect(page.context.startBatch).toHaveBeenCalledWith({ models: ['fixture-model'] });
        expect(page.engineRoom.__getState().batchId).toBe('launched-batch');
        page.context.fetchBatchProgress.mockResolvedValue({ data: { _id: 'launched-batch', status: 'failed', failure_reason: 'Warmup failed' } });
        await page.engineRoom._pollBatch('launched-batch');
        expect(page.title.textContent).toBe('Comparison failed');
        expect(page.detail.textContent).toBe('Warmup failed');
        expect(page.liveSections.style.display).toBe('');
    });

    test('a delayed stop failure cannot claim a finished run is still running', async () => {
        let reject;
        const page = setupTracking({ stopBatch: jest.fn(() => new Promise((resolve, fail) => { reject = fail; })) });
        const pendingStop = page.engineRoom._handleStop();
        page.context.fetchBatchProgress.mockResolvedValue({ data: { _id: 'batch-a', status: 'completed' } });
        await page.engineRoom._pollBatch('batch-a');
        reject(new Error('Connection lost'));
        await pendingStop;
        expect(page.context.showFatalError).not.toHaveBeenCalled();
        expect(page.title.textContent).toBe('Comparison complete');
        expect(page.btnStop.hidden).toBe(true);
    });

    test.each(['completed', 'failed', 'stopped', 'interrupted'])(
        'keeps %s evidence visible beyond the former redirect delay until New comparison', async status => {
            jest.useFakeTimers();
            const page = setupTracking();
            const final = { _id: 'batch-a', status, completed: 2, total_tests: 214, failure_reason: status === 'failed' ? 'Judge unavailable <details>' : null };
            page.context.fetchBatchProgress.mockResolvedValue({ data: final });
            page.context.fetchTimeline.mockResolvedValue({ data: { timeline: [{ event: status }] } });
            await page.engineRoom._pollBatch('batch-a');
            await jest.advanceTimersByTimeAsync(10000);

            expect(page.liveSections.style.display).toBe('');
            expect(page.idleSections.style.display).toBe('none');
            expect(page.outcome.hidden).toBe(false);
            expect(page.outcome.dataset.status).toBe(status);
            expect(page.engineRoom.__getState().livePoller).toBeNull();
            expect(page.btnStop.hidden).toBe(true);
            expect(page.context.updateBatchCard).toHaveBeenLastCalledWith(page.batchCard, final);
            expect(page.context.appendEvents).toHaveBeenCalledTimes(1);
            if (status === 'failed') expect(page.detail.textContent).toBe('Judge unavailable <details>');

            await page.newComparison.listeners.get('click')();
            expect(page.liveSections.style.display).toBe('none');
            expect(page.idleSections.style.display).toBe('');
            page.engineRoom._enterLive({ _id: 'batch-b', status: 'running' });
            expect(page.outcome.hidden).toBe(true);
            expect(page.btnStop.hidden).toBe(false);
        }
    );

    test('keeps tracking during warmup, generation, judging and temporary request failures', async () => {
        const page = setupTracking();
        for (const stage of ['warmup', 'executing', 'judging']) {
            page.context.fetchBatchProgress.mockResolvedValue({ data: { _id: 'batch-a', status: stage === 'judging' ? 'judging' : 'running', current_test: { stage } } });
            await page.engineRoom._pollBatch('batch-a');
            expect(page.outcome.hidden).toBe(true);
            expect(page.liveSections.style.display).toBe('');
        }
        page.context.fetchBatchProgress.mockRejectedValueOnce(new Error('Connection lost'));
        await page.engineRoom._pollBatch('batch-a');
        expect(page.context.showFatalError).toHaveBeenCalledWith(expect.stringContaining('Connection lost'));
        expect(page.engineRoom.__getState().livePoller).not.toBeNull();
        await page.engineRoom._handleNewComparison();
        expect(page.engineRoom.__getState().batchId).toBe('batch-a');
        await page.engineRoom._pollBatch('batch-a');
        expect(page.liveSections.style.display).toBe('');
    });

    test.each(['batch-a', 'batch-b'])('discards late progress from an older session when tracking %s', async nextId => {
        let release;
        const page = setupTracking({ fetchBatchProgress: jest.fn(() => new Promise(resolve => { release = resolve; })) });
        const pending = page.engineRoom._pollBatch('batch-a');
        await page.engineRoom._pollBatch('batch-a');
        expect(page.context.fetchBatchProgress).toHaveBeenCalledTimes(1);
        page.engineRoom._enterLive({ _id: nextId, status: 'running' });
        release({ data: { _id: 'batch-a', status: 'failed' } });
        await pending;
        expect(page.context.updateBatchCard).not.toHaveBeenCalled();
        expect(page.context.fetchTimeline).not.toHaveBeenCalled();
        expect(page.engineRoom.__getState().batchId).toBe(nextId);
        expect(page.engineRoom.__getState().livePoller).not.toBeNull();
        expect(page.outcome.hidden).toBe(true);
    });

    test('discards a late timeline and terminal transition after a newer run starts', async () => {
        let release;
        const page = setupTracking({
            fetchBatchProgress: jest.fn().mockResolvedValue({ data: { _id: 'batch-a', status: 'failed' } }),
            fetchTimeline: jest.fn(() => new Promise(resolve => { release = resolve; })),
        });
        const pending = page.engineRoom._pollBatch('batch-a');
        await flushPromises();
        page.engineRoom._enterLive({ _id: 'batch-b', status: 'running' });
        release({ data: { timeline: [{ event: 'error' }] } });
        await pending;
        expect(page.context.appendEvents).not.toHaveBeenCalled();
        expect(page.engineRoom.__getState().livePoller).not.toBeNull();
        expect(page.outcome.hidden).toBe(true);
    });

    test('ignores errors from an old stream and polls to completion after done during an in-flight request', async () => {
        const sources = [];
        class FakeEventSource {
            constructor() { this.listeners = {}; this.close = jest.fn(); sources.push(this); }
            addEventListener(type, fn) { this.listeners[type] = fn; }
        }
        const page = setupTracking({ EventSource: FakeEventSource });
        page.engineRoom._enterLive({ _id: 'batch-b', status: 'running' });
        sources[0].listeners.error();
        expect(sources[1].close).not.toHaveBeenCalled();
        expect(page.engineRoom.__getState().livePoller).toBeNull();
        let release;
        page.context.fetchBatchProgress.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const pending = page.engineRoom._pollBatch('batch-b');
        sources[1].listeners.done();
        release({ data: { _id: 'batch-b', status: 'running' } });
        await pending;
        const fallback = page.engineRoom.__getState().livePoller;
        expect(fallback).not.toBeNull();
        page.context.fetchBatchProgress.mockResolvedValue({ data: { _id: 'batch-b', status: 'completed' } });
        await fallback.run('batch-progress');
        expect(page.outcome.dataset.status).toBe('completed');
        expect(fallback.destroyed).toBe(true);
    });
});
