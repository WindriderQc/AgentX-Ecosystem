/**
 * Keyboard Shortcuts Help Modal
 * Page-context aware modal showing available keyboard shortcuts.
 * Self-registers Ctrl+/ (or Cmd+/) to toggle the modal on any page.
 *
 * API:
 *   ShortcutsHelpModal.show()           — open modal
 *   ShortcutsHelpModal.hide()           — close modal
 *   ShortcutsHelpModal.isOpen()         — boolean
 *   ShortcutsHelpModal.setShortcuts(arr)— replace the shortcuts list
 *   ShortcutsHelpModal.addCategory(name, items) — append a category
 *
 * Each page can call setShortcuts() on DOMContentLoaded to display
 * page-specific shortcuts. If no page calls it, the default "General"
 * category is shown.
 */

/**
 * Shared accessibility lifecycle for lightweight overlay dialogs.
 *
 * The shortcuts script is already loaded by every service that renders the
 * shared navigation, so keeping this primitive here avoids another cross-
 * service asset dependency. Dialog owners remain responsible for their visual
 * open/closed state; this controller owns background isolation, contained
 * keyboard focus, Escape requests, and opener restoration.
 */
window.AgentXModalAccessibility = window.AgentXModalAccessibility || (() => {
  const states = new WeakMap();
  const stack = [];
  const focusableSelector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  function focusableControls(dialog) {
    if (!dialog || typeof dialog.querySelectorAll !== 'function') return [];
    return Array.from(dialog.querySelectorAll(focusableSelector)).filter(control => {
      if (!control || control.hidden || control.disabled) return false;
      if (typeof control.getAttribute === 'function' && control.getAttribute('aria-hidden') === 'true') return false;
      if (typeof control.closest === 'function' && control.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
      return true;
    });
  }

  function isolateBackground(dialog, documentRef) {
    const isolated = [];
    const body = documentRef && documentRef.body;
    if (!body || !body.children) return isolated;

    Array.from(body.children).forEach(child => {
      const containsDialog = child === dialog
        || (typeof child.contains === 'function' && child.contains(dialog));
      if (containsDialog || child.tagName === 'SCRIPT' || child.tagName === 'STYLE') return;
      isolated.push({
        element: child,
        inert: Boolean(child.inert),
        hadAriaHidden: typeof child.hasAttribute === 'function' && child.hasAttribute('aria-hidden'),
        ariaHidden: typeof child.getAttribute === 'function' ? child.getAttribute('aria-hidden') : null
      });
      child.inert = true;
      if (typeof child.setAttribute === 'function') child.setAttribute('aria-hidden', 'true');
    });
    return isolated;
  }

  function restoreBackground(isolated) {
    isolated.forEach(entry => {
      entry.element.inert = entry.inert;
      if (typeof entry.element.removeAttribute !== 'function') return;
      if (entry.hadAriaHidden) entry.element.setAttribute('aria-hidden', entry.ariaHidden);
      else entry.element.removeAttribute('aria-hidden');
    });
  }

  function activate(dialog, options = {}) {
    if (!dialog || states.has(dialog)) return;
    const documentRef = dialog.ownerDocument || document;
    const opener = options.opener || documentRef.activeElement || null;
    const state = {
      documentRef,
      opener,
      isolated: isolateBackground(dialog, documentRef),
      onRequestClose: typeof options.onRequestClose === 'function' ? options.onRequestClose : null,
      keydown: null
    };

    dialog.inert = false;
    if (typeof dialog.removeAttribute === 'function') dialog.removeAttribute('aria-hidden');

    state.keydown = event => {
      if (stack[stack.length - 1] !== dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
        if (state.onRequestClose) state.onRequestClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const controls = focusableControls(dialog);
      if (!controls.length) {
        event.preventDefault();
        if (typeof dialog.focus === 'function') dialog.focus();
        return;
      }

      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = documentRef.activeElement;
      const focusOutside = typeof dialog.contains === 'function' && !dialog.contains(active);
      if (event.shiftKey && (active === first || focusOutside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || focusOutside)) {
        event.preventDefault();
        first.focus();
      }
    };

    states.set(dialog, state);
    stack.push(dialog);
    documentRef.addEventListener('keydown', state.keydown, true);

    const initialFocus = options.initialFocus || focusableControls(dialog)[0] || dialog;
    if (initialFocus && typeof initialFocus.focus === 'function') initialFocus.focus();
  }

  function deactivate(dialog, options = {}) {
    const state = dialog && states.get(dialog);
    if (!state) return;
    state.documentRef.removeEventListener('keydown', state.keydown, true);
    const index = stack.lastIndexOf(dialog);
    if (index >= 0) stack.splice(index, 1);
    restoreBackground(state.isolated);
    states.delete(dialog);

    dialog.inert = true;
    if (typeof dialog.setAttribute === 'function') dialog.setAttribute('aria-hidden', 'true');
    if (options.restoreFocus !== false && state.opener && typeof state.opener.focus === 'function') {
      state.opener.focus({ preventScroll: true });
    }
  }

  return { activate, deactivate, focusableControls };
})();

window.ShortcutsHelpModal = window.ShortcutsHelpModal || (() => {
  let _isOpen = false;
  let _isClosing = false;
  let _overlay = null;
  let _trigger = null;
  const dialogId = 'keyboardShortcutsDialog';

  // Default shortcuts — every core page gets these
  let shortcuts = [
    {
      category: 'General',
      items: [
        { keys: 'Ctrl+/', description: 'Show keyboard shortcuts' },
        { keys: 'Escape', description: 'Close dialogs and modals' },
        { keys: 'Ctrl+Shift+B', description: 'Toggle Buddy panel' }
      ]
    }
  ];

  /** Replace the full shortcuts list */
  function setShortcuts(list) {
    shortcuts = list;
  }

  /** Append a category to the current list */
  function addCategory(category, items) {
    shortcuts.push({ category, items });
  }

  function formatKeys(keys) {
    return keys.split('+')
      .map(key => `<kbd>${key}</kbd>`)
      .join('<span class="sc-key-sep">+</span>');
  }

  function configureShortcutTriggers() {
    if (typeof document.querySelectorAll !== 'function') return;
    document.querySelectorAll('[data-nav-action="show-shortcuts"], #showShortcutsBtn').forEach(trigger => {
      trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.setAttribute('aria-controls', dialogId);
      if (!trigger.hasAttribute('aria-expanded')) trigger.setAttribute('aria-expanded', 'false');
    });
  }

  function createModal() {
    const el = document.createElement('div');
    el.id = dialogId;
    el.className = 'sc-modal-overlay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'sc-modal-title');
    el.setAttribute('aria-describedby', 'sc-modal-instructions');
    el.setAttribute('tabindex', '-1');
    el.innerHTML = `
      <div class="sc-modal">
        <div class="sc-modal-header">
          <h2 id="sc-modal-title"><i class="fas fa-keyboard" aria-hidden="true"></i> Keyboard Shortcuts</h2>
          <button class="sc-modal-close" type="button" aria-label="Close keyboard shortcuts"><i class="fas fa-times" aria-hidden="true"></i></button>
        </div>
        <div class="sc-modal-body">
          ${shortcuts.map(cat => `
            <div class="sc-category">
              <h3>${cat.category}</h3>
              <div class="sc-list">
                ${cat.items.map(item => `
                  <div class="sc-item">
                    <span class="sc-keys">${formatKeys(item.keys)}</span>
                    <span class="sc-desc">${item.description}</span>
                  </div>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
        <div class="sc-modal-footer">
          <p id="sc-modal-instructions"><i class="fas fa-lightbulb" aria-hidden="true"></i> Press <kbd>Ctrl</kbd><span class="sc-key-sep">+</span><kbd>/</kbd> anywhere to toggle this dialog.</p>
        </div>
      </div>
    `;
    return el;
  }

  // ── Styles (injected once) ──────────────────────────────────

  function injectStyles() {
    if (document.getElementById('sc-modal-styles')) return;

    const style = document.createElement('style');
    style.id = 'sc-modal-styles';
    style.textContent = `
      .sc-modal-overlay {
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.7);
        display: flex; align-items: center; justify-content: center;
        z-index: 10001;
        animation: scFadeIn 0.2s ease-out;
        backdrop-filter: blur(4px);
      }
      .sc-modal {
        background: var(--bg, #1a1a1a);
        color: var(--text, #fff);
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        width: 90%; max-width: 520px; max-height: 80vh;
        display: flex; flex-direction: column;
        animation: scSlideUp 0.3s ease-out;
      }
      .sc-modal-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 20px 24px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.1);
      }
      .sc-modal-header h2 {
        margin: 0; font-size: 20px; font-weight: 600;
        display: flex; align-items: center; gap: 10px;
      }
      .sc-modal-header h2 i { color: var(--accent, #ee80ff); }
      .sc-modal-close {
        background: none; border: none; color: var(--muted, #999);
        font-size: 20px; cursor: pointer; padding: 6px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 6px; transition: all 0.2s;
      }
      .sc-modal-close:hover {
        background: rgba(255,255,255,0.1); color: var(--text, #fff);
      }
      .sc-modal-close:focus-visible {
        outline: 3px solid var(--accent, #ee80ff); outline-offset: 2px;
      }
      .sc-modal-body {
        padding: 20px 24px; overflow-y: auto; flex: 1;
      }
      .sc-category { margin-bottom: 24px; }
      .sc-category:last-child { margin-bottom: 0; }
      .sc-category h3 {
        margin: 0 0 12px; font-size: 13px; font-weight: 600;
        color: var(--accent, #ee80ff);
        text-transform: uppercase; letter-spacing: 0.5px;
      }
      .sc-list { display: flex; flex-direction: column; gap: 8px; }
      .sc-item {
        display: flex; justify-content: space-between; align-items: center;
        padding: 10px 12px;
        background: rgba(255,255,255,0.03); border-radius: 8px;
        transition: background 0.2s;
      }
      .sc-item:hover { background: rgba(255,255,255,0.06); }
      .sc-keys {
        display: flex; align-items: center; gap: 4px;
        font-family: 'Courier New', monospace; min-width: 160px;
      }
      .sc-keys kbd {
        display: inline-block; padding: 3px 8px;
        font-size: 12px; font-weight: 600; line-height: 1.4;
        color: var(--text, #fff);
        background: linear-gradient(to bottom, rgba(255,255,255,0.1), rgba(255,255,255,0.05));
        border: 1px solid rgba(255,255,255,0.2);
        border-radius: 5px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2), 0 0 0 2px rgba(255,255,255,0.05) inset;
      }
      .sc-key-sep { color: var(--muted, #999); font-weight: bold; padding: 0 2px; }
      .sc-desc { flex: 1; color: var(--muted, #ccc); font-size: 13px; }
      .sc-modal-footer {
        padding: 14px 24px;
        border-top: 1px solid rgba(255,255,255,0.1);
        background: rgba(255,255,255,0.02);
        border-radius: 0 0 12px 12px;
      }
      .sc-modal-footer p {
        margin: 0; font-size: 12px; color: var(--muted, #999);
        display: flex; align-items: center; gap: 6px;
      }
      .sc-modal-footer p kbd {
        display: inline-block; padding: 2px 6px;
        font-size: 11px; font-weight: 600;
        color: var(--text, #fff);
        background: linear-gradient(to bottom, rgba(255,255,255,0.1), rgba(255,255,255,0.05));
        border: 1px solid rgba(255,255,255,0.2);
        border-radius: 4px;
      }
      .sc-modal-footer i { color: var(--accent, #ee80ff); }

      @keyframes scFadeIn { from { opacity: 0; } to { opacity: 1; } }
      @keyframes scSlideUp {
        from { opacity: 0; transform: translateY(20px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @keyframes scFadeOut { from { opacity: 1; } to { opacity: 0; } }

      @media (max-width: 768px) {
        .sc-modal { width: 95%; max-height: 90vh; }
        .sc-item { flex-direction: column; align-items: flex-start; gap: 6px; }
        .sc-keys { min-width: auto; }
      }
      @media (prefers-reduced-motion: reduce) {
        .sc-modal-overlay, .sc-modal { animation: none !important; }
      }
    `;
    document.head.appendChild(style);
  }

  // ── Show / Hide ─────────────────────────────────────────────

  function show() {
    if (_isOpen || _isClosing) return;
    const opener = document.activeElement;
    _trigger = opener && typeof opener.matches === 'function'
      && opener.matches('[data-nav-action="show-shortcuts"], #showShortcutsBtn')
      ? opener
      : null;
    if (_trigger) {
      _trigger.setAttribute('aria-haspopup', 'dialog');
      _trigger.setAttribute('aria-controls', dialogId);
      _trigger.setAttribute('aria-expanded', 'true');
    }
    injectStyles();
    _overlay = createModal();
    document.body.appendChild(_overlay);
    _isOpen = true;

    const closeBtn = _overlay.querySelector('.sc-modal-close');
    closeBtn.addEventListener('click', hide);
    _overlay.addEventListener('click', (e) => { if (e.target === _overlay) hide(); });
    window.AgentXModalAccessibility.activate(_overlay, {
      opener,
      initialFocus: closeBtn,
      onRequestClose: hide
    });
  }

  function hide() {
    if (!_isOpen || !_overlay) return;
    const ref = _overlay;
    _overlay = null;
    _isOpen = false;
    _isClosing = true;
    if (_trigger) _trigger.setAttribute('aria-expanded', 'false');
    _trigger = null;
    window.AgentXModalAccessibility.deactivate(ref);
    ref.style.animation = 'scFadeOut 0.2s ease-out';
    setTimeout(() => {
      if (ref && ref.parentNode) ref.parentNode.removeChild(ref);
      _isClosing = false;
    }, 200);
  }

  // ── Global Ctrl+/ handler ───────────────────────────────────

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      _isOpen ? hide() : show();
    }
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', configureShortcutTriggers, { once: true });
  } else {
    configureShortcutTriggers();
  }

  return {
    show,
    hide,
    isOpen: () => _isOpen,
    setShortcuts,
    addCategory
  };
})();

// window.ShortcutsHelpModal already assigned above via ||= pattern
