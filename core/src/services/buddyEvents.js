/**
 * Buddy Event Bus — lightweight in-process event emitter.
 * Routes call emit() to broadcast platform events. The supported Nestor v1
 * stream and the temporary legacy Buddy stream both forward this bus.
 */
const EventEmitter = require('events');
const { randomUUID } = require('crypto');

const bus = new EventEmitter();
bus.setMaxListeners(50);
const MAX_REPLAY_EVENTS = 200;
const replayBuffer = [];

// Seed event-type -> intent map (task 0265). Mirrors buddy-state.js
// intentForEvent so server and client agree on classification. Includes the
// benchmark/rag lifecycle types that tasks 0266/0267 emit, so they classify
// correctly even if a caller does not pass an explicit intent.
const BLOCKED_TYPES = new Set([
  'alert_critical', 'host_offline', 'run_blocked', 'preflight_blocked', 'corpus_not_ready',
]);
const WARNING_TYPES = new Set([
  'error', 'alert_warning', 'ingest_failed', 'search_failed', 'preflight_fail',
]);
const WATCHING_TYPES = new Set([
  'thinking', 'message_sent', 'message_received', 'watching',
  'preflight_start', 'judge_start', 'judge_done', 'run_phase',
  'ingest_start', 'ingest_progress',
]);
const IDLE_TYPES = new Set(['idle', 'farewell']);

const VALID_INTENTS = new Set(['idle', 'watching', 'suggesting', 'warning', 'blocked']);
const VALID_SCOPES = new Set(['any', 'core', 'benchmark', 'rag', 'data']);

function classifyIntent(type) {
  if (BLOCKED_TYPES.has(type)) return 'blocked';
  if (WARNING_TYPES.has(type)) return 'warning';
  if (WATCHING_TYPES.has(type)) return 'watching';
  if (IDLE_TYPES.has(type)) return 'idle';
  return 'suggesting';
}

/**
 * Emit a buddy-visible event.
 * @param {string} type - event type (e.g. 'message_received', 'judge_start')
 * @param {string} eventClass - one of: chat, benchmark, infrastructure, data, idle
 * @param {string} summary - human-readable summary for LLM context
 * @param {string} [significance='normal'] - low, normal, or high
 * @param {object} [opts] - { intent, surfaceScope } (task 0265). intent is
 *   validated against the 5 intents (else derived from type); surfaceScope is
 *   validated against the known surfaces (else 'any' = react everywhere).
 */
function emit(type, eventClass, summary, significance, opts) {
  opts = opts || {};
  const intent = VALID_INTENTS.has(opts.intent) ? opts.intent : classifyIntent(type);
  const surfaceScope = VALID_SCOPES.has(opts.surfaceScope) ? opts.surfaceScope : 'any';
  const event = {
    id: `evt_${randomUUID()}`,
    type: String(type || 'unknown').slice(0, 120),
    class: String(eventClass || 'platform').slice(0, 80),
    summary: String(summary || '').slice(0, 500),
    significance: String(significance || 'normal').slice(0, 40),
    intent,
    surfaceScope,
    timestamp: new Date().toISOString(),
  };
  replayBuffer.push(event);
  if (replayBuffer.length > MAX_REPLAY_EVENTS) {
    replayBuffer.splice(0, replayBuffer.length - MAX_REPLAY_EVENTS);
  }
  bus.emit('buddy-event', event);
  return event;
}

function getEventsAfter(cursor, limit = MAX_REPLAY_EVENTS) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || MAX_REPLAY_EVENTS, MAX_REPLAY_EVENTS));
  if (!cursor) {
    return {
      cursorFound: true,
      events: [],
      oldestCursor: replayBuffer[0]?.id || null,
      newestCursor: replayBuffer[replayBuffer.length - 1]?.id || null,
    };
  }
  const index = replayBuffer.findIndex((event) => event.id === cursor);
  return {
    cursorFound: index >= 0,
    events: index >= 0 ? replayBuffer.slice(index + 1, index + 1 + boundedLimit) : [],
    oldestCursor: replayBuffer[0]?.id || null,
    newestCursor: replayBuffer[replayBuffer.length - 1]?.id || null,
  };
}

function _resetReplayForTests() {
  replayBuffer.splice(0, replayBuffer.length);
}

module.exports = {
  bus,
  emit,
  classifyIntent,
  getEventsAfter,
  MAX_REPLAY_EVENTS,
  _resetReplayForTests,
};
