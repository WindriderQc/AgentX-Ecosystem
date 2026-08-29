/**
 * Shared error banner component
 * Consistent error display across v2 pages
 */

/**
 * Show a fatal error banner at the top of the page
 * @param {string} message - Error message to display
 * @param {HTMLElement} [container] - Optional container (defaults to document.body prepend)
 */
export function showFatalError(message, container) {
    const el = document.createElement('div');
    el.className = 'r-fatal-error';
    el.setAttribute('role', 'alert');
    el.setAttribute('aria-live', 'assertive');
    const icon = document.createElement('span');
    icon.className = 'r-fatal-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '⚠';
    el.appendChild(icon);
    el.appendChild(document.createTextNode(` ${message}`));
    if (container) {
        container.prepend(el);
    } else {
        document.body.prepend(el);
    }
    return el;
}

/**
 * Show an inline section error
 * @param {HTMLElement} container - Section container
 * @param {string} message - Error message
 */
export function showSectionError(container, message) {
    if (!container) return;
    container.textContent = '';
    const error = document.createElement('div');
    error.className = 'r-section-error';
    error.setAttribute('role', 'alert');
    error.textContent = message;
    container.appendChild(error);
}
