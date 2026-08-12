'use strict';

const ModelProfile = require('../../../models/ModelProfile');
const HostProfile = require('../../../models/HostProfile');
const { normalizeHostUrl } = require('../../helpers/ollamaHostConfig');
const { normalizeModelName } = require('./modelMetadata');
const { modelNameCandidates } = require('../modelContextResolver');

const AUTO_ENABLE_POLICIES = new Set(['on', 'metered']);
const MIN_THINKING_PROBE_COUNT = 4;
const THINKING_PROFILE_VERSION = 2;

function readMapLikeEntry(mapLike, key) {
    if (!mapLike || !key) return null;
    if (mapLike instanceof Map) return mapLike.get(key) || null;
    return mapLike[key] || null;
}

function normalizeThinkMode(value) {
    if (value === true || value === false) return value;
    const raw = value == null || value === '' ? 'auto' : String(value).trim().toLowerCase();
    if (['true', 'on', 'enabled', 'force', 'forced'].includes(raw)) return true;
    if (['false', 'off', 'disabled', 'never'].includes(raw)) return false;
    return 'auto';
}

function shouldEnableProfiledThinking(thinkingProfile) {
    if (!thinkingProfile) return false;
    const policy = thinkingProfile.recommendedPolicy || 'unknown';
    if (!isThinkingProfileCurrent(thinkingProfile)) return false;
    return AUTO_ENABLE_POLICIES.has(policy)
        && thinkingProfile.supported === true
        && thinkingProfile.visibleFinalAnswerOk === true
        && thinkingProfile.thinkingOnlyResponse !== true
        && thinkingProfile.runawayRisk !== true;
}

function isThinkingProfileCurrent(thinkingProfile) {
    if (!thinkingProfile) return false;
    const probeCount = Number(thinkingProfile.probeCount) || 0;
    const profileVersion = Number(thinkingProfile.profileVersion) || 0;
    return probeCount >= MIN_THINKING_PROBE_COUNT
        && profileVersion >= THINKING_PROFILE_VERSION;
}

async function resolveHostId(hostUrl) {
    if (!hostUrl) return null;
    const normalizedHostUrl = normalizeHostUrl(hostUrl);
    const hostDoc = await HostProfile.findOne({ hostUrl: normalizedHostUrl })
        .select('hostId')
        .lean();
    return hostDoc?.hostId || null;
}

async function readThinkingProfile(modelName, hostId) {
    if (!modelName || !hostId) return { profile: null, modelProfileName: null };
    const normalizedModel = normalizeModelName(modelName);
    const profileLookupNames = modelNameCandidates(normalizedModel);
    const profile = await ModelProfile.findOne({ name: { $in: profileLookupNames } })
        .select('name capabilities thinkingProfiles')
        .lean();
    return {
        profile: readMapLikeEntry(profile?.thinkingProfiles, hostId),
        modelProfileName: profile?.name || null
    };
}

async function resolveBenchmarkThinking({ modelName, hostUrl, config = {} } = {}) {
    const mode = normalizeThinkMode(config.think);
    if (mode === false) {
        return {
            think: false,
            mode: 'off',
            source: 'explicit',
            reason: 'execution_config.think explicitly set to false',
            profile: null
        };
    }

    const hostId = await resolveHostId(hostUrl);
    const { profile, modelProfileName } = await readThinkingProfile(modelName, hostId);
    if (mode === true) {
        const policy = profile?.recommendedPolicy || 'missing';
        return {
            think: true,
            mode: 'on',
            source: 'explicit',
            reason: `execution_config.think explicitly set to true; thinking profile policy=${policy}`,
            profile: profile || null,
            hostId,
            modelProfileName
        };
    }

    const enabled = shouldEnableProfiledThinking(profile);
    const policy = profile?.recommendedPolicy || 'missing';
    return {
        think: enabled,
        mode: 'auto',
        source: enabled ? 'profile_auto' : 'profile_auto_off',
        reason: enabled
            ? `thinking profile policy=${policy} permits auto think=true`
            : `thinking profile policy=${policy} does not permit auto think=true`,
        profile: profile || null,
        hostId,
        modelProfileName
    };
}

module.exports = {
    AUTO_ENABLE_POLICIES,
    MIN_THINKING_PROBE_COUNT,
    THINKING_PROFILE_VERSION,
    isThinkingProfileCurrent,
    normalizeThinkMode,
    shouldEnableProfiledThinking,
    resolveBenchmarkThinking
};
