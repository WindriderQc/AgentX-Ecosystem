/**
 * Keyboard Shortcuts Help Modal — Benchmark Service
 * Lightweight modal showing available keyboard shortcuts.
 * Self-registers Ctrl+/ (or Cmd+/) to toggle the modal.
 */

const ShortcutsHelpModal = (() => {
  let _isOpen = false;
  let _overlay = null;

  const shortcuts = [
    {
      category: 'General',
      items: [
        { keys: 'Ctrl+/', description: 'Show keyboard shortcuts' },
        { keys: 'Escape', description: 'Close dialogs and modals' }
      ]
    }
  ];

  function formatKeys(keys) {
    return keys.split('+')
      .map(key => `<kbd>${key}</kbd>`)
      .join('<span class="sc-key-sep">+</span>');
  }

  function createModal() {
    const el = document.createElement('div');
    el.className = 'sc-modal-overlay';
    el.innerHTML = `
      <div class="sc-modal">
        <div class="sc-modal-header">
          <h2><i class="fas fa-keyboard"></i> Keyboard Shortcuts</h2>
          <button class="sc-modal-close" aria-label="Close"><i class="fas fa-times"></i></button>
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
          <p><i class="fas fa-lightbulb"></i> Press <kbd>Ctrl</kbd><span class="sc-key-sep">+</span><kbd>/</kbd> anywhere to toggle this dialog.</p>
        </div>
      </div>
    `;
    return el;
  }

  function injectStyles() {
    if (document.getElementById('sc-modal-styles')) return;
    const style = document.createElement('style');
    style.id = 'sc-modal-styles';
    style.textContent = `
      .sc-modal-overlay {
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.7);
        display: flex; align-items: center; justify-content: center;
        z-index: 10001; animation: scFadeIn 0.2s ease-out;
        backdrop-filter: blur(4px);
      }
      .sc-modal {
        background: var(--surface-1, #1a1a2e); color: var(--text-primary, #e2e8f0);
        border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        width: 90%; max-width: 440px; max-height: 80vh;
        display: flex; flex-direction: column; animation: scSlideUp 0.3s ease-out;
      }
      .sc-modal-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 20px 24px 14px; border-bottom: 1px solid rgba(255,255,255,0.1);
      }
      .sc-modal-header h2 {
        margin: 0; font-size: 20px; font-weight: 600;
        display: flex; align-items: center; gap: 10px;
      }
      .sc-modal-header h2 i { color: var(--accent, #7cf0ff); }
      .sc-modal-close {
        background: none; border: none; color: #94a3b8;
        font-size: 20px; cursor: pointer; padding: 6px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 6px; transition: all 0.2s;
      }
      .sc-modal-close:hover { background: rgba(255,255,255,0.1); color: #fff; }
      .sc-modal-body { padding: 20px 24px; overflow-y: auto; flex: 1; }
      .sc-category { margin-bottom: 24px; }
      .sc-category:last-child { margin-bottom: 0; }
      .sc-category h3 {
        margin: 0 0 12px; font-size: 13px; font-weight: 600;
        color: var(--accent, #7cf0ff);
        text-transform: uppercase; letter-spacing: 0.5px;
      }
      .sc-list { display: flex; flex-direction: column; gap: 8px; }
      .sc-item {
        display: flex; justify-content: space-between; align-items: center;
        padding: 10px 12px; background: rgba(255,255,255,0.03);
        border-radius: 8px; transition: background 0.2s;
      }
      .sc-item:hover { background: rgba(255,255,255,0.06); }
      .sc-keys {
        display: flex; align-items: center; gap: 4px;
        font-family: 'Courier New', monospace; min-width: 120px;
      }
      .sc-keys kbd {
        display: inline-block; padding: 3px 8px;
        font-size: 12px; font-weight: 600; line-height: 1.4;
        color: var(--text-primary, #e2e8f0);
        background: linear-gradient(to bottom, rgba(255,255,255,0.1), rgba(255,255,255,0.05));
        border: 1px solid rgba(255,255,255,0.2); border-radius: 5px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2), 0 0 0 2px rgba(255,255,255,0.05) inset;
      }
      .sc-key-sep { color: #94a3b8; font-weight: bold; padding: 0 2px; }
      .sc-desc { flex: 1; color: #94a3b8; font-size: 13px; }
      .sc-modal-footer {
        padding: 14px 24px; border-top: 1px solid rgba(255,255,255,0.1);
        background: rgba(255,255,255,0.02); border-radius: 0 0 12px 12px;
      }
      .sc-modal-footer p {
        margin: 0; font-size: 12px; color: #94a3b8;
        display: flex; align-items: center; gap: 6px;
      }
      .sc-modal-footer p kbd {
        display: inline-block; padding: 2px 6px; font-size: 11px; font-weight: 600;
        color: var(--text-primary, #e2e8f0);
        background: linear-gradient(to bottom, rgba(255,255,255,0.1), rgba(255,255,255,0.05));
        border: 1px solid rgba(255,255,255,0.2); border-radius: 4px;
      }
      .sc-modal-footer i { color: var(--accent, #7cf0ff); }
      .nav-shortcuts-btn {
        background: none; border: none; color: #94a3b8;
        font-size: 14px; cursor: pointer; padding: 6px 8px;
        border-radius: 6px; transition: all 0.2s;
        display: flex; align-items: center;
      }
      .nav-shortcuts-btn:hover { color: #fff; background: rgba(255,255,255,0.05); }
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
    `;
    document.head.appendChild(style);
  }

  function show() {
    if (_isOpen) return;
    injectStyles();
    _overlay = createModal();
    document.body.appendChild(_overlay);
    _isOpen = true;

    const closeBtn = _overlay.querySelector('.sc-modal-close');
    closeBtn.addEventListener('click', hide);
    _overlay.addEventListener('click', (e) => { if (e.target === _overlay) hide(); });

    const handleEscape = (e) => {
      if (e.key === 'Escape') { hide(); document.removeEventListener('keydown', handleEscape); }
    };
    document.addEventListener('keydown', handleEscape);
    setTimeout(() => closeBtn.focus(), 100);
  }

  function hide() {
    if (!_isOpen || !_overlay) return;
    _overlay.style.animation = 'scFadeOut 0.2s ease-out';
    const ref = _overlay;
    setTimeout(() => {
      if (ref && ref.parentNode) ref.parentNode.removeChild(ref);
      if (_overlay === ref) { _overlay = null; _isOpen = false; }
    }, 200);
  }

  // Global Ctrl+/ handler
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      _isOpen ? hide() : show();
    }
  });

  return { show, hide, isOpen: () => _isOpen };
})();

if (typeof window !== 'undefined') {
  window.ShortcutsHelpModal = ShortcutsHelpModal;
}
