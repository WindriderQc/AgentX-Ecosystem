// format.js — shared formatting utilities for benchmark frontend ES modules
// Canonical source for escHtml, fmtNum, fmtMs, fmtPct.

/**
 * Escape a string for safe HTML insertion.
 * @param {string} str
 * @returns {string}
 */
export function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Format a number to fixed decimal places.
 * @param {number|null} n
 * @param {number} decimals
 * @returns {string}
 */
export function fmtNum(n, decimals = 1) {
    if (n === null || n === undefined) return '\u2014';
    return Number(n).toFixed(decimals);
}

/**
 * Format milliseconds into a human-readable string.
 * @param {number|null} ms
 * @returns {string}
 */
export function fmtMs(ms) {
    if (ms === null || ms === undefined) return '\u2014';
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.round(ms)}ms`;
}

/**
 * Format a fraction as a percentage string.
 * @param {number|null} n - 0–1 fraction
 * @returns {string}
 */
export function fmtPct(n) {
    if (n === null || n === undefined) return '\u2014';
    return `${Math.round(n * 100)}%`;
}
