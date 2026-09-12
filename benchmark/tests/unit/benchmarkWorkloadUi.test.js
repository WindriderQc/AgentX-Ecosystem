const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(name, stubs = {}) {
    const context = vm.createContext({ document: { addEventListener() {} }, ...stubs });
    const read = file => fs.readFileSync(path.resolve(__dirname, '../../public/js/benchmark-v2', file), 'utf8')
        .replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/export /g, '');
    vm.runInContext(read('helpers.js'), context);
    vm.runInContext(read(name), context);
    return context;
}

function formFixture() {
    const models = Array.from({ length: 5 }, (_, i) => ({ value: `model-${i}`, checked: true, dataset: {} }));
    const depths = [20, 25, 22, 20, 20].map(promptCount => ({ dataset: { promptCount, depth: 'full' } }));
    const repeats = { value: '1' };
    const depthSummary = {};
    return {
        models, depths, repeats, depthSummary,
        querySelector: selector => selector === '#bv2-adv-exec_repeats' ? repeats : selector === '#bv2-depth-summary' ? depthSummary : null,
        querySelectorAll: selector => selector.startsWith('.bv2-model-cb:checked') ? models.filter(m => m.checked)
            : selector === '.bv2-depth-radio:checked' ? depths : [],
    };
}

test('configuration, launch review and shortcut agree after readiness removes saved models and repeats change', () => {
    const form = formFixture();
    const config = load('batch-config.js');
    const elements = {};
    const summary = { querySelector: selector => elements[selector] ||= { dataset: {}, style: {}, classList: { toggle() {} } } };
    const launch = load('launch-summary.js', { getSelectedJudge: () => ({ model: 'judge' }) });
    const workflow = load('index.js', { getSelectedJudge: () => ({ model: 'judge' }) });
    workflow.form = form;
    vm.runInContext('$batchConfig = form;', workflow);
    const check = (modelCount, testCount, minutes) => {
        config._updateDepthSummary(form);
        launch.updateLaunchSummary(summary, { $batchConfig: form, modelProfiles: [] });
        expect(form.depthSummary.innerHTML).toContain(`${modelCount} models`);
        expect(form.depthSummary.innerHTML).toContain(`~${testCount} tests`);
        expect(form.depthSummary.innerHTML).toContain(`~${minutes}min`);
        expect(elements['#ls-tests .ls-val'].innerHTML).toContain(`~${testCount} tests`);
        expect(elements['#ls-est-time'].textContent).toBe(`Est. ~${minutes} min`);
        expect(workflow._getWorkflowState()).toMatchObject({ modelCount, testCount, promptCount: 107 });
    };
    check(5, 535, 268);
    form.models.slice(2).forEach(model => { model.checked = false; });
    check(2, 214, 107);
    form.repeats.value = '3';
    check(2, 642, 321);
    expect(form.depthSummary.innerHTML).toContain('× 3 repeats');
    expect(elements['#ls-tests .ls-val'].innerHTML).toContain('× 3 repeats');
});

test('zero selected models or prompts produces no tests or time estimate', () => {
    const context = load('batch-config.js');
    const form = formFixture();
    form.models.forEach(model => { model.checked = false; });
    expect(context.readComparisonWorkload(form)).toMatchObject({ modelCount: 0, testCount: 0, estimatedMinutes: 0 });
    form.models[0].checked = true;
    form.depths.forEach(radio => { radio.dataset = { depth: 'off', promptCount: 0 }; });
    expect(context.readComparisonWorkload(form)).toMatchObject({ activeLevels: 0, promptCount: 0, testCount: 0, estimatedMinutes: 0 });
});

test('only shows the launch shortcut when the primary button is outside the viewport and disconnects old observers', () => {
    const dock = { hidden: false };
    const observers = [];
    class Observer {
        constructor(callback) { this.callback = callback; this.observe = jest.fn(); this.disconnect = jest.fn(); observers.push(this); }
    }
    const context = load('launch-summary.js', { document: { getElementById: () => dock }, IntersectionObserver: Observer });
    const button = {};
    const container = { querySelector: () => button };
    context._watchLaunchVisibility(container);
    expect(dock.hidden).toBe(true);
    expect(observers[0].observe).toHaveBeenCalledWith(button);
    observers[0].callback([{ isIntersecting: false }]);
    expect(dock.hidden).toBe(false);
    observers[0].callback([{ isIntersecting: true }]);
    expect(dock.hidden).toBe(true);
    context._watchLaunchVisibility(container);
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
    observers[0].callback([{ isIntersecting: false }]);
    expect(dock.hidden).toBe(true);
    observers[1].callback([{ isIntersecting: false }]);
    expect(dock.hidden).toBe(false);
});
