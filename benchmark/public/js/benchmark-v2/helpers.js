// helpers.js — shared utilities for benchmark-v2 modules
// localStorage wrappers, HTML escaping, model name normalization

// Bump BV2_SCHEMA_VERSION when changing the shape of any bv2_* stored value.
export const BV2_SCHEMA_VERSION = '2';
const BV2_SCHEMA_KEY = 'bv2_schema_version';

/**
 * Check localStorage schema version on load.
 * If the stored version doesn't match BV2_SCHEMA_VERSION, clear all bv2_* keys
 * and write the new version. Prevents stale localStorage from causing confusing bugs.
 */
export function ensureBv2Schema() {
    try {
        const stored = localStorage.getItem(BV2_SCHEMA_KEY);
        if (stored === BV2_SCHEMA_VERSION) return;

        // Version mismatch — clear all bv2_* keys
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('bv2_')) keysToRemove.push(key);
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
        localStorage.setItem(BV2_SCHEMA_KEY, BV2_SCHEMA_VERSION);
    } catch (_) { /* localStorage unavailable */ }
}

export function save(key, val)    { try { localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val)); } catch (_) {} }
export function load(key)         { try { return localStorage.getItem(key); } catch (_) { return null; } }
export function loadObj(key)      { try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : {}; } catch (_) { return {}; } }
export function loadSet(key)      { try { const r = localStorage.getItem(key); return r ? new Set(JSON.parse(r)) : null; } catch (_) { return null; } }
export function loadArr(key)      { try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : []; } catch (_) { return []; } }

// Normalize only Ollama's implicit `:latest` alias. Namespaces are identity.
export function normModel(n) {
    const trimmed = String(n || '').trim().replace(/:latest$/i, '');
    return trimmed;
}
export function esc(s)            { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
export function fmtNum(n)         { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }
