'use strict';

const fs = require('fs').promises;
const path = require('path');
const personalityAdapters = require('./personalityAdapters');
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
  const [agentx, hermes, openclaw] = await Promise.all([
    readAgentxCandidate()
      .then((candidate) => ({ source: 'agentx', available: true, ref: candidate.ref }))
      .catch((error) => ({ source: 'agentx', available: false, error: error.message })),
    personalityAdapters.getHermesPersonalitySourceStatus()
      .then((status) => ({ source: 'hermes', ...status }))
      .catch((error) => ({ source: 'hermes', available: false, error: error.message })),
    personalityAdapters.listOpenclawAgents()
      .then((agents) => ({ source: 'openclaw', available: true, agents }))
      .catch((error) => ({ source: 'openclaw', available: false, agents: [], error: error.message })),
  ]);
  return { sources: { agentx, hermes, openclaw } };
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

  if (normalizedSource === 'agentx') return readAgentxCandidate();
  const normalizedAgentId = String(agentId || '').trim();
  if (normalizedSource === 'openclaw' && !normalizedAgentId) {
    throw new NestorConsumerError('agentId is required for OpenClaw personality resolution', 400, 'AGENT_ID_REQUIRED');
  }
  if (
    normalizedSource === 'openclaw'
    && (
      normalizedAgentId.length > 120
      || normalizedAgentId === '.'
      || normalizedAgentId === '..'
      || normalizedAgentId.includes('\0')
      || /[\\/]/.test(normalizedAgentId)
    )
  ) {
    throw new NestorConsumerError('agentId must be a single safe path segment', 400, 'INVALID_AGENT_ID');
  }

  const resolved = await personalityAdapters.getPersonality({
    source: normalizedSource,
    agentId: normalizedAgentId,
  });
  if (!resolved?.soul) {
    throw new NestorConsumerError('Personality source returned no candidate', 404, 'PERSONALITY_NOT_FOUND');
  }
  const soul = String(resolved.soul);
  return {
    source: normalizedSource,
    ref: resolved.ref || null,
    agentId: resolved.agentId || (normalizedSource === 'openclaw' ? String(agentId).trim() : null),
    agentName: resolved.agentName || null,
    profile: resolved.profile || null,
    sourceDetail: resolved.sourceDetail || null,
    soul: soul.slice(0, LIMITS.personalityCharacters),
    truncated: soul.length > LIMITS.personalityCharacters,
  };
}

module.exports = {
  AGENTX_NESTOR_ROLE,
  resolveAgentxNestorRole,
  getPersonalitySources,
  resolvePersonalityCandidate,
};
