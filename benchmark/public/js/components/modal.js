/**
 * Unified modal component.
 * Provides ARIA attributes, ESC dismiss, backdrop click, and focus trap.
 *
 * Usage (declarative — existing HTML element):
 *   import { openModal, closeModal } from '../components/modal.js';
 *   openModal(document.getElementById('myModal'));
 *   closeModal(document.getElementById('myModal'));
 *
 * Usage (imperative — create on the fly):
 *   import { createModal } from '../components/modal.js';
 *   const { overlay, content, close } = createModal();
 *   content.innerHTML = '<p>Hello</p>';
 */

const ACTIVE_MODALS = new Set();

// ── Focus trap helper ────────────────────────────────────────────────────────

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function trapFocus(e, root) {
    const focusable = [...root.querySelectorAll(FOCUSABLE)];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
}

// ── Global ESC listener (one for all modals) ────────────────────────────────

let escListenerAttached = false;

function attachEscListener() {
    if (escListenerAttached) return;
    escListenerAttached = true;
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && ACTIVE_MODALS.size > 0) {
            // Close the most recently opened modal
            const last = [...ACTIVE_MODALS].pop();
            closeModal(last);
        }
    });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Open an existing modal element.
 * Sets ARIA attributes, display, ESC dismiss, backdrop click, and focus trap.
 * @param {HTMLElement} el  The modal overlay element (position:fixed backdrop)
 * @param {object} [opts]
 * @param {boolean} [opts.closeOnBackdrop=true]  Close when clicking backdrop
 */
export function openModal(el, opts = {}) {
    const { closeOnBackdrop = true } = opts;

    el.style.display = 'flex';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');

    el._prevFocus = document.activeElement;
    ACTIVE_MODALS.add(el);
    attachEscListener();

    // Focus first focusable child
    requestAnimationFrame(() => {
        const first = el.querySelector(FOCUSABLE);
        if (first) first.focus();
    });

    // Backdrop click
    if (closeOnBackdrop) {
        el._backdropHandler = (e) => { if (e.target === el) closeModal(el); };
        el.addEventListener('click', el._backdropHandler);
    }

    // Focus trap
    el._focusTrapHandler = (e) => { if (e.key === 'Tab') trapFocus(e, el); };
    el.addEventListener('keydown', el._focusTrapHandler);
}

/**
 * Close a modal opened with openModal().
 * @param {HTMLElement} el  The modal overlay element
 */
export function closeModal(el) {
    if (!el) return;
    el.style.display = 'none';
    el.removeAttribute('aria-modal');
    ACTIVE_MODALS.delete(el);

    if (el._backdropHandler) {
        el.removeEventListener('click', el._backdropHandler);
        el._backdropHandler = null;
    }
    if (el._focusTrapHandler) {
        el.removeEventListener('keydown', el._focusTrapHandler);
        el._focusTrapHandler = null;
    }
    if (el._prevFocus && el._prevFocus.focus) {
        el._prevFocus.focus();
        el._prevFocus = null;
    }
}

/**
 * Create a new modal overlay + content pair, ready to populate.
 * @returns {{ overlay: HTMLElement, content: HTMLElement, close: () => void }}
 */
export function createModal() {
    const overlay = document.createElement('div');
    overlay.className = 'ax-modal-overlay';

    const content = document.createElement('div');
    content.className = 'ax-modal-content';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ax-modal-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = '&times;';

    content.appendChild(closeBtn);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    const close = () => {
        closeModal(overlay);
        overlay.remove();
    };

    closeBtn.addEventListener('click', close);
    openModal(overlay);

    return { overlay, content, close };
}
