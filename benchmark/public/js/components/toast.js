/**
 * Unified toast notification component.
 * Replaces per-page sp-toast / hs-toast / alert() patterns.
 *
 * Usage:
 *   import { showToast } from '../components/toast.js';
 *   showToast('Saved successfully');
 *   showToast('Something failed', 'error');
 *   showToast('Warning message', 'warn');
 */

const TOAST_DURATION = 3500;
const ANIM_MS = 250;

let container;

function ensureContainer() {
    if (container && document.body.contains(container)) return container;
    container = document.createElement('div');
    container.className = 'ax-toast-stack';
    document.body.appendChild(container);
    return container;
}

/**
 * Show a toast notification.
 * @param {string|Node} message  Plain-text string (always escaped) OR a DOM
 *                               Node to append (use a Node when you need
 *                               clickable links or other rich content).
 * @param {'success'|'error'|'warn'|'info'} [type='success']
 * @param {number} [duration=3500] ms before auto-dismiss
 */
export function showToast(message, type = 'success', duration = TOAST_DURATION) {
    const stack = ensureContainer();

    const el = document.createElement('div');
    el.className = `ax-toast ax-toast--${type}`;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    if (message instanceof Node) {
        el.appendChild(message);
    } else {
        el.textContent = message;
    }

    stack.appendChild(el);

    // trigger enter animation on next frame
    requestAnimationFrame(() => el.classList.add('ax-toast--visible'));

    const dismiss = () => {
        el.classList.remove('ax-toast--visible');
        setTimeout(() => el.remove(), ANIM_MS);
    };

    el.addEventListener('click', dismiss);
    setTimeout(dismiss, duration);
}
