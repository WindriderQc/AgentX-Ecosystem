const logger = require('../../config/logger');
const clusterScheduleService = require('../services/clusterScheduleService');
const { getConfiguredHosts } = require('./ollamaHostConfig');

function getConfiguredHostById(hostId) {
  return getConfiguredHosts().find((host) => host.id === hostId) || null;
}

function getConfiguredHostByUrl(hostUrl) {
  return getConfiguredHosts().find((host) => host.url === hostUrl) || null;
}

function buildFallbackResolution({ fallbackHostId, fallbackHostUrl, fallbackReason = 'Static fallback' } = {}) {
  const hostById = fallbackHostId ? getConfiguredHostById(fallbackHostId) : null;
  const hostByUrl = fallbackHostUrl ? getConfiguredHostByUrl(fallbackHostUrl) : null;
  const host = hostById || hostByUrl || null;

  return {
    source: 'fallback',
    hostId: host?.id || fallbackHostId || null,
    hostUrl: host?.url || fallbackHostUrl || null,
    reason: fallbackReason,
    claimId: null,
    claimExpiresAt: null,
    recommendation: null
  };
}

async function resolveAdvisoryHost(options = {}) {
  const {
    model,
    caller = 'unknown',
    durationMs = 30000,
    priority = 'normal',
    createSoftClaim = false,
    claimTtlMs = 30000,
    fallbackHostId = null,
    fallbackHostUrl = null,
    fallbackReason
  } = options;

  const fallback = buildFallbackResolution({ fallbackHostId, fallbackHostUrl, fallbackReason });

  if (!model) {
    return fallback;
  }

  try {
    const recommendation = await clusterScheduleService.recommendHost(model, durationMs, priority);
    if (!recommendation?.hostUrl) {
      if (recommendation?.blockedByBenchmarkClaim) {
        return {
          source: 'scheduler-blocked',
          hostId: null,
          hostUrl: null,
          reason: recommendation.reason || 'All online Ollama hosts are held by active benchmark claims',
          claimId: null,
          claimExpiresAt: null,
          recommendation
        };
      }
      return {
        ...fallback,
        reason: recommendation?.reason || fallback.reason,
        recommendation: recommendation || null
      };
    }

    let claimId = null;
    let claimExpiresAt = null;
    if (createSoftClaim && recommendation.host) {
      const claim = await clusterScheduleService.createClaim(recommendation.host, model, caller, claimTtlMs);
      claimId = claim.claimId;
      claimExpiresAt = claim.expiresAt;
    }

    return {
      source: 'scheduler',
      hostId: recommendation.host,
      hostUrl: recommendation.hostUrl,
      reason: recommendation.reason,
      claimId,
      claimExpiresAt,
      recommendation
    };
  } catch (error) {
    logger.warn('Scheduler advisory lookup failed, using fallback host', {
      caller,
      model,
      error: error.message
    });
    return fallback;
  }
}

module.exports = {
  buildFallbackResolution,
  getConfiguredHostById,
  getConfiguredHostByUrl,
  resolveAdvisoryHost
};
