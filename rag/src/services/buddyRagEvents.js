/**
 * Buddy RAG surface events (task 0267).
 *
 * A focused, throttled set of structured lifecycle emitters that make Buddy a
 * real ingest/search/corpus-readiness guide on the RAG surface. Every emit
 * carries an explicit `intent` (per the Buddy product plan § 3 state model) and
 * `surfaceScope: 'rag'`, so Core's bus can route + present them correctly.
 *
 * CONTRACT (buddy-product-plan.md § 6, RAG row): Buddy must **never** block
 * ingest, search, or delete. Every function here is fire-and-forget:
 *   - The underlying client (`buddyEventClient.emitBuddyEvent`) already swallows
 *     the async fetch rejection (the bus being slow or down).
 *   - Each emitter additionally wraps the call in try/catch so even a
 *     *synchronous* throw (a programming error, or a throwing mock in tests)
 *     can never bubble into the ingest/search/delete code path.
 *
 * In Docker, RAG publishes through Core's generic `/api/platform-events`
 * ingress with the product-owned `AGENTX_PLATFORM_EVENT_TOKEN` shared secret.
 */

const { emitBuddyEvent } = require('../clients/buddyEventClient');

const SURFACE_SCOPE = 'rag';

/**
 * Canonical RAG event type -> Buddy intent mapping (task 0267 spec).
 * Intents come from buddy-product-plan.md § 3 (Axis A).
 */
const INTENT_BY_TYPE = Object.freeze({
  corpus_not_ready: 'warning',
  index_ready: 'suggesting',
  ingest_start: 'watching',
  ingest_progress: 'watching',
  ingest_done: 'suggesting',
  ingest_failed: 'warning',
  search_empty: 'suggesting',
  search_failed: 'warning',
});

/**
 * Default event-bus significance per intent. `warning` rides at `high` so the
 * bus/widget can prioritize it; everything else is `normal`.
 */
function significanceFor(intent) {
  return intent === 'warning' ? 'high' : 'normal';
}

/**
 * Core fire-and-forget emit. Never throws: a down/slow bus (async, swallowed by
 * the client) and a synchronous throw (caught here) both no-op so the calling
 * ingest/search/delete flow is unaffected.
 *
 * @param {string} type      Canonical RAG event type (key of INTENT_BY_TYPE).
 * @param {string} summary   Human-readable one-line summary.
 * @param {object} [opts]
 * @param {string} [opts.eventClass='data']  Event class for the bus.
 * @param {string} [opts.significance]        Override the intent-derived significance.
 */
function emit(type, summary, opts = {}) {
  try {
    const intent = INTENT_BY_TYPE[type];
    if (!intent) {
      // Unknown type: refuse to emit an unmapped intent rather than guess.
      return;
    }
    const eventClass = opts.eventClass || 'data';
    const significance = opts.significance || significanceFor(intent);
    emitBuddyEvent(type, eventClass, summary, significance, {
      intent,
      surfaceScope: SURFACE_SCOPE,
    });
  } catch (_err) {
    // Buddy is best-effort observability. Swallow everything — a thrown emit
    // must never break ingest/search/delete.
  }
}

// ── Corpus readiness ─────────────────────────────────────

function corpusNotReady(summary = 'RAG corpus is not ready') {
  emit('corpus_not_ready', summary);
}

function indexReady(summary = 'RAG index is ready') {
  emit('index_ready', summary);
}

// ── Ingest lifecycle ─────────────────────────────────────

function ingestStart(summary = 'RAG ingest started') {
  emit('ingest_start', summary);
}

function ingestDone(summary = 'RAG ingest done') {
  emit('ingest_done', summary);
}

function ingestFailed(summary = 'RAG ingest failed') {
  emit('ingest_failed', summary);
}

// ── Ingest progress (throttled) ──────────────────────────

const PROGRESS_THROTTLE_MS = Number(process.env.AGENTX_RAG_EVENT_THROTTLE_MS) || 3000;

/** Per-job last-emit timestamps so a 5000-file scan does not spam the bus. */
const lastProgressEmitAt = new Map();

/**
 * Throttled ingest-progress emit. At most one emit per `PROGRESS_THROTTLE_MS`
 * per `key` (the job id), except the terminal progress tick (processed >= total)
 * which always emits so the widget lands on the final count. Never throws.
 *
 * @param {string} key                 Throttle bucket (e.g. the scan job id).
 * @param {{processed?:number,total?:number,errors?:number}} progress
 */
function ingestProgress(key, progress = {}) {
  try {
    const processed = Number(progress.processed) || 0;
    const total = Number(progress.total) || 0;
    const errors = Number(progress.errors) || 0;
    const bucket = key || 'default';
    const now = Date.now();
    const last = lastProgressEmitAt.get(bucket) || 0;
    const isTerminal = total > 0 && processed >= total;

    if (!isTerminal && now - last < PROGRESS_THROTTLE_MS) {
      return; // throttled
    }
    lastProgressEmitAt.set(bucket, now);

    if (isTerminal) {
      lastProgressEmitAt.delete(bucket); // free the bucket once the job lands
    }

    const summary = total > 0
      ? `RAG ingest progress: ${processed}/${total}${errors ? ` (${errors} errors)` : ''}`
      : `RAG ingest progress: ${processed} processed${errors ? ` (${errors} errors)` : ''}`;

    emit('ingest_progress', summary);
  } catch (_err) {
    // Swallow — progress emits are best-effort and must not block ingest.
  }
}

/** Forget a throttle bucket (call when a job ends/cancels). Never throws. */
function clearProgress(key) {
  try {
    lastProgressEmitAt.delete(key || 'default');
  } catch (_err) {
    /* no-op */
  }
}

// ── Search lifecycle ─────────────────────────────────────

function searchEmpty(summary = 'RAG search returned no matches') {
  emit('search_empty', summary);
}

function searchFailed(summary = 'RAG search failed') {
  emit('search_failed', summary);
}

module.exports = {
  INTENT_BY_TYPE,
  SURFACE_SCOPE,
  PROGRESS_THROTTLE_MS,
  emit,
  corpusNotReady,
  indexReady,
  ingestStart,
  ingestDone,
  ingestFailed,
  ingestProgress,
  clearProgress,
  searchEmpty,
  searchFailed,
};
