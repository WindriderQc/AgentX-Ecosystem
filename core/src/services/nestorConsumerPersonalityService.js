'use strict';

const fs = require('fs').promises;
const path = require('path');
const {
  PERSONALITY_SOURCES,
  LIMITS,
  NestorConsumerError,
} = require('./nestorConsumerContract');

function resolveAgentxNestorRole(env = process.env) {
  if (String(env.AGENTX_NESTOR_ROLE || '').trim()) {
    return path.resolve(String(env.AGENTX_NESTOR_ROLE).trim());
  }
  if (String(env.AGENTX_REPO_ROOT || '').trim()) {
    return path.resolve(String(env.AGENTX_REPO_ROOT).trim(), 'roles', 'Nestor.md');
  }
  return path.resolve(__dirname, '..', '..', '..', 'roles', 'Nestor.md');
}

const AGENTX_NESTOR_ROLE = resolveAgentxNestorRole();

async function readAgentxCandidate() {
  const soul = await fs.readFile(resolveAgentxNestorRole(), 'utf8');
  return {
    source: 'agentx',
    ref: 'agentx:roles/Nestor.md',
    soul: soul.slice(0, LIMITS.personalityCharacters),
    truncated: soul.length > LIMITS.personalityCharacters,
  };
}

async function getPersonalitySources() {
  const agentx = await readAgentxCandidate()
    .then((candidate) => ({ source: 'agentx', available: true, ref: candidate.ref }))
    .catch((error) => ({ source: 'agentx', available: false, error: error.message }));
  return { sources: { agentx } };
}

async function resolvePersonalityCandidate({ source, agentId } = {}) {
  const normalizedSource = String(source || '').trim().toLowerCase();
  if (!PERSONALITY_SOURCES.includes(normalizedSource)) {
    throw new NestorConsumerError(
      `Unknown personality source: ${normalizedSource || '(empty)'}`,
      400,
      'UNKNOWN_PERSONALITY_SOURCE'
    );
  }

  return readAgentxCandidate();
}

module.exports = {
  AGENTX_NESTOR_ROLE,
  resolveAgentxNestorRole,
  getPersonalitySources,
  resolvePersonalityCandidate,
};
