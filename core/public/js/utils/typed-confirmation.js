(function (root) {
  'use strict';

  const HEADER = 'X-AgentX-Confirm';
  const DIALOG_ID = 'agentxTypedConfirmationDialog';
  let pending = null;
  let returnFocus = null;

  function normalizePart(value) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  }

  function phrase() {
    const expected = Array.from(arguments).map(normalizePart).filter(Boolean).join(' ');
    if (!expected) throw new TypeError('Typed confirmation requires a non-empty phrase');
    return expected;
  }

  function headers(expected) {
    return { [HEADER]: phrase(expected) };
  }

  function resolveReturnFocus(activeElement) {
    const menu = activeElement?.closest?.('.action-menu, [role="menu"]');
    const menuTrigger = menu?.parentElement?.querySelector?.('[aria-haspopup="menu"], .btn-actions');
    return menuTrigger || activeElement;
  }

  function finish(value) {
    const resolve = pending;
    const focusTarget = returnFocus;
    pending = null;
    const dialog = root.document?.getElementById(DIALOG_ID);
    if (dialog?.open) dialog.close();
    returnFocus = null;
    if (resolve) resolve(value);
    // Let the originating click finish first. Menus commonly close from a
    // document-level click handler; focusing synchronously would target an
    // item that becomes hidden later in the same event.
    root.setTimeout?.(() => {
      if (focusTarget?.isConnected !== false) focusTarget?.focus?.();
    }, 0);
  }

  function ensureDialog() {
    const documentRef = root.document;
    if (!documentRef?.body) return null;
    const existing = documentRef.getElementById(DIALOG_ID);
    if (existing) return existing;

    const dialog = documentRef.createElement('dialog');
    dialog.id = DIALOG_ID;
    dialog.className = 'agentx-confirm-dialog';
    dialog.setAttribute('aria-labelledby', 'agentxConfirmTitle');
    dialog.setAttribute('aria-describedby', 'agentxConfirmDescription agentxConfirmInstruction');
    dialog.innerHTML = [
      '<form method="dialog" class="agentx-confirm-card" novalidate>',
      '  <div class="agentx-confirm-icon" aria-hidden="true"><i class="fas fa-triangle-exclamation"></i></div>',
      '  <div class="agentx-confirm-copy">',
      '    <p class="agentx-confirm-kicker">Permanent action</p>',
      '    <h2 id="agentxConfirmTitle">Confirm this action</h2>',
      '    <p id="agentxConfirmDescription"></p>',
      '    <p id="agentxConfirmInstruction">Type <code id="agentxConfirmExpected"></code> exactly to continue.</p>',
      '    <label for="agentxConfirmInput">Confirmation phrase</label>',
      '    <input id="agentxConfirmInput" type="text" autocomplete="off" spellcheck="false" aria-describedby="agentxConfirmError">',
      '    <p id="agentxConfirmError" class="agentx-confirm-error" aria-live="polite"></p>',
      '  </div>',
      '  <div class="agentx-confirm-actions">',
      '    <button type="button" class="btn agentx-confirm-cancel">Cancel</button>',
      '    <button type="submit" class="btn agentx-confirm-submit" disabled>Confirm action</button>',
      '  </div>',
      '</form>'
    ].join('');
    documentRef.body.appendChild(dialog);

    const input = dialog.querySelector('#agentxConfirmInput');
    const submit = dialog.querySelector('.agentx-confirm-submit');
    const error = dialog.querySelector('#agentxConfirmError');
    dialog.querySelector('.agentx-confirm-cancel').addEventListener('click', () => finish(null));
    input.addEventListener('input', () => {
      const exact = input.value === dialog.dataset.expected;
      submit.disabled = !exact;
      error.textContent = input.value && !exact ? 'The phrase must match exactly.' : '';
    });
    dialog.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      if (input.value !== dialog.dataset.expected) {
        error.textContent = 'The phrase must match exactly.';
        input.focus();
        return;
      }
      finish(dialog.dataset.expected);
    });
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(null);
    });
    return dialog;
  }

  function request(options) {
    const config = typeof options === 'string' ? { expected: options } : (options || {});
    const expected = config.expected
      ? phrase(config.expected)
      : phrase(config.action, ...(Array.isArray(config.resource) ? config.resource : [config.resource]));
    const dialog = ensureDialog();

    if (!dialog?.showModal) {
      const supplied = typeof root.prompt === 'function'
        ? root.prompt(`${config.description || 'This action changes or removes durable data.'}\n\nType ${expected} exactly to continue.`)
        : null;
      return Promise.resolve(supplied === expected ? expected : null);
    }

    if (pending) finish(null);
    returnFocus = resolveReturnFocus(root.document.activeElement);
    dialog.dataset.expected = expected;
    dialog.querySelector('#agentxConfirmTitle').textContent = config.title || 'Confirm this permanent action';
    dialog.querySelector('#agentxConfirmDescription').textContent = config.description || 'This action changes or removes durable product data and cannot be silently undone.';
    dialog.querySelector('#agentxConfirmExpected').textContent = expected;
    dialog.querySelector('#agentxConfirmInput').value = '';
    dialog.querySelector('#agentxConfirmError').textContent = '';
    dialog.querySelector('.agentx-confirm-submit').disabled = true;
    dialog.showModal();
    root.setTimeout(() => dialog.querySelector('#agentxConfirmInput').focus(), 0);
    return new Promise((resolve) => { pending = resolve; });
  }

  async function confirm(options) {
    const expected = await request(options);
    return expected ? headers(expected) : null;
  }

  const api = Object.freeze({ HEADER, phrase, headers, request, confirm });
  root.AgentXTypedConfirmation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
