const fs = require('fs');
const path = require('path');
const promptsUi = require('../../public/js/prompts-page.js');

const root = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function prompt(overrides = {}) {
  return {
    _id: overrides._id || 'prompt-id',
    name: overrides.name || 'default_chat',
    version: overrides.version || 1,
    systemPrompt: overrides.systemPrompt || 'Be useful.',
    description: overrides.description || 'Default assistant',
    isActive: overrides.isActive === true,
    trafficWeight: overrides.trafficWeight == null ? 100 : overrides.trafficWeight,
    stats: overrides.stats || { impressions: 0, positiveCount: 0, negativeCount: 0 }
  };
}

function response(data, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status || 200,
    json: jest.fn().mockResolvedValue(data)
  };
}

function element(initial = {}) {
  return {
    hidden: Boolean(initial.hidden),
    disabled: false,
    value: initial.value || '',
    textContent: initial.textContent || '',
    innerHTML: '',
    addEventListener: jest.fn(),
    ...initial
  };
}

function minimalDocument() {
  const elements = {
    promptEvidenceStatus: element(),
    exportPromptsBtn: element(),
    createPromptBtn: element(),
    totalPrompts: element(),
    activeTests: element(),
    avgPositiveRate: element(),
    totalImpressions: element(),
    searchInput: element(),
    statusFilter: element({ value: 'all' }),
    sortBy: element({ value: 'name' }),
    promptListContainer: element({ hidden: true }),
    emptyState: element({ hidden: true }),
    emptyCreateBtn: element(),
    loadingState: element(),
    errorState: element({ hidden: true }),
    errorStateMessage: element()
  };

  return {
    elements,
    document: {
      getElementById: (id) => elements[id] || null,
      addEventListener: jest.fn(),
      activeElement: null,
      body: { classList: { add: jest.fn(), remove: jest.fn() } }
    }
  };
}

describe('Prompts page UI', () => {
  test('normalizes the existing grouped API contract and computes evidence-backed totals', () => {
    const groups = promptsUi.normalizePromptPayload({
      status: 'success',
      data: {
        default_chat: [
          prompt({ version: 1, isActive: true, stats: { impressions: 30, positiveCount: 8, negativeCount: 2 } }),
          prompt({ version: 2, isActive: true, stats: { impressions: 20, positiveCount: 3, negativeCount: 2 } })
        ],
        reviewer: [prompt({ name: 'reviewer', version: 3, stats: { impressions: 5 } })]
      }
    });

    expect(groups[0].versions.map((entry) => entry.version)).toEqual([2, 1]);
    expect(promptsUi.summarizePromptGroups(groups)).toMatchObject({
      promptAssets: 2,
      activeTests: 1,
      impressions: 55,
      positiveRate: 73.33333333333333
    });
  });

  test('keeps missing feedback distinct from a measured zero and safely renders API text', () => {
    const groups = promptsUi.normalizePromptPayload({
      status: 'success',
      data: {
        '<img src=x onerror=alert(1)>': [prompt({
          name: '<img src=x onerror=alert(1)>',
          description: '<script>bad()</script>',
          stats: { impressions: 7, positiveCount: 0, negativeCount: 0 }
        })]
      }
    });
    const html = promptsUi.renderPromptCards(groups);

    expect(promptsUi.promptStats(groups[0].versions[0]).positiveRate).toBeNull();
    expect(html).toContain('—');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).not.toContain('<script>bad()</script>');
  });

  test('links selectable prompt versions to an exact, encoded Playground run', () => {
    const groups = promptsUi.normalizePromptPayload({
      status: 'success',
      data: {
        'review prompt': [
          prompt({ name: 'review prompt', version: 4, isActive: true }),
          prompt({ name: 'review prompt', version: 3, disposition: { selectable: false } })
        ]
      }
    });
    groups[0].versions.find((entry) => entry.version === 3).disposition = { selectable: false };

    const html = promptsUi.renderPromptCards(groups);

    expect(promptsUi.buildPromptRunHref('review prompt', 4)).toBe('/playground?persona=review+prompt&promptVersion=4');
    expect(html).toContain('/playground?persona=review+prompt&amp;promptVersion=4');
    expect(html).toContain('Try active v4 in Chat');
    expect(html).not.toContain('promptVersion=3');
  });

  test('filters by actual active state and places prompts without feedback last', () => {
    const groups = promptsUi.normalizePromptPayload({
      status: 'success',
      data: {
        inactive: [prompt({ name: 'inactive', description: 'quiet' })],
        measured: [prompt({
          name: 'measured',
          isActive: true,
          description: 'quality lane',
          stats: { positiveCount: 9, negativeCount: 1 }
        })]
      }
    });

    expect(promptsUi.filterAndSortPromptGroups(groups, { status: 'active' }).map((group) => group.name))
      .toEqual(['measured']);
    expect(promptsUi.filterAndSortPromptGroups(groups, { query: 'quality' }).map((group) => group.name))
      .toEqual(['measured']);
    expect(promptsUi.filterAndSortPromptGroups(groups, { sortBy: 'positiveRate' }).map((group) => group.name))
      .toEqual(['measured', 'inactive']);
  });

  test('loads and renders the list even when no editor elements are present', async () => {
    const fixture = minimalDocument();
    const fetch = jest.fn().mockResolvedValue(response({
      status: 'success',
      data: { default_chat: [prompt({ isActive: true })] }
    }));
    const page = promptsUi.createPromptPage({ document: fixture.document, fetch, timeoutMs: 100 });

    await page.init();

    expect(fetch).toHaveBeenCalledWith('/api/prompts', expect.objectContaining({ credentials: 'include' }));
    expect(fixture.elements.loadingState.hidden).toBe(true);
    expect(fixture.elements.errorState.hidden).toBe(true);
    expect(fixture.elements.promptListContainer.hidden).toBe(false);
    expect(fixture.elements.promptListContainer.innerHTML).toContain('default_chat');
    expect(fixture.elements.totalPrompts.textContent).toBe('1');
    expect(fixture.elements.createPromptBtn.disabled).toBe(false);
  });

  test('settles into explicit empty and error states instead of leaving the spinner active', async () => {
    const emptyFixture = minimalDocument();
    const emptyPage = promptsUi.createPromptPage({
      document: emptyFixture.document,
      fetch: jest.fn().mockResolvedValue(response({ status: 'success', data: {} })),
      timeoutMs: 100
    });
    await emptyPage.init();

    expect(emptyFixture.elements.loadingState.hidden).toBe(true);
    expect(emptyFixture.elements.emptyState.hidden).toBe(false);
    expect(emptyFixture.elements.createPromptBtn.disabled).toBe(false);
    expect(emptyFixture.elements.emptyCreateBtn.disabled).toBe(false);

    const errorFixture = minimalDocument();
    const errorPage = promptsUi.createPromptPage({
      document: errorFixture.document,
      fetch: jest.fn().mockResolvedValue(response(
        { status: 'error', message: 'database unavailable' },
        { ok: false, status: 503 }
      )),
      timeoutMs: 100
    });
    await errorPage.init();

    expect(errorFixture.elements.loadingState.hidden).toBe(true);
    expect(errorFixture.elements.errorState.hidden).toBe(false);
    expect(errorFixture.elements.errorStateMessage.textContent).toBe(
      'Agent X could not read prompt evidence. Check Core and MongoDB, then retry.'
    );
    expect(errorFixture.elements.createPromptBtn.disabled).toBe(true);
    expect(errorFixture.elements.emptyCreateBtn.disabled).toBe(true);
  });

  test('contains editor focus, inerts background content, and restores the opener', async () => {
    const fixture = minimalDocument();
    const attributes = () => {
      const values = new Map();
      return {
        setAttribute(name, value) { values.set(name, String(value)); },
        getAttribute(name) { return values.has(name) ? values.get(name) : null; },
        hasAttribute(name) { return values.has(name); },
        removeAttribute(name) { values.delete(name); }
      };
    };
    const background = { tagName: 'MAIN', inert: false, ...attributes() };
    const modal = element({ hidden: true, tagName: 'DIV', ...attributes() });
    const form = element({ reset: jest.fn() });
    const opener = element({ focus: jest.fn() });
    const close = element({ ...attributes() });
    const name = element({ ...attributes() });
    const cancel = element({ ...attributes() });
    const save = element({ ...attributes(), querySelector: jest.fn() });
    const controls = [close, name, cancel, save];

    fixture.document.activeElement = opener;
    controls.concat([modal]).forEach((control) => {
      control.focus = jest.fn(() => { fixture.document.activeElement = control; });
    });
    modal.querySelectorAll = jest.fn(() => controls);
    Object.assign(fixture.elements, {
      promptEditorModal: modal,
      promptEditorForm: form,
      promptEditorTitle: element(),
      promptEditorContext: element(),
      promptEditorCloseBtn: close,
      promptEditorCancelBtn: cancel,
      promptEditorSaveBtn: save,
      promptEditorError: element({ hidden: true }),
      promptNameInput: name,
      promptDescriptionInput: element(),
      systemPromptInput: element(),
      promptActiveInput: element(),
      promptTrafficWeightInput: element(),
      editorCharacterCount: element(),
      editorLineCount: element()
    });
    fixture.document.body.children = [background, modal];

    const page = promptsUi.createPromptPage({
      document: fixture.document,
      fetch: jest.fn().mockResolvedValue(response({ status: 'success', data: {} })),
      timeoutMs: 100
    });
    await page.init();
    page.openEditor(null);

    expect(modal.hidden).toBe(false);
    expect(background.inert).toBe(true);
    expect(background.getAttribute('aria-hidden')).toBe('true');
    expect(fixture.document.activeElement).toBe(name);

    const keydown = fixture.document.addEventListener.mock.calls.find(([type]) => type === 'keydown')[1];
    fixture.document.activeElement = close;
    const backwards = { key: 'Tab', shiftKey: true, preventDefault: jest.fn() };
    keydown(backwards);
    expect(backwards.preventDefault).toHaveBeenCalled();
    expect(fixture.document.activeElement).toBe(save);

    const forwards = { key: 'Tab', shiftKey: false, preventDefault: jest.fn() };
    keydown(forwards);
    expect(forwards.preventDefault).toHaveBeenCalled();
    expect(fixture.document.activeElement).toBe(close);

    page.closeEditor();
    expect(background.inert).toBe(false);
    expect(background.hasAttribute('aria-hidden')).toBe(false);
    expect(opener.focus).toHaveBeenCalled();
  });

  test('bounds a request whose transport never settles', async () => {
    jest.useFakeTimers();
    try {
      const pending = promptsUi.requestJson(
        () => new Promise(() => {}),
        '/api/prompts',
        {},
        25
      );
      jest.advanceTimersByTime(25);
      await expect(pending).rejects.toThrow('timed out');
    } finally {
      jest.useRealTimers();
    }
  });

  test('ships a native editor and a local controller with no prompt-page CDN bootstrap', () => {
    const view = read('views/pages/prompts.ejs');
    const app = read('src/app.js');
    const routeBlock = app.slice(app.indexOf("app.get('/prompts'"), app.indexOf("app.get('/backup'"));

    expect(view).toContain('id="loadingState"');
    expect(view).toContain('id="emptyState"');
    expect(view).toContain('id="errorState"');
    expect(view).toContain('<textarea id="systemPromptInput"');
    expect(view).toContain('aria-modal="true"');
    expect(view).toContain('aria-describedby="promptEditorContext"');
    expect(view).toContain('id="createPromptBtn" class="btn-primary" type="button" disabled');
    expect(routeBlock).toContain('/js/prompts-page.js');
    expect(routeBlock).not.toMatch(/https?:\/\//);
    expect(routeBlock).not.toMatch(/monaco|chart\.js/i);
  });
});
