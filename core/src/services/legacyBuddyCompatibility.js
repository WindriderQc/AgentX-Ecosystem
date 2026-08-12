'use strict';

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled']);

function isLegacyBuddyApiEnabled(env = process.env) {
  const raw = env.AGENTX_ENABLE_LEGACY_BUDDY_API;
  if (raw == null || String(raw).trim() === '') return true;
  return !DISABLED_VALUES.has(String(raw).trim().toLowerCase());
}

module.exports = { isLegacyBuddyApiEnabled };
