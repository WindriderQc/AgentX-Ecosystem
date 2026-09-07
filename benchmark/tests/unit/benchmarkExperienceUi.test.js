const fs = require('fs');
const path = require('path');
const vm = require('vm');

const historyUrl = '/api/benchmark/batches?status=completed&limit=1';
const activeUrl = '/api/benchmark/batches/active';
const settle = () => new Promise(resolve => setImmediate(resolve));

async function loadExperience() {
    const elements = {};
    const classes = new Set();
    const payloads = {
        '/api/ollama-hosts': { hosts: [{ available: true, models: ['model-a'] }] },
        '/api/profiler/hosts': { data: [{ status: 'online', baseline: { testedAt: '2026-09-07' } }] },
        [historyUrl]: { data: { batches: [{ _id: 'completed-1' }], total: 2 } },
        [activeUrl]: { data: [] },
        '/api/benchmark/judge/readiness': { data: { ready: true } }
    };
    let onReady;
    let onBodyChange;
    const fetchMock = jest.fn(async url => {
        if (!(url in payloads)) throw new Error('Unexpected request: ' + url);
        const payload = payloads[url];
        if (payload instanceof Error) throw payload;
        return { ok: true, json: async () => payload };
    });
    const context = {
        document: {
            getElementById: id => elements[id] ||= {
                listeners: {},
                addEventListener(type, handler) { this.listeners[type] = handler; },
                querySelector: () => ({ setAttribute() {}, removeAttribute() {} })
            },
            addEventListener: (_type, handler) => { onReady = handler; },
            body: { classList: { contains: name => classes.has(name) } }
        },
        MutationObserver: class {
            constructor(handler) { onBodyChange = handler; }
            observe() {}
        },
        location: { hash: '' },
        fetch: fetchMock,
        fetchActiveProfilingState: async () => ({ available: true, profiles: [], queues: [] }),
        findProfilingForHost: () => [],
        AbortController, setTimeout, clearTimeout
    };
    const filename = path.resolve(__dirname, '../../public/js/benchmark-v2/experience.js');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8').replace(/^import .*;\r?\n/m, ''), context, { filename });
    onReady();
    await settle();
    return {
        payloads, fetchMock,
        label: () => elements['evaluation-readiness-label'].textContent,
        history: () => elements['evaluation-history-detail'].textContent,
        primary: () => elements['evaluation-primary-action'].href,
        refresh: async () => { elements['evaluation-refresh'].listeners.click(); await settle(); },
        setLive: async live => {
            if (live) classes.add('state-live');
            else classes.delete('state-live');
            onBodyChange();
            await settle();
        }
    };
}

describe('Benchmark comparison entry state', () => {
    test('refreshes on start and completion and counts all completed comparisons', async () => {
        const page = await loadExperience();
        expect(page.label()).toBe('Ready to compare');
        expect(page.history()).toBe('2 completed comparisons');

        page.payloads[activeUrl] = { data: [{ _id: 'running-1' }] };
        await page.setLive(true);
        expect(page.label()).toBe('Comparison in progress');

        page.payloads[activeUrl] = { data: [] };
        page.payloads[historyUrl].data.total = 3;
        await page.setLive(false);
        expect(page.label()).toBe('Ready to compare');
        expect(page.history()).toBe('3 completed comparisons');

        const requests = page.fetchMock.mock.calls.length;
        await page.setLive(false);
        expect(page.fetchMock).toHaveBeenCalledTimes(requests);
    });

    test.each([new Error('history unavailable'), { data: { batches: [] } }])(
        'does not mistake unavailable history for an empty history: %s', async payload => {
            const page = await loadExperience();
            page.payloads[historyUrl] = payload;
            await page.refresh();
            expect(page.history()).toBe('Comparison history unavailable');
            page.payloads[historyUrl] = { data: { batches: [], total: 0 } };
            await page.refresh();
            expect(page.history()).toBe('No completed comparisons yet');
        }
    );

    test('does not claim readiness when the active-comparison check fails', async () => {
        const page = await loadExperience();
        page.payloads[activeUrl] = new Error('active status unavailable');
        await page.refresh();
        expect(page.label()).toBe('Comparison status is unknown');
        expect(page.primary()).toBe('#benchmark-cockpit');
    });

    test('a late response cannot overwrite a newer refresh', async () => {
        const page = await loadExperience();
        let release;
        const oldHosts = new Promise(resolve => { release = resolve; });
        page.fetchMock.mockImplementationOnce(() => oldHosts);
        await page.refresh();

        page.payloads[activeUrl] = { data: [{ _id: 'running-2' }] };
        await page.refresh();
        expect(page.label()).toBe('Comparison in progress');

        release({ ok: true, json: async () => ({ hosts: [] }) });
        await settle();
        expect(page.label()).toBe('Comparison in progress');
    });
});
