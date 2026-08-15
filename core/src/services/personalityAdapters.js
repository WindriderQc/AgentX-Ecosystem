'use strict';

const BOOTSTRAP_SOUL = 'You are the buddy companion of the AgentX platform — you watch conversations, benchmarks, and model activity without running them.';

async function getPersonality(options = {}) {
  const source = String(options.source || 'standalone').trim().toLowerCase();
  if (!['standalone', 'agentx'].includes(source)) {
    throw new Error(`unknown personality source: ${source}`);
  }

  const soul = typeof options.soulFallback === 'string' ? options.soulFallback.trim() : '';
  if (!soul) return null;
  return {
    soul,
    ref: source === 'agentx' ? 'agentx:buddy.soul' : null,
  };
}

async function bootstrapSoul() {
  return BOOTSTRAP_SOUL;
}

module.exports = {
  BOOTSTRAP_SOUL,
  getPersonality,
  bootstrapSoul,
};
