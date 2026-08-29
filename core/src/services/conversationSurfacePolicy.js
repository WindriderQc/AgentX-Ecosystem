'use strict';

// Playground is an interactive user surface. Internal probes can retain their
// durable evidence in Mongo without becoming the conversation a person sees
// when the page auto-loads its newest history row.
const INTERNAL_PROBE_TAGS = Object.freeze([
  'agentx:internal-probe',
  'agentx:benchmark-canary'
]);

// New producers should use explicit metadata. This clientRef fallback is
// deliberately namespaced and only applies to source=external records.
const INTERNAL_PROBE_CLIENT_REF = /^(?:benchmark[-/:.]canary|core[-/:.]canary|internal[-/:.]probe)(?:[-/:._]|$)/i;

// Compatibility for the exact probe family observed in legacy history. This
// is anchored so ordinary conversations mentioning benchmarks, canaries, or
// FINAL_CORE_* text remain visible.
const LEGACY_CORE_CANARY = /^\s*Reply exactly FINAL_CORE_[A-Z0-9]+(?:_[A-Z0-9]+)*_OK\s*$/i;

function rawConversation(conversation) {
  return typeof conversation?.toObject === 'function'
    ? conversation.toObject()
    : (conversation || {});
}

function hasExplicitProbeMetadata(conversation) {
  const raw = rawConversation(conversation);
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((tag) => String(tag).trim().toLowerCase())
    : [];
  if (tags.some((tag) => INTERNAL_PROBE_TAGS.includes(tag))) return true;

  return String(raw.source || '').toLowerCase() === 'external'
    && INTERNAL_PROBE_CLIENT_REF.test(String(raw.clientRef || '').trim());
}

function hasLegacyCoreCanarySignature(conversation) {
  const raw = rawConversation(conversation);
  if (LEGACY_CORE_CANARY.test(String(raw.title || ''))) return true;

  return Array.isArray(raw.messages) && raw.messages.some((message) => (
    String(message?.role || '').toLowerCase() === 'user'
      && LEGACY_CORE_CANARY.test(String(message?.content || ''))
  ));
}

function isPlaygroundConversation(conversation) {
  return !hasExplicitProbeMetadata(conversation)
    && !hasLegacyCoreCanarySignature(conversation);
}

function playgroundHistoryFilter() {
  return {
    $nor: [
      { tags: { $in: [...INTERNAL_PROBE_TAGS] } },
      {
        source: 'external',
        clientRef: INTERNAL_PROBE_CLIENT_REF
      },
      { title: LEGACY_CORE_CANARY },
      {
        messages: {
          $elemMatch: {
            role: 'user',
            content: LEGACY_CORE_CANARY
          }
        }
      }
    ]
  };
}

function withPlaygroundHistoryFilter(base = {}) {
  return {
    ...base,
    ...playgroundHistoryFilter()
  };
}

module.exports = {
  INTERNAL_PROBE_TAGS,
  INTERNAL_PROBE_CLIENT_REF,
  LEGACY_CORE_CANARY,
  hasExplicitProbeMetadata,
  hasLegacyCoreCanarySignature,
  isPlaygroundConversation,
  playgroundHistoryFilter,
  withPlaygroundHistoryFilter
};
