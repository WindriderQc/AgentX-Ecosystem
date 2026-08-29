const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const controllerSource = read('public/js/nerve-center.js');
const viewSource = read('views/pages/nerve-center.ejs');
const cssSource = read('public/css/nerve-center.css');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function loadController({ reduceMotion = false, document } = {}) {
  const context = {
    console: { error: jest.fn(), warn: jest.fn(), log: jest.fn() },
    Date,
    document: document || { addEventListener: jest.fn() },
    fetch: jest.fn(),
    localStorage: { getItem: jest.fn(), setItem: jest.fn() },
    Promise,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    window: {
      AgentXUtils: { escapeHtml },
      matchMedia: jest.fn(() => ({ matches: reduceMotion }))
    }
  };
  vm.runInNewContext(controllerSource, context, { filename: 'nerve-center.js' });
  return context;
}

function attributeNode(initial = {}) {
  const attributes = new Map(Object.entries(initial));
  return {
    id: initial.id || '',
    innerHTML: '',
    setAttribute: jest.fn((name, value) => attributes.set(name, String(value))),
    getAttribute: jest.fn(name => attributes.get(name) ?? null),
    removeAttribute: jest.fn(name => attributes.delete(name)),
    hasAttribute: name => attributes.has(name)
  };
}

describe('Nerve Center accessibility surface', () => {
  test('uses native, named controls for every summary drill-down and section disclosure', () => {
    const widgets = viewSource.match(/<button class="nc-widget nominal"[^>]*>/g) || [];
    const toggles = viewSource.match(/<button class="nc-section-toggle"[^>]*><\/button>/g) || [];

    expect(widgets).toHaveLength(8);
    widgets.forEach(widget => {
      expect(widget).toContain('type="button"');
      expect(widget).toContain('data-scroll=');
      expect(widget).toContain('aria-controls=');
      expect(widget).toContain('aria-expanded="true"');
    });

    expect(toggles).toHaveLength(8);
    toggles.forEach(toggle => {
      expect(toggle).toContain('type="button"');
      expect(toggle).toContain('data-section=');
      expect(toggle).toContain('aria-controls=');
      expect(toggle).toContain('aria-expanded="true"');
      expect(toggle).toContain('aria-labelledby=');
    });

    expect(viewSource).not.toContain('<div class="nc-widget nominal"');
    expect(controllerSource).toContain("document.querySelectorAll('.nc-section-toggle[data-section]')");
  });

  test('keeps disclosure controls and collapsed content semantics synchronized', () => {
    const body = attributeNode({ id: 'sectionClusterBody' });
    const toggle = attributeNode({ 'aria-controls': body.id, 'aria-expanded': 'true' });
    const widget = attributeNode({ 'aria-controls': body.id, 'aria-expanded': 'true' });
    const classes = new Set();
    const section = {
      id: 'sectionCluster',
      classList: {
        contains: name => classes.has(name),
        toggle: (name, force) => force ? classes.add(name) : classes.delete(name)
      },
      querySelector: selector => selector === '.nc-section-body' ? body : null
    };
    const document = {
      addEventListener: jest.fn(),
      getElementById: id => id === section.id ? section : null,
      querySelectorAll: selector => {
        if (selector === '.nc-section') return [section];
        if (selector === '[aria-controls]') return [toggle, widget];
        return [];
      }
    };
    const context = loadController({ document });

    context.window.NerveCenter.toggleSection(section.id);
    expect(body.getAttribute('aria-hidden')).toBe('true');
    expect(body.hasAttribute('inert')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(widget.getAttribute('aria-expanded')).toBe('false');

    context.window.NerveCenter.toggleSection(section.id);
    expect(body.hasAttribute('aria-hidden')).toBe(false);
    expect(body.hasAttribute('inert')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(widget.getAttribute('aria-expanded')).toBe('true');
  });

  test('uses motion-safe scrolling and removes decorative motion when requested', () => {
    const regular = loadController().window.NerveCenterShared;
    const reduced = loadController({ reduceMotion: true }).window.NerveCenterShared;

    expect(regular.motionSafeScrollBehavior()).toBe('smooth');
    expect(reduced.motionSafeScrollBehavior()).toBe('auto');
    expect(controllerSource).not.toContain("scrollIntoView({ behavior: 'smooth'");
    expect(cssSource).toContain('@media (prefers-reduced-motion: reduce)');
    expect(cssSource).toContain('.nc-container .fa-spin');
  });

  test('announces initial loading and exposes escaped section errors without leaving busy state stuck', () => {
    const shared = loadController().window.NerveCenterShared;
    const body = attributeNode();

    shared.renderSectionLoading(body, 'Loading <cluster>');
    expect(body.getAttribute('aria-busy')).toBe('true');
    expect(body.innerHTML).toContain('role="status"');
    expect(body.innerHTML).toContain('Loading &lt;cluster&gt;');

    shared.renderSectionError(body, 'Failed <cluster>');
    expect(body.getAttribute('aria-busy')).toBe('false');
    expect(body.innerHTML).toContain('role="alert"');
    expect(body.innerHTML).toContain('Failed &lt;cluster&gt;');

    expect((viewSource.match(/class="nc-section-body"[^>]*aria-busy="true"/g) || [])).toHaveLength(8);
    expect((viewSource.match(/role="status" aria-live="polite"/g) || [])).toHaveLength(8);
  });

  test.each([
    ['public/js/nerve-center-cluster.js', 'renderSectionLoading', 'renderSectionError'],
    ['public/js/nerve-center-routing.js', 'renderSectionLoading', 'renderSectionError'],
    ['public/js/nerve-center-health.js', 'renderSectionLoading', 'renderSectionError'],
    ['public/js/nerve-center-inference.js', 'renderSectionLoading', 'renderSectionError'],
    ['public/js/nerve-center-inference-health.js', 'setSectionBusy', 'renderSectionError'],
    ['public/js/nerve-center-alerts.js', 'setSectionBusy', 'renderSectionError'],
    ['public/js/nerve-center-rag.js', 'setSectionBusy', 'renderSectionError']
  ])('%s manages busy state and announces failures', (file, loadingHelper, errorHelper) => {
    const source = read(file);
    expect(source).toContain(`shared.${loadingHelper}`);
    expect(source).toContain(`shared.${errorHelper}`);
    expect(source).toContain('shared.finishSectionLoad(body)');
  });

  test('performance section clears busy state and distinguishes an unavailable baseline', () => {
    const source = read('public/js/nerve-center-performance.js');
    expect(source).toContain('shared.renderSectionLoading');
    expect(source).toContain('shared.finishSectionLoad(body)');
    expect(source).toContain('class="nc-section-error" role="alert"');
  });
});
