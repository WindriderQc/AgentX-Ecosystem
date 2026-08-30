/**
 * Scoring Profile Service
 * =======================
 * Manages user-configurable scoring parameters with MongoDB persistence.
 *
 * Exports:
 *   getScoringProfile()               — returns merged (overrides + defaults)
 *   updateScoringProfile(overrides)   — validates and stores overrides
 *   resetScoringProfile()             — removes overrides, reverts to defaults
 *   getDefaultScoringProfile()        — returns compiled defaults (no DB read)
 *
 * Cache: 60-second in-memory TTL to avoid per-score-calculation DB reads.
 * Cache is invalidated immediately on update or reset.
 */

const mongoose = require('mongoose');
const logger = require('../../../config/logger');
const { GENERALIST_CATEGORY_WEIGHTS } = require('../../../config/categories');

const COLLECTION = 'benchmarkscoringprofiles';
const CACHE_TTL_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Default profile — compiled from hardcoded constants
// ---------------------------------------------------------------------------

function buildDefaultProfile() {
    const categoryWeights = { ...GENERALIST_CATEGORY_WEIGHTS };

    return {
        categoryWeights,
        generalist: {
            coveragePenaltyMax: 20,
            difficultyPenaltyMax: 20,
            fullScopeMinLevel: 4,
            requiredPromptLevels: [4, 5],
            minFullScopeResults: 28,
            minConsistencyResults: 42,
            evidenceConfidenceTarget: 0.75,
            evidenceConfidencePenaltyMax: 8,
            consistencyBonus: 5,
            consistencyStddevThreshold: 15,
            minQualityForBonus: 10,
            emptyResponseFilterThreshold: 0.5,
            // When true, each category's avg quality is multiplied by its
            // avg judge_confidence before being weighted into the composite.
            // Trusted cohort selection rejects rows whose confidence is
            // unknown; exploratory scoring keeps unknown distinct from 0%.
            confidenceWeighting: false
        }
    };
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

let _cache = null;
let _cacheExpiresAt = 0;

function invalidateCache() {
    _cache = null;
    _cacheExpiresAt = 0;
}

function getCached() {
    if (_cache && Date.now() < _cacheExpiresAt) return _cache;
    return null;
}

function setCache(profile) {
    _cache = profile;
    _cacheExpiresAt = Date.now() + CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// MongoDB helper (raw collection access — no schema needed for single-doc store)
// ---------------------------------------------------------------------------

async function getCollection() {
    const db = mongoose.connection.db;
    if (!db) throw new Error('MongoDB not connected');
    return db.collection(COLLECTION);
}

async function loadOverrides() {
    try {
        const col = await getCollection();
        const doc = await col.findOne({ _type: 'scoring_profile' });
        return doc ? doc.overrides : null;
    } catch (err) {
        logger.warn('scoringProfile: failed to load overrides from DB', { error: err.message });
        return null;
    }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const WEIGHT_TOL = 0.001;

function validateWeightMap(obj, label) {
    if (!obj || typeof obj !== 'object') return null;
    const entries = Object.entries(obj);
    if (entries.length === 0) return null;
    const sum = entries.reduce((s, [, v]) => s + (Number(v) || 0), 0);
    if (Math.abs(sum - 1.0) > WEIGHT_TOL) {
        return `${label} weights sum to ${sum.toFixed(4)}, expected 1.0`;
    }
    return null;
}

function validateProfile(overrides) {
    const errors = [];

    if (overrides.categoryWeights) {
        const err = validateWeightMap(overrides.categoryWeights, 'categoryWeights');
        if (err) errors.push(err);
    }

    if (overrides.generalist) {
        const g = overrides.generalist;
        if (g.emptyResponseFilterThreshold !== undefined) {
            const v = Number(g.emptyResponseFilterThreshold);
            if (!Number.isFinite(v) || v < 0 || v > 1) {
                errors.push('generalist.emptyResponseFilterThreshold must be between 0 and 1');
            }
        }
        if (g.coveragePenaltyMax !== undefined) {
            const v = Number(g.coveragePenaltyMax);
            if (!Number.isFinite(v) || v < 0 || v > 100) {
                errors.push('generalist.coveragePenaltyMax must be between 0 and 100');
            }
        }
        if (g.difficultyPenaltyMax !== undefined) {
            const v = Number(g.difficultyPenaltyMax);
            if (!Number.isFinite(v) || v < 0 || v > 100) {
                errors.push('generalist.difficultyPenaltyMax must be between 0 and 100');
            }
        }
        if (g.fullScopeMinLevel !== undefined) {
            const v = Number(g.fullScopeMinLevel);
            if (!Number.isFinite(v) || v < 1 || v > 5) {
                errors.push('generalist.fullScopeMinLevel must be between 1 and 5');
            }
        }
        if (g.requiredPromptLevels !== undefined) {
            if (!Array.isArray(g.requiredPromptLevels)
                || g.requiredPromptLevels.length === 0
                || g.requiredPromptLevels.some((level) => {
                    const v = Number(level);
                    return !Number.isFinite(v) || v < 1 || v > 5;
                })) {
                errors.push('generalist.requiredPromptLevels must be a non-empty array of levels 1-5');
            }
        }
        if (g.minFullScopeResults !== undefined) {
            const v = Number(g.minFullScopeResults);
            if (!Number.isFinite(v) || v < 0 || v > 1000) {
                errors.push('generalist.minFullScopeResults must be between 0 and 1000');
            }
        }
        if (g.minConsistencyResults !== undefined) {
            const v = Number(g.minConsistencyResults);
            if (!Number.isFinite(v) || v < 0 || v > 1000) {
                errors.push('generalist.minConsistencyResults must be between 0 and 1000');
            }
        }
        if (g.evidenceConfidenceTarget !== undefined) {
            const v = Number(g.evidenceConfidenceTarget);
            if (!Number.isFinite(v) || v < 0 || v > 1) {
                errors.push('generalist.evidenceConfidenceTarget must be between 0 and 1');
            }
        }
        if (g.evidenceConfidencePenaltyMax !== undefined) {
            const v = Number(g.evidenceConfidencePenaltyMax);
            if (!Number.isFinite(v) || v < 0 || v > 100) {
                errors.push('generalist.evidenceConfidencePenaltyMax must be between 0 and 100');
            }
        }
        if (g.confidenceWeighting !== undefined && typeof g.confidenceWeighting !== 'boolean') {
            errors.push('generalist.confidenceWeighting must be a boolean');
        }
    }

    return errors;
}

// ---------------------------------------------------------------------------
// Deep merge: only overrides non-null leaf values from src into dst
// ---------------------------------------------------------------------------

function deepMerge(dst, src) {
    if (!src || typeof src !== 'object') return dst;
    const result = { ...dst };
    for (const [k, v] of Object.entries(src)) {
        if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof dst[k] === 'object') {
            result[k] = deepMerge(dst[k], v);
        } else if (v !== null && v !== undefined) {
            result[k] = v;
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function getDefaultScoringProfile() {
    return buildDefaultProfile();
}

async function getScoringProfile() {
    const cached = getCached();
    if (cached) return cached;

    const defaults = buildDefaultProfile();
    const overrides = await loadOverrides();

    const profile = overrides ? deepMerge(defaults, overrides) : defaults;
    setCache(profile);
    return profile;
}

async function updateScoringProfile(overrides) {
    if (!overrides || typeof overrides !== 'object') {
        throw new Error('overrides must be a non-null object');
    }

    const errors = validateProfile(overrides);
    if (errors.length > 0) {
        throw new Error(`Validation failed: ${errors.join('; ')}`);
    }

    const col = await getCollection();
    await col.updateOne(
        { _type: 'scoring_profile' },
        { $set: { _type: 'scoring_profile', overrides, updated_at: new Date() } },
        { upsert: true }
    );

    invalidateCache();
    logger.info('Scoring profile updated', { keys: Object.keys(overrides) });

    return getScoringProfile();
}

async function resetScoringProfile() {
    const col = await getCollection();
    await col.deleteOne({ _type: 'scoring_profile' });
    invalidateCache();
    logger.info('Scoring profile reset to defaults');
    return buildDefaultProfile();
}

module.exports = {
    getDefaultScoringProfile,
    getScoringProfile,
    updateScoringProfile,
    resetScoringProfile,
    invalidateScoringProfileCache: invalidateCache
};
