const fs = require('fs');
const path = require('path');
const vm = require('vm');
const settle = () => new Promise(resolve => setImmediate(resolve));

function setup() {
    const button = { addEventListener: (_type, callback) => { button.click = callback; } };
    const status = { textContent: '' };
    const listeners = new Map();
    const selected = [{ value: 'a', dataset: {} }, { value: 'b', dataset: {} }];
    const container = {
        dataset: {},
        querySelector: selector => selector === '#bv2-quick-comparison' ? button : status,
        querySelectorAll: () => selected,
        addEventListener: (type, callback) => listeners.set(type, callback),
        removeEventListener: type => listeners.delete(type)
    };
    const apiFetch = jest.fn();
    const apply = jest.fn();
    const context = { apiFetch, getSelectedJudge: () => ({ model: 'b', host: 'http://fixture' }), AbortController, setTimeout, clearTimeout };
    const filename = path.resolve(__dirname, '../../public/js/benchmark-v2/quick-comparison.js');
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(filename, 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/export /g, ''), context);
    const bind = () => context.wireQuickComparison(container, { host: { url: 'http://fixture' }, apply });
    bind();
    return { button, status, container, selected, apiFetch, apply, bind, change: () => listeners.get('change')() };
}

test('applies the measured preset only after a successful response', async () => {
    const page = setup();
    const preset = { summary: 'Measured at 8192', warning: 'Judge is a contender' };
    page.apiFetch.mockResolvedValue({ data: preset });
    await page.button.click();
    expect(page.apply).toHaveBeenCalledWith(preset);
    expect(page.status.textContent).toContain('Judge is a contender');
    expect(page.container.dataset.quickPending).toBeUndefined();
    page.change();
    expect(page.status.textContent).toContain('Settings changed');
});

test.each(['change', 'bind'])('ignores a late response after %s and cancels its request', async action => {
    const page = setup();
    let release;
    page.apiFetch.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = page.button.click();
    await settle();
    expect(page.container.dataset.quickPending).toBe('true');
    page[action]();
    expect(page.apiFetch.mock.calls[0][1].signal.aborted).toBe(true);
    release({ data: { summary: 'Old selection' } });
    await pending;
    expect(page.apply).not.toHaveBeenCalled();
    expect(page.container.dataset.quickPending).toBeUndefined();
});

test('keeps the existing settings on failure and supports an explicit retry', async () => {
    const page = setup();
    page.apiFetch.mockRejectedValueOnce(new Error('Prepare model b first'))
        .mockResolvedValueOnce({ data: { summary: 'Measured at 8192' } });
    await page.button.click();
    expect(page.status.textContent).toBe('Prepare model b first');
    expect(page.apply).not.toHaveBeenCalled();
    expect(page.button.disabled).toBe(false);
    await page.button.click();
    expect(page.apply).toHaveBeenCalledTimes(1);
});

test('cloud targets and incomplete selections never request a local quick preset', async () => {
    const page = setup();
    page.selected[0].dataset.executionKind = 'harness';
    await page.button.click();
    expect(page.apiFetch).not.toHaveBeenCalled();
    expect(page.status.textContent).toContain('exactly two local models');
});
