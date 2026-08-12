// event-log.js — Live event log panel for benchmark-v2 (section 2.10)
// Exported API: renderEventLog(container), appendEvents(container, timelineEntries, seenSet)

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Format a timestamp to a short HH:MM:SS string.
 * Accepts ISO strings, epoch ms numbers, or Date objects.
 */
function fmtTime(ts) {
    if (!ts) return '--:--';
    const d = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(d)) return '--:--';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Derive the CSS event type class from an event type string.
 * Timeline entries may carry a `type`, `stage`, `status`, or fall back to 'exec'.
 *
 * Mapping:
 *   prep     → ev-prep  (gray)
 *   warmup   → ev-warm  (amber)
 *   exec / executing / scored / completed → ev-exec (cyan)
 *   judge / judging  → ev-jdg  (purple)
 *   error / failed   → ev-err  (red)
 */
function eventTypeClass(entry) {
    const raw = (entry.event || entry.type || entry.stage || entry.status || '').toLowerCase();

    if (raw === 'prep' || raw === 'preparation')                                  return 'ev-prep';
    if (raw === 'warmup' || raw === 'warm' || raw === 'judge_warmup')              return 'ev-warm';
    if (raw === 'model_early_stopped')                                             return 'ev-warm';
    if (raw.startsWith('judge') || raw === 'judging')                              return 'ev-jdg';
    if (raw === 'error' || raw === 'failed' || raw === 'err')                      return 'ev-err';

    // test_start, test_complete, exec, executing, scored, completed, etc.
    return 'ev-exec';
}

/**
 * Map event type class to icon character.
 */
function eventIcon(typeClass) {
    switch (typeClass) {
        case 'ev-prep': return '&#9679;';  // grey circle
        case 'ev-warm': return '&#9650;';  // amber triangle up
        case 'ev-jdg':  return '&#9878;';  // gavel/hammer
        case 'ev-err':  return '&#10007;'; // red cross
        default:        return '&#9654;';  // cyan play
    }
}

/**
 * Build a unique key for a timeline entry to de-duplicate via seenSet.
 */
function entryKey(entry) {
    const ts  = entry.timestamp || entry.ts || entry.created_at || '';
    const evt = entry.event || entry.message || entry.msg || entry.prompt_id || '';
    const mdl = entry.model || '';
    return `${ts}::${evt}::${mdl}`;
}

/**
 * Build a human-readable message string from a timeline entry.
 */
function entryMessage(entry) {
    // Prefer an explicit message field
    if (entry.message) return entry.message;
    if (entry.msg)     return entry.msg;

    // Fall back: derive from event + model + prompt
    const event = entry.event || entry.stage || entry.status || entry.type || '';
    const model = entry.model || '';
    const prompt = entry.prompt_name || entry.prompt_id || '';
    const dur = entry.duration_ms ? `${(entry.duration_ms / 1000).toFixed(1)}s` : '';
    const shortPrompt = prompt ? `"${String(prompt).slice(0, 40)}"` : '';

    // Friendly messages for known pipeline events
    switch (event) {
        case 'test_start':
            return `Executing ${model}${shortPrompt ? ` on ${shortPrompt}` : ''}`;
        case 'test_complete':
            return `Response received from ${model}${shortPrompt ? ` — ${shortPrompt}` : ''}${dur ? ` (${dur})` : ''}`;
        case 'judge_start':
            return `Judging ${model}${shortPrompt ? ` — ${shortPrompt}` : ''}`;
        case 'judge_complete':
            return `${entry.success !== false ? 'Scored' : 'Judge failed'} ${model}${shortPrompt ? ` — ${shortPrompt}` : ''}${dur ? ` (${dur})` : ''}`;
        case 'model_warmup':
        case 'judge_warmup':
            return `Warming up ${model || 'model'}${dur ? ` (${dur})` : ''}`;
        case 'error':
            return `Error: ${model}${shortPrompt ? ` — ${shortPrompt}` : ''}${entry.error ? ` — ${String(entry.error).slice(0, 60)}` : ''}`;
        case 'tests_start':
            return 'Benchmark tests started';
        case 'host_execution_failed':
            return `Host failed: ${entry.host || ''}${entry.error ? ` — ${entry.error}` : ''}`;
        case 'model_early_stopped':
            return `Early-stop: ${entry.model || 'model'} — avg score ${entry.avg_score ?? '?'}/10 over ${entry.judged_count ?? '?'} prompts (threshold ${entry.threshold ?? '?'})`;
        default: {
            const parts = [];
            if (event) parts.push(event.replace(/_/g, ' '));
            if (model) parts.push(model);
            if (shortPrompt) parts.push(shortPrompt);
            if (dur) parts.push(dur);
            return parts.join(' — ') || 'event';
        }
    }
}

// ── Builder ───────────────────────────────────────────────────────────────────

function buildEventRow(entry) {
    const typeClass = eventTypeClass(entry);
    const icon      = eventIcon(typeClass);
    const time      = fmtTime(entry.timestamp || entry.ts || entry.created_at);
    const msg       = esc(entryMessage(entry));

    // For judge_complete events, tokens_per_sec carries the quality score
    const isJudgeEvent = (entry.event || '').startsWith('judge_complete');
    const score = entry.score != null
        ? Number(entry.score)
        : (isJudgeEvent && entry.tokens_per_sec != null ? Number(entry.tokens_per_sec) : null);
    let scoreHTML = '';
    if (score != null) {
        const sCls = score >= 7 ? 'sg' : score >= 4 ? 'sm' : 'sl';
        scoreHTML = `<span class="es ${esc(sCls)}">${score.toFixed(1)}</span>`;
    }

    return `<div class="ev ${esc(typeClass)}">
  <span class="et">${esc(time)}</span>
  <span class="ei">${icon}</span>
  <span class="em">${msg}</span>
  ${scoreHTML}
</div>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initial render of the event log panel.
 * Sets up the header label and empty log list.
 *
 * @param {HTMLElement} container — the #event-log div
 */
export function renderEventLog(container) {
    // The HTML shell already provides .el-t header and #ev-list.
    // Ensure #ev-list is present; if not, inject it.
    if (!container.querySelector('#ev-list')) {
        const listEl = document.createElement('div');
        listEl.id = 'ev-list';
        container.appendChild(listEl);
    }

    const listEl = container.querySelector('#ev-list');
    if (listEl) listEl.innerHTML = '';
}

/**
 * Prepend new timeline entries to the event log.
 * Only entries whose key is not already in seenSet will be added.
 * Mutates seenSet in place by adding newly-seen keys.
 *
 * @param {HTMLElement}  container      — the #event-log div
 * @param {Array}        timelineEntries — array from fetchTimeline()
 * @param {Set<string>}  seenSet         — mutable set of already-seen entry keys
 */
export function appendEvents(container, timelineEntries, seenSet) {
    const listEl = container.querySelector('#ev-list');
    if (!listEl) return;

    const entries = Array.isArray(timelineEntries) ? timelineEntries : [];
    const newRows = [];

    for (const entry of entries) {
        const key = entryKey(entry);
        if (seenSet.has(key)) continue;
        seenSet.add(key);
        newRows.push(buildEventRow(entry));
    }

    if (!newRows.length) return;

    // Prepend newest events at the top
    const fragment = document.createElement('div');
    fragment.innerHTML = newRows.join('');

    while (fragment.firstChild) {
        listEl.insertBefore(fragment.firstChild, listEl.firstChild);
    }
}
