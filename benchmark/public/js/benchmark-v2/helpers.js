// helpers.js — shared utilities for benchmark-v2 modules
// localStorage wrappers, HTML escaping, model name normalization

// Bump BV2_SCHEMA_VERSION when changing the shape of any bv2_* stored value.
export const BV2_SCHEMA_VERSION = '1';
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

// Normalize a model name for COMPARISON / lookup keys — strips `:latest`,
// then strips a leading single-segment namespace like `ax/` or `library/`.
// Matches the semantics of core/src/helpers/modelNameNormalization.js so UI
// lookups collide with stored records (which are keyed bare).
// NEVER use this output for writes to Ollama or the DB.
export function normModel(n) {
    const trimmed = String(n || '').trim().replace(/:latest$/i, '');
    if (!trimmed) return '';
    const slash = trimmed.indexOf('/');
    if (slash > 0 && slash < trimmed.length - 1) return trimmed.slice(slash + 1);
    return trimmed;
}
export function esc(s)            { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
export function fmtNum(n)         { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }
