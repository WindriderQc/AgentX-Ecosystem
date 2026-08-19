/**
 * Model Digest Service
 * ====================
 *
 * Best-effort Ollama model digest lookup. Tags are mutable, so benchmark rows
 * need the digest from /api/tags to distinguish re-pulled weights over time.
 */

const logger = require('../../../config/logger');
const { listModels } = require('../../clients/ollamaClient');
const { normalizeModelTag: normalizeModelName } = require('../../../../shared/modelNames');

const CACHE_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 3_000;
const hostCache = new Map();

function namesEquivalent(a, b) {
    const left = normalizeModelName(a);
    const right = normalizeModelName(b);
    if (!left || !right) return false;
    return left.replace(/:latest$/i, '').toLowerCase()
        === right.replace(/:latest$/i, '').toLowerCase();
}

async function loadHostTags(host, { refresh = false } = {}) {
    const cached = hostCache.get(host);
    const now = Date.now();
    if (!refresh && cached && cached.expiresAt > now) {
        return cached.models;
    }

    try {
        const data = await listModels(host, { timeoutMs: LOOKUP_TIMEOUT_MS });
        const models = Array.isArray(data?.models) ? data.models : [];
        hostCache.set(host, { models, expiresAt: now + CACHE_TTL_MS });
        return models;
    } catch (error) {
        logger.debug('Model digest lookup failed', { host, error: error.message });
        hostCache.set(host, { models: null, expiresAt: now + CACHE_TTL_MS });
        return null;
    }
}

async function getModelDigest(host, model, options = {}) {
    if (!host || !model) return null;
    const models = await loadHostTags(host, options);
    if (!Array.isArray(models)) return null;
    const found = models.find((entry) =>
        namesEquivalent(entry.name, model) || namesEquivalent(entry.model, model)
    );
    return found?.digest || null;
}

function clearModelDigestCache() {
    hostCache.clear();
}

module.exports = {
    getModelDigest,
    clearModelDigestCache,
    _internal: {
        normalizeModelName,
        namesEquivalent,
        loadHostTags
    }
};
