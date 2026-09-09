'use strict';

// Ollama represents keep_alive=-1 using Go's maximum Duration (about 292
// years). Older releases used year 9999. Both describe permanent residency.
const PERMANENT_EXPIRY_MIN_MS = 100 * 365.25 * 24 * 60 * 60 * 1000;

function isOllamaPermanentExpiry(value, referenceTime = Date.now()) {
  const parsed = value ? new Date(value) : null;
  const reference = referenceTime instanceof Date ? referenceTime.getTime() : Number(referenceTime);
  return Boolean(parsed
    && Number.isFinite(parsed.getTime())
    && Number.isFinite(reference)
    && parsed.getTime() - reference >= PERMANENT_EXPIRY_MIN_MS);
}

module.exports = { isOllamaPermanentExpiry };
