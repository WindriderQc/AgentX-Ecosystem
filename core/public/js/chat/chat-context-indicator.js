/**
 * chat-context-indicator.js — resolve + display the effective context window
 * for the currently selected (model, host) from the Modelfile (source of truth).
 *
 * Updates the existing #tokenLimit pill in the chat header, plus a small
 * source-badge (#contextSourceBadge) so the user can see whether the number
 * came from the Modelfile, an operator pin, a profile, or remains unresolved.
 *
 * Per architectural rule (2026-04-18): chat DISPLAYS context, never configures
 * it. This module is read-only UX; it does not mutate request payloads.
 */

(function () {
  'use strict';

  const SOURCE_LABELS = {
    modelfile: { label: 'Modelfile', tone: 'ok', tip: 'Context from Ollama Modelfile — the source of truth.' },
    profiled: { label: 'Profiled', tone: 'ok', tip: 'Context verified by benchmark profiler.' },
    model_context_profile: { label: 'Profiled', tone: 'ok', tip: 'Context verified for this model and host.' },
    host_preference_pin: { label: 'Pinned', tone: 'ok', tip: 'Resident context explicitly pinned for this model and host.' },
    model_capacity: { label: 'Model max', tone: 'warn', tip: 'Reported model capacity (no Modelfile PARAMETER num_ctx).' },
    unresolved: { label: 'Unresolved', tone: 'danger', tip: 'No runtime context was inferred. Configure or profile this model and host.' }
  };

  // Cache in-memory for the session (server also caches 5 min)
  const _cache = new Map();

  async function fetchContextInfo(model, host) {
    if (!model) return null;
    const key = `${host || ''}::${model}`;
    if (_cache.has(key)) return _cache.get(key);
    const url = `/api/models/registry/${encodeURIComponent(model)}/context-info${host ? `?host=${encodeURIComponent(host)}` : ''}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const body = await res.json();
      const info = body?.data || null;
      if (info) _cache.set(key, info);
      return info;
    } catch {
      return null;
    }
  }

  function ensureBadge() {
    let badge = document.getElementById('contextSourceBadge');
    if (badge) return badge;
    const pill = document.getElementById('conversationTokens');
    if (!pill) return null;
    badge = document.createElement('span');
    badge.id = 'contextSourceBadge';
    badge.className = 'context-source-badge';
    badge.style.cssText = 'margin-left:4px;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:600;opacity:0.75;cursor:help;';
    pill.appendChild(badge);
    return badge;
  }

  function applyBadge(sourceKey) {
    const badge = ensureBadge();
    if (!badge) return;
    const meta = SOURCE_LABELS[sourceKey] || SOURCE_LABELS.unresolved;
    badge.textContent = meta.label;
    badge.title = meta.tip;
    const tones = {
      ok:     { bg: 'rgba(34,197,94,0.15)',  fg: '#86efac' },
      warn:   { bg: 'rgba(234,179,8,0.18)',  fg: '#fde68a' },
      danger: { bg: 'rgba(239,68,68,0.18)',  fg: '#fca5a5' }
    };
    const tone = tones[meta.tone] || tones.warn;
    badge.style.background = tone.bg;
    badge.style.color = tone.fg;
  }

  function formatK(n) {
    const num = Number(n);
    if (!isFinite(num) || num < 1000) return String(num);
    if (num < 1_000_000) {
      const k = num / 1000;
      return (k >= 10 ? Math.round(k) : k.toFixed(1)) + 'k';
    }
    return (num / 1_000_000).toFixed(1) + 'M';
  }

  function applyLimit(numCtx) {
    const el = document.getElementById('tokenLimit');
    const resolved = Number.isFinite(Number(numCtx)) && Number(numCtx) > 0;
    if (el) {
      el.textContent = resolved ? formatK(numCtx) : '—';
      el.title = resolved
        ? `${Number(numCtx).toLocaleString()} tokens (model context limit)`
        : 'Model context is unresolved';
    }
    // Reveal the pill so the limit is visible even before the first message
    const pill = document.getElementById('conversationTokens');
    if (pill) pill.style.display = 'inline-flex';
    // Expose for updateConversationStats to read as authoritative limit
    if (resolved) window.__chatContextLimit = Number(numCtx);
    else delete window.__chatContextLimit;
  }

  /**
   * Public API: refresh the indicator for the given model + host. Silent on
   * failure — the existing hardcoded pill value remains until next refresh.
   */
  async function refresh({ model, host } = {}) {
    if (!model) return;
    const info = await fetchContextInfo(model, host);
    if (!info) return;
    applyLimit(info.num_ctx);
    applyBadge(info.source);
  }

  /**
   * Clear the per-model context badge. Used by server-routed session modes
   * where the selected-model dropdown is NOT the model that answers — showing
   * its resolved context (e.g. a "Fallback" badge) would be misleading.
   */
  function reset() {
    const badge = document.getElementById('contextSourceBadge');
    if (badge) {
      badge.textContent = '';
      badge.title = '';
      badge.style.background = 'transparent';
    }
    const el = document.getElementById('tokenLimit');
    if (el) { el.textContent = 'Auto'; el.title = 'Context window set by the session model on the server.'; }
    window.__chatContextLimit = null;
  }

  window.ChatContextIndicator = { refresh, reset, _cache };
})();
