const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
        getElementById: (id) => elementsById[id] || null,
        addEventListener: (type, handler) => listeners.set(type, handler),
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
        window: {},
        setInterval,
        clearInterval,
        setTimeout,
        clearTimeout,
        EventSource: undefined,
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
    it('stays live after a failed stop and permits retry before entering idle on acknowledgement', async () => {
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
        expect(engineRoom.__getState().batchId).toBeNull();
        expect(engineRoom.__getState().livePoller).toBeNull();
        expect(doc.body.classList.contains('state-live')).toBe(false);
        expect(idleSections.style.display).toBe('');
        expect(liveSections.style.display).toBe('none');
        expect(btnStop.dataset.stopState).toBe('ready');
        expect(btnStop.textContent).toBe('Stop');
        expect(stopStatus.hidden).toBe(true);
        expect(context.showToast).toHaveBeenCalledWith('Batch stopped', 'success', 8000);
    });
});
