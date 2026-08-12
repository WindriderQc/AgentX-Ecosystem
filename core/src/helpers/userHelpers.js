'use strict';
/**
 * User Helper Functions — stub
 *
 * Auth is stripped from agentx-core. All requests run as 'default' user.
 * getOrCreateProfile returns a minimal in-memory profile object.
 */

const logger = require('../../config/logger');
const profileStore = new Map();

/**
 * Extract userId from response locals with fallback to 'default'
 * @param {Object} res - Express response object
 * @returns {string} userId
 */
function getUserId(res) {
    return res.locals?.user?._id?.toString()
        || res.locals?.user?.userId
        || 'default';
}

/**
 * Get or create user profile — returns minimal stub (no DB)
 * @param {string} userId
 * @returns {Promise<Object>}
 */
async function getOrCreateProfile(userId) {
    const resolvedUserId = userId || 'default';
    if (!profileStore.has(resolvedUserId)) {
        profileStore.set(resolvedUserId, {
            userId: resolvedUserId,
            about: '',
            preferences: {}
        });
    }
    return profileStore.get(resolvedUserId);
}

async function saveProfile(userId, profile = {}) {
    const resolvedUserId = userId || 'default';
    const existing = await getOrCreateProfile(resolvedUserId);
    const nextProfile = {
        ...existing,
        about: typeof profile.about === 'string' ? profile.about : existing.about,
        preferences: {
            ...(existing.preferences || {}),
            ...((profile && typeof profile.preferences === 'object' && profile.preferences) || {})
        }
    };
    profileStore.set(resolvedUserId, nextProfile);
    return nextProfile;
}

module.exports = { getUserId, getOrCreateProfile, saveProfile };
