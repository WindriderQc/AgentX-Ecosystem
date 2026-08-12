/**
 * Toast Notification System
 * Lightweight, accessible toast notifications for user feedback
 *
 * Usage:
 *   Toast.success('Operation completed!');
 *   Toast.error('Something went wrong');
 *   Toast.info('Tip: Press Ctrl+K to open command palette');
 *   Toast.warning('Your session will expire soon');
 */

const Toast = (() => {
  let container = null;

  // Initialize toast container on first use
  function init() {
    if (container) return;

    container = document.createElement('div');
    container.id = 'toast-container';
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    container.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
      max-width: 400px;
    `;
    document.body.appendChild(container);
  }

  // Create and show a toast
  function show(message, type = 'info', duration = 4000) {
    init();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'alert');
    toast.style.cssText = `
      background: var(--toast-bg-${type}, #333);
      color: var(--toast-text-${type}, #fff);
      padding: 12px 20px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      display: flex;
      align-items: center;
      gap: 12px;
      pointer-events: auto;
      cursor: pointer;
      animation: toastSlideIn 0.3s ease-out;
      font-size: 14px;
      line-height: 1.4;
      max-width: 400px;
      word-wrap: break-word;
    `;

    // Icon based on type
    const icons = {
      success: '✓',
      error: '✕',
      warning: '⚠',
      info: 'ℹ'
    };

    const colors = {
      success: { bg: '#10b981', text: '#fff' },
      error: { bg: '#ef4444', text: '#fff' },
      warning: { bg: '#f59e0b', text: '#000' },
      info: { bg: '#3b82f6', text: '#fff' }
    };

    const color = colors[type] || colors.info;
    toast.style.background = color.bg;
    toast.style.color = color.text;

    const icon = document.createElement('span');
    icon.textContent = icons[type] || icons.info;
    icon.style.cssText = `
      font-size: 18px;
      font-weight: bold;
      flex-shrink: 0;
    `;

    const text = document.createElement('span');
    text.textContent = message;
    text.style.cssText = 'flex: 1;';

    toast.appendChild(icon);
    toast.appendChild(text);

    // Click to dismiss
    toast.addEventListener('click', () => {
      dismissToast(toast);
    });

    container.appendChild(toast);

    // Auto dismiss after duration
    if (duration > 0) {
      setTimeout(() => {
        dismissToast(toast);
      }, duration);
    }

    return toast;
  }

  // Dismiss a toast with animation
  function dismissToast(toast) {
    toast.style.animation = 'toastSlideOut 0.3s ease-out';
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }

  // Inject CSS animations
  function injectStyles() {
    if (document.getElementById('toast-styles')) return;

    const style = document.createElement('style');
    style.id = 'toast-styles';
    style.textContent = `
      @keyframes toastSlideIn {
        from {
          transform: translateX(400px);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }

      @keyframes toastSlideOut {
        from {
          transform: translateX(0);
          opacity: 1;
        }
        to {
          transform: translateX(400px);
          opacity: 0;
        }
      }

      .toast:hover {
        transform: scale(1.02);
        box-shadow: 0 6px 16px rgba(0,0,0,0.4);
        transition: transform 0.2s, box-shadow 0.2s;
      }

      @media (max-width: 768px) {
        #toast-container {
          top: 10px;
          right: 10px;
          left: 10px;
          max-width: none;
        }

        .toast {
          max-width: none !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  // Initialize styles on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectStyles);
  } else {
    injectStyles();
  }

  // Public API
  return {
    success: (message, duration) => show(message, 'success', duration),
    error: (message, duration) => show(message, 'error', duration),
    warning: (message, duration) => show(message, 'warning', duration),
    info: (message, duration) => show(message, 'info', duration),
    show
  };
})();

// Export for use in modules or global scope
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Toast;
}
if (typeof window !== 'undefined') {
  window.Toast = Toast;
}
