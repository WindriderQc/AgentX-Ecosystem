// memoryReview/contentGuard.js — the authoritative server-side content guard.
//
// Extends (never replaces) the nestor-memory SECRET_PATTERNS so there is one
// base set: nestorMemoryService exports it, tools/agent-memory mirrors it, and
// scripts/memory_review/sanitizer.py carries the same extended list for
// collector-side defense in depth. The guard runs at three points:
//   1. observation submission (before anything persists),
//   2. candidate submission (after model synthesis),
//   3. apply time (again, immediately before any write).

const { SECRET_PATTERNS: BASE_SECRET_PATTERNS } = require('../nestorMemoryService');
const { MemoryReviewError } = require('./policy');

const EXTENDED_SECRET_PATTERNS = [
  ...BASE_SECRET_PATTERNS,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\bauthorization\s*[:=]\s*(?:[A-Za-z][A-Za-z0-9-]*\s+)?\S{8,}/i,
  /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqps?|https?):\/\/[^/\s:@]+:[^@\s]+@/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/,
  /\b(access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{8,}/i,
];

const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+|any\s+|your\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|context|prompts)/i,
  /disregard\s+(?:the\s+)?(?:system|previous|prior)\s+(?:prompt|instructions|rules)/i,
  /\bnew\s+system\s+prompt\b/i,
  /\byou\s+are\s+now\s+(?:the\s+)?(?:system|admin|root|developer|dan)\b/i,
  /\breveal\s+(?:your\s+)?(?:system\s+prompt|instructions|secrets?|api\s+keys?|credentials)/i,
  /<\/?\s*system\s*>/i,
  /\bcurl\b[^\n]{0,120}\|\s*(?:ba)?sh\b/i,
];

// Zero-width / bidi control characters - reject rather than sanitize here:
// by the time content reaches Core it should already be clean.
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function findSecret(text) {
  const value = String(text || '');
  for (const pattern of EXTENDED_SECRET_PATTERNS) {
    if (pattern.test(value)) return pattern;
  }
  return null;
}

function findInjection(text) {
  const value = String(text || '');
  for (const pattern of INJECTION_PATTERNS) {
    const match = value.match(pattern);
    if (match) return match[0].slice(0, 60);
  }
  return null;
}

function redact(text) {
  let value = String(text || '');
  for (const pattern of EXTENDED_SECRET_PATTERNS) {
    value = value.replace(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`), '[REDACTED]');
  }
  return value;
}

/**
 * Throws MemoryReviewError when `text` must not be persisted. `where` names
 * the surface for the error message; the offending value itself is never
 * echoed back (log redaction by construction).
 */
function assertReviewSafe(text, where) {
  const value = String(text || '');
  if (findSecret(value)) {
    throw new MemoryReviewError(`${where} contains secret-like content; refused`, {
      code: 'MEMORY_REVIEW_SECRET_REFUSED',
    });
  }
  if (findInjection(value)) {
    throw new MemoryReviewError(`${where} contains instruction-override content; refused`, {
      code: 'MEMORY_REVIEW_INJECTION_REFUSED',
    });
  }
  if (INVISIBLE_RE.test(value) || CONTROL_RE.test(value)) {
    throw new MemoryReviewError(`${where} contains invisible/control characters; refused`, {
      code: 'MEMORY_REVIEW_INVISIBLE_REFUSED',
    });
  }
}

module.exports = {
  EXTENDED_SECRET_PATTERNS,
  INJECTION_PATTERNS,
  findSecret,
  findInjection,
  redact,
  assertReviewSafe,
};
