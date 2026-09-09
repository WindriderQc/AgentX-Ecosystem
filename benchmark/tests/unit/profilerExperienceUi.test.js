const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function render(readiness, { unavailable = false } = {}) {
    const elements = {};
    function element(id) {
        return elements[id] ||= { listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; },
            querySelector: () => element(id + '-child'), setAttribute() {}, removeAttribute() {} };
    }
    let ready;
    const payloads = {
        '/api/ollama-hosts': { hosts: [{ available: true, models: ['model'] }] },
        '/api/profiler/hosts': { data: [{ baseline: { testedAt: '2026-09-09' } }] },
        '/api/profiler/models': { data: [{ stage: 'profiled', readiness: { primary: readiness } }] }
    };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../public/js/model-profiler/experience.js'), 'utf8'), {
        document: { getElementById: element, querySelectorAll: () => [], addEventListener: (_type, callback) => { ready = callback; } },
        fetch: async url => {
            if (unavailable && url === '/api/profiler/models') throw new Error('unavailable');
            return { ok: true, json: async () => payloads[url] };
        }, AbortController, setTimeout, clearTimeout
    });
    ready();
    await new Promise(resolve => setImmediate(resolve));
    return elements;
}

test.each([
    { stage: 'profiled', stale: true, benchmarkQualified: false, authority: { verified: false } },
    { stage: 'benchmarked', stale: false, benchmarkQualified: true, authority: { verified: false } }
])('does not declare stale or unverified profiles prepared', async readiness => {
    const elements = await render(readiness);
    expect(elements['profiler-experience-status-label'].textContent).toBe('Profile the contenders');
    expect(elements['profiler-models-detail'].textContent).toContain('0 ready');
});

test('uses verified current evidence to declare comparison readiness', async () => {
    const elements = await render({ stage: 'profiled', stale: false, benchmarkQualified: true, authority: { verified: true } });
    expect(elements['profiler-experience-status-label'].textContent).toBe('Prepared for comparison');
});

test('reports unavailable evidence as unknown', async () => {
    const elements = await render(null, { unavailable: true });
    expect(elements['profiler-experience-status-label'].textContent).toBe('Preparation status is unknown');
});
