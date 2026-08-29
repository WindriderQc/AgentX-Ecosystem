'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');

const coreRoot = path.resolve(__dirname, '..', '..');
const shortcutsPath = path.join(coreRoot, 'public', 'js', 'utils', 'shortcuts-modal.js');
const profilePath = path.join(coreRoot, 'public', 'js', 'chat', 'chat-profile.js');
const mainPath = path.join(coreRoot, 'public', 'js', 'chat', 'chat-main.js');
const chatPath = path.join(coreRoot, 'views', 'pages', 'chat.ejs');

function attributes(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    setAttribute(name, value) { values.set(name, String(value)); },
    getAttribute(name) { return values.has(name) ? values.get(name) : null; },
    hasAttribute(name) { return values.has(name); },
    removeAttribute(name) { values.delete(name); },
  };
}

function createNode(documentRef, tagName = 'DIV') {
  const node = {
    tagName,
    hidden: false,
    disabled: false,
    inert: false,
    ownerDocument: documentRef,
    children: [],
    ...attributes(),
  };
  node.contains = candidate => node === candidate || node.children.includes(candidate);
  node.closest = () => null;
  node.querySelectorAll = () => [];
  node.focus = jest.fn(() => { documentRef.activeElement = node; });
  return node;
}

function loadControllerFixture() {
  const listeners = [];
  const documentRef = {
    activeElement: null,
    body: { children: [] },
    addEventListener: jest.fn((type, handler, capture) => listeners.push({ type, handler, capture })),
    removeEventListener: jest.fn((type, handler, capture) => {
      const index = listeners.findIndex(entry => entry.type === type && entry.handler === handler && entry.capture === capture);
      if (index >= 0) listeners.splice(index, 1);
    }),
    getElementById: jest.fn(() => null),
  };
  const context = { console, document: documentRef, setTimeout, clearTimeout };
  context.window = context;
  context.self = context;
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(shortcutsPath, 'utf8'), context, { filename: 'shortcuts-modal.js' });
  return { controller: context.AgentXModalAccessibility, documentRef, listeners };
}

describe('shared modal accessibility lifecycle', () => {
  test('isolates the background, traps focus, requests Escape close, and restores the opener', () => {
    const fixture = loadControllerFixture();
    const background = createNode(fixture.documentRef, 'MAIN');
    const dialog = createNode(fixture.documentRef);
    const opener = createNode(fixture.documentRef, 'BUTTON');
    const first = createNode(fixture.documentRef, 'BUTTON');
    const last = createNode(fixture.documentRef, 'BUTTON');
    dialog.children = [first, last];
    dialog.querySelectorAll = jest.fn(() => [first, last]);
    fixture.documentRef.body.children = [background, dialog];
    fixture.documentRef.activeElement = opener;
    const requestClose = jest.fn();

    fixture.controller.activate(dialog, {
      opener,
      initialFocus: first,
      onRequestClose: requestClose,
    });

    expect(background.inert).toBe(true);
    expect(background.getAttribute('aria-hidden')).toBe('true');
    expect(fixture.documentRef.activeElement).toBe(first);

    const modalKeydown = fixture.listeners.find(entry => entry.type === 'keydown' && entry.capture === true).handler;
    fixture.documentRef.activeElement = last;
    const forward = { key: 'Tab', shiftKey: false, preventDefault: jest.fn() };
    modalKeydown(forward);
    expect(forward.preventDefault).toHaveBeenCalled();
    expect(fixture.documentRef.activeElement).toBe(first);

    fixture.documentRef.activeElement = first;
    const backward = { key: 'Tab', shiftKey: true, preventDefault: jest.fn() };
    modalKeydown(backward);
    expect(backward.preventDefault).toHaveBeenCalled();
    expect(fixture.documentRef.activeElement).toBe(last);

    const escape = { key: 'Escape', preventDefault: jest.fn(), stopPropagation: jest.fn() };
    modalKeydown(escape);
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(escape.stopPropagation).toHaveBeenCalled();
    expect(requestClose).toHaveBeenCalledTimes(1);

    fixture.controller.deactivate(dialog);
    expect(background.inert).toBe(false);
    expect(background.hasAttribute('aria-hidden')).toBe(false);
    expect(dialog.inert).toBe(true);
    expect(dialog.getAttribute('aria-hidden')).toBe('true');
    expect(opener.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  test('ships a named shortcuts dialog wired to the shared lifecycle', () => {
    const source = fs.readFileSync(shortcutsPath, 'utf8');

    expect(source).toContain("el.setAttribute('role', 'dialog')");
    expect(source).toContain("el.setAttribute('aria-modal', 'true')");
    expect(source).toContain("el.setAttribute('aria-labelledby', 'sc-modal-title')");
    expect(source).toContain("el.setAttribute('aria-describedby', 'sc-modal-instructions')");
    expect(source).toContain('aria-label="Close keyboard shortcuts"');
    expect(source).toContain('window.AgentXModalAccessibility.activate(_overlay');
    expect(source).toContain('window.AgentXModalAccessibility.deactivate(ref)');
  });
});

describe('Playground profile dialog', () => {
  test('connects dialog naming, descriptions, controls, and field labels', async () => {
    const html = await ejs.renderFile(chatPath, {});

    expect(html).toContain('id="profileBtn" type="button" aria-haspopup="dialog" aria-controls="profileModal" aria-expanded="false"');
    expect(html).toContain('id="profileModal" class="modal hidden" role="dialog" aria-modal="true"');
    expect(html).toContain('aria-labelledby="profileModalTitle"');
    expect(html).toContain('aria-describedby="profileModalDescription profilePersistenceNote"');
    expect(html).toContain('aria-hidden="true" tabindex="-1" inert');
    expect(html).toContain('id="closeProfileBtn" class="close-btn" type="button" aria-label="Close user profile"');
    for (const id of ['userAbout', 'memoryLanguage', 'memoryRole', 'memoryStyle', 'userInstructions']) {
      expect(html).toContain(`<label for="${id}">`);
    }
    expect(html).toContain('id="userAbout" rows="5" aria-describedby="userAboutHint"');
    expect(html).toContain('id="userInstructions" rows="3" aria-describedby="userInstructionsHint"');
  });

  test('opens and closes through the shared lifecycle, including save and backdrop paths', () => {
    const profile = fs.readFileSync(profilePath, 'utf8');
    const main = fs.readFileSync(mainPath, 'utf8');

    expect(profile).toContain('export function openProfileModal(elements)');
    expect(profile).toContain('modalAccessibility.activate(modal');
    expect(profile).toContain('initialFocus: elements.userAbout');
    expect(profile).toContain('onRequestClose: () => closeProfileModal(elements)');
    expect(profile).toContain('export function closeProfileModal(elements)');
    expect(profile).toContain('modalAccessibility.deactivate(modal)');
    expect(profile).toContain('closeProfileModal(elements);');
    expect(main).toContain('_openProfileModal(elements)');
    expect(main).toContain('_closeProfileModal(elements)');
    expect(main).toContain('if (event.target === elements.profileModal)');
  });
});
