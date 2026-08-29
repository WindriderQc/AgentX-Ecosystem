const fs = require('fs');
const path = require('path');
const vm = require('vm');

const benchmarkRoot = path.resolve(__dirname, '..', '..');
const read = (...segments) => fs.readFileSync(path.join(benchmarkRoot, ...segments), 'utf8');

class FakeSetupElement {
    constructor() {
        this.style = {};
        this.hidden = false;
        this.value = '';
        this.innerHTML = '';
        this.textContent = '';
        this.className = '';
        this.disabled = false;
        this.listeners = new Map();
        this.onchange = null;
    }

    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(handler);
    }

    dispatch(type, event = {}) {
        for (const handler of this.listeners.get(type) || []) {
            handler({ target: this, ...event });
        }
        if (type === 'change' && this.onchange) this.onchange({ target: this, ...event });
    }

    focus() {}
    scrollIntoView() {}
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function jsonResponse(payload, { ok = true } = {}) {
    return { ok, json: async () => payload };
}

async function loadSetupPage(probeFetch) {
    const ids = [
        'setup-return-link', 'btn-save', 'btn-connect', 'ollama-ip',
        'already-configured', 'configured-host-field', 'configured-host',
        'step-models', 'models-subtitle', 'model-grid', 'step-judge',
        'judge-model', 'judge-status', 'connect-status'
    ];
    const elements = Object.fromEntries(ids.map((id) => [id, new FakeSetupElement()]));
    const fetchMock = jest.fn((url, options) => {
        if (url === '/api/setup/status') {
            return Promise.resolve(jsonResponse({ configured: false, hosts: [], judge: null }));
        }
        return probeFetch(url, options);
    });

    const sourcePath = path.join(benchmarkRoot, 'public', 'js', 'setup', 'index.js');
    let source = fs.readFileSync(sourcePath, 'utf8').replace(/^import .*?;\r?\n/m, '');
    source += `
globalThis.__setupTest = {
  probeConnection,
  saveConfig,
  getState: () => ({
    resolvedUrl,
    discoveredModels: discoveredModels.map(model => model.name),
    probeRevision,
    hasActiveProbe: !!activeProbeController
  })
};`;

    const context = {
        console,
        document: {
            querySelector: (selector) => elements[selector.slice(1)] || null,
            getElementById: (id) => elements[id] || null
        },
        window: {
            location: { search: '', origin: 'http://benchmark.test', href: '' },
            matchMedia: () => ({ matches: true })
        },
        URL,
        URLSearchParams,
        AbortController,
        fetch: fetchMock,
        requestAnimationFrame: (callback) => callback(),
        showToast: jest.fn()
    };
    context.global = context;
    context.globalThis = context;
    vm.runInNewContext(source, context, { filename: sourcePath });
    await new Promise((resolve) => setImmediate(resolve));

    return { setup: context.__setupTest, elements, fetchMock, showToast: context.showToast };
}

describe('Benchmark judge setup and Courthouse navigation contracts', () => {
    test('the Benchmark hero does not claim launch readiness without judge evidence', () => {
        const source = read('public', 'js', 'benchmark-v2', 'experience.js');

        expect(source).toContain("fetchJson('/api/benchmark/judge/readiness')");
        expect(source).toContain("setReadiness('unknown', 'Judge status is unknown'");
        expect(source).toContain("setReadiness('error', 'Judge is not ready'");
        expect(source).toContain("'/setup?focus=judge&return=%2F'");
        expect(source).toMatch(/judgeReadiness\.ready !== true[\s\S]*Ready to compare/);
    });

    test('the Benchmark hero reads the active-batch array contract used by the API', () => {
        const source = read('public', 'js', 'benchmark-v2', 'experience.js');

        expect(source).toContain('Array.isArray(activeData)');
        expect(source).toContain('activeData[0] || null');
        expect(source).toMatch(/if \(activeId\)[\s\S]*Comparison in progress/);
    });

    test('focused judge setup restores configured hosts and an explicit installed selection', () => {
        const page = read('views', 'pages', 'setup.ejs');
        const source = read('public', 'js', 'setup', 'index.js');

        expect(page).toContain('id="configured-host"');
        expect(page).toContain('host.docker.internal');
        expect(page).toContain('when Benchmark runs directly');
        expect(page).not.toMatch(/picked a good default/i);
        expect(source).toContain("setupParams.get('focus') === 'judge'");
        expect(source).toContain("fetch('/api/setup/status')");
        expect(source).toContain('renderConfiguredHosts(configuredHosts, configuredJudge)');
        expect(source).toContain('await probeConnection(initialHost.url');
        expect(source).toContain('Restored the explicitly configured judge');
        expect(source).toContain('safeReturnPath');
        expect(source).toContain('window.location.href = returnPath');
        expect(source).toContain("addEventListener('input'");
        expect(source).toContain('activeProbeController?.abort()');
        expect(source).toContain('revision !== probeRevision');
        expect(source).not.toContain('autoSelectJudge');
    });

    test('Courthouse tabs expose complete ARIA relationships and keyboard navigation', () => {
        const page = read('views', 'pages', 'courthouse.ejs');
        const source = read('public', 'js', 'courthouse-v2', 'index.js');
        const css = read('public', 'css', 'courthouse-v2-layout.css');

        for (const name of ['review', 'calibration', 'tests', 'ledger', 'config']) {
            expect(page).toContain(`id="ch-tab-${name}"`);
            expect(page).toContain(`aria-controls="ch-panel-${name}"`);
            expect(page).toContain(`id="ch-panel-${name}"`);
            expect(page).toContain(`aria-labelledby="ch-tab-${name}"`);
        }
        expect(source).toContain("event.key === 'ArrowRight'");
        expect(source).toContain("event.key === 'ArrowLeft'");
        expect(source).toContain("event.key === 'Home'");
        expect(source).toContain("event.key === 'End'");
        expect(source).toContain('btn.tabIndex = active ? 0 : -1');
        expect(css).toContain('overflow-x: auto');
        expect(css).toContain('.ch-tab:focus-visible');
    });
});

describe('Benchmark setup connection state', () => {
    test('editing a verified endpoint clears its models, judge, and save authority', async () => {
        const { setup, elements, fetchMock, showToast } = await loadSetupPage(async () =>
            jsonResponse({
                success: true,
                url: 'http://alpha:11434',
                models: [{ name: 'judge-alpha:7b' }]
            })
        );

        await setup.probeConnection('alpha', { preferredJudge: 'judge-alpha:7b' });
        expect(setup.getState()).toMatchObject({
            resolvedUrl: 'http://alpha:11434',
            discoveredModels: ['judge-alpha:7b']
        });
        expect(elements['btn-save'].disabled).toBe(false);

        elements['ollama-ip'].value = 'beta';
        elements['ollama-ip'].dispatch('input');

        expect(setup.getState()).toMatchObject({ resolvedUrl: '', discoveredModels: [] });
        expect(elements['step-models'].style.display).toBe('none');
        expect(elements['step-judge'].style.display).toBe('none');
        expect(elements['judge-model'].disabled).toBe(true);
        expect(elements['btn-save'].disabled).toBe(true);
        expect(elements['connect-status'].textContent).toMatch(/test the connection again/i);

        await setup.saveConfig();
        expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/test the current endpoint/i), 'error');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('an older probe cannot overwrite a newer successful endpoint', async () => {
        const requests = [];
        const { setup, elements } = await loadSetupPage((_url, options) => {
            const pending = deferred();
            requests.push({ pending, signal: options.signal });
            return pending.promise;
        });

        const alphaProbe = setup.probeConnection('alpha', { preferredJudge: 'judge-alpha:7b' });
        const betaProbe = setup.probeConnection('beta', { preferredJudge: 'judge-beta:7b' });
        expect(requests[0].signal.aborted).toBe(true);

        requests[1].pending.resolve(jsonResponse({
            success: true,
            url: 'http://beta:11434',
            models: [{ name: 'judge-beta:7b' }]
        }));
        await betaProbe;
        requests[0].pending.resolve(jsonResponse({
            success: true,
            url: 'http://alpha:11434',
            models: [{ name: 'judge-alpha:7b' }]
        }));
        await alphaProbe;

        expect(setup.getState()).toMatchObject({
            resolvedUrl: 'http://beta:11434',
            discoveredModels: ['judge-beta:7b'],
            hasActiveProbe: false
        });
        expect(elements['ollama-ip'].value).toBe('http://beta:11434');
        expect(elements['judge-model'].value).toBe('judge-beta:7b');
        expect(elements['btn-save'].disabled).toBe(false);
    });

    test('a superseded probe cannot unlock the connect button while its replacement is pending', async () => {
        const requests = [];
        const { setup, elements } = await loadSetupPage((_url, options) => {
            const pending = deferred();
            requests.push({ pending, signal: options.signal });
            return pending.promise;
        });

        const alphaProbe = setup.probeConnection('alpha');
        const betaProbe = setup.probeConnection('beta');
        requests[0].pending.resolve(jsonResponse({
            success: true,
            url: 'http://alpha:11434',
            models: [{ name: 'judge-alpha:7b' }]
        }));
        await alphaProbe;

        expect(elements['btn-connect'].disabled).toBe(true);
        expect(elements['btn-connect'].textContent).toBe('Testing\u2026');
        expect(setup.getState().hasActiveProbe).toBe(true);

        requests[1].pending.resolve(jsonResponse({
            success: true,
            url: 'http://beta:11434',
            models: []
        }));
        await betaProbe;
        expect(elements['btn-connect'].disabled).toBe(false);
    });

    test('a failed replacement probe cannot leave the prior endpoint saveable', async () => {
        const responses = [
            jsonResponse({
                success: true,
                url: 'http://alpha:11434',
                models: [{ name: 'judge-alpha:7b' }]
            }),
            jsonResponse({
                success: false,
                code: 'OLLAMA_CONNECTION_REFUSED',
                error: 'Connection refused'
            })
        ];
        const { setup, elements } = await loadSetupPage(async () => responses.shift());

        await setup.probeConnection('alpha', { preferredJudge: 'judge-alpha:7b' });
        expect(elements['btn-save'].disabled).toBe(false);
        await setup.probeConnection('beta');

        expect(setup.getState()).toMatchObject({ resolvedUrl: '', discoveredModels: [] });
        expect(elements['btn-save'].disabled).toBe(true);
        expect(elements['connect-status'].textContent).toMatch(/connection refused/i);
    });
});
