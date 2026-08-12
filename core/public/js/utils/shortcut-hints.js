/**
 * Keyboard Shortcut Hints
 * Adds subtle tooltips showing keyboard shortcuts to UI elements
 *
 * Usage:
 *   ShortcutHints.addHint(element, 'Ctrl+K', 'Open command palette');
 *   ShortcutHints.addHintBySelector('#sendBtn', 'Ctrl+Enter', 'Send message');
 */

const ShortcutHints = (() => {
  let styleInjected = false;

  // Inject CSS for hint tooltips
  function injectStyles() {
    if (styleInjected) return;

    const style = document.createElement('style');
    style.id = 'shortcut-hints-styles';
    style.textContent = `
      .shortcut-hint {
        position: relative;
      }

      .shortcut-hint::after {
        content: attr(data-shortcut);
        position: absolute;
        bottom: 100%;
        left: 50%;
        transform: translateX(-50%) translateY(-8px);
        background: rgba(0, 0, 0, 0.9);
        color: #fff;
        padding: 6px 10px;
        border-radius: 4px;
        font-size: 12px;
        font-family: 'Courier New', monospace;
        white-space: nowrap;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s, transform 0.2s;
        z-index: 1000;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      }

      .shortcut-hint:hover::after {
        opacity: 1;
        transform: translateX(-50%) translateY(-4px);
      }

      /* Keyboard key styling */
      .kbd {
        display: inline-block;
        padding: 2px 6px;
        font-family: 'Courier New', monospace;
        font-size: 11px;
        line-height: 1.4;
        color: #333;
        background: linear-gradient(to bottom, #fff, #f0f0f0);
        border: 1px solid #ccc;
        border-radius: 3px;
        box-shadow: 0 1px 0 rgba(0,0,0,0.1), 0 0 0 2px #fff inset;
        margin: 0 2px;
      }

      .dark .kbd {
        color: #eee;
        background: linear-gradient(to bottom, #444, #333);
        border-color: #555;
      }

      /* Badge-style shortcut indicator */
      .shortcut-badge {
        display: inline-block;
        padding: 2px 8px;
        margin-left: 8px;
        font-size: 11px;
        font-family: 'Courier New', monospace;
        background: rgba(100, 100, 100, 0.15);
        border: 1px solid rgba(100, 100, 100, 0.2);
        border-radius: 4px;
        opacity: 0.7;
      }

      button:hover .shortcut-badge,
      a:hover .shortcut-badge {
        opacity: 1;
        background: rgba(100, 100, 100, 0.25);
      }

      @media (max-width: 768px) {
        /* Hide shortcut hints on mobile */
        .shortcut-hint::after,
        .shortcut-badge {
          display: none !important;
        }
      }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }

  /**
   * Add tooltip hint to an element
   * @param {HTMLElement} element - Target element
   * @param {string} shortcut - Keyboard shortcut (e.g., 'Ctrl+K')
   * @param {string} description - Optional description
   */
  function addHint(element, shortcut, description = null) {
    if (!element) return;

    injectStyles();

    element.classList.add('shortcut-hint');
    element.setAttribute('data-shortcut', shortcut);

    if (description) {
      element.setAttribute('title', `${description} (${shortcut})`);
    } else {
      element.setAttribute('title', shortcut);
    }
  }

  /**
   * Add hint to element by selector
   * @param {string} selector - CSS selector
   * @param {string} shortcut - Keyboard shortcut
   * @param {string} description - Optional description
   */
  function addHintBySelector(selector, shortcut, description = null) {
    const element = document.querySelector(selector);
    if (element) {
      addHint(element, shortcut, description);
    }
  }

  /**
   * Add badge with shortcut to element (inline display)
   * @param {HTMLElement} element - Target element
   * @param {string} shortcut - Keyboard shortcut
   */
  function addBadge(element, shortcut) {
    if (!element) return;

    injectStyles();

    const badge = document.createElement('span');
    badge.className = 'shortcut-badge';
    badge.textContent = shortcut;
    element.appendChild(badge);
  }

  /**
   * Format shortcut key for display
   * @param {string} key - Keyboard key (e.g., 'Ctrl+K')
   * @returns {string} - HTML formatted key
   */
  function formatKey(key) {
    return key.split('+')
      .map(k => `<kbd class="kbd">${k}</kbd>`)
      .join('+');
  }

  /**
   * Initialize common shortcuts for chat UI
   */
  function initChatShortcuts() {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => initChatShortcuts());
      return;
    }

    // Add hints to common elements
    addHintBySelector('#sendBtn', 'Enter', 'Send message');
    addHintBySelector('#newChatBtn', 'Ctrl+N', 'New conversation');

    // Command palette hint (if element exists)
    const commandPaletteBtn = document.querySelector('[data-command="palette"]');
    if (commandPaletteBtn) {
      addHint(commandPaletteBtn, 'Ctrl+K', 'Open command palette');
    }
  }

  // Auto-initialize on load
  if (typeof window !== 'undefined') {
    initChatShortcuts();
  }

  return {
    addHint,
    addHintBySelector,
    addBadge,
    formatKey,
    initChatShortcuts
  };
})();

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ShortcutHints;
}
if (typeof window !== 'undefined') {
  window.ShortcutHints = ShortcutHints;
}
