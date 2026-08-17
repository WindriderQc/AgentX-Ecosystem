const { getConfiguredHosts, normalizeHostUrl } = require('../../helpers/ollamaHostConfig');
const { benchmarkFetch } = require('./http');
const { normalizeModelTag: normalizeModelName } = require('../../../../shared/modelNames');

const CACHE_TTL_MS = 30_000;
const TAGS_TIMEOUT_MS = 4_000;

let cachedSnapshot = null;
let cachedAt = 0;

async function fetchHostTags(host) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TAGS_TIMEOUT_MS);
    const url = `${host.url}/api/tags`;

    try {
        const response = await benchmarkFetch(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const payload = await response.json();
        const models = new Set(
            (payload.models || [])
                .map((item) => normalizeModelName(item?.name || item?.model || item))
                .filter(Boolean)
        );

        return {
            name: host.name,
            url: host.url,
            reachable: true,
            models,
            error: null
        };
    } catch (err) {
        return {
            name: host.name,
            url: host.url,
            reachable: false,
            models: new Set(),
            error: err.message
        };
    } finally {
        clearTimeout(timeout);
    }
}

async function getCurrentHostModelSnapshot({ force = false } = {}) {
    const now = Date.now();
    if (!force && cachedSnapshot && now - cachedAt < CACHE_TTL_MS) {
        return cachedSnapshot;
    }

    const configuredHosts = getConfiguredHosts()
        .map((host) => ({
            name: host.name,
            url: normalizeHostUrl(host.url)
        }))
        .filter((host) => host.url);

    const hosts = await Promise.all(configuredHosts.map(fetchHostTags));
    const byHost = new Map(hosts.map((host) => [host.url, host]));
    const allModels = new Set();
    let reachableHostCount = 0;

    for (const host of hosts) {
        if (!host.reachable) continue;
        reachableHostCount += 1;
        for (const model of host.models) allModels.add(model);
    }

    cachedSnapshot = {
        hosts,
        byHost,
        allModels,
        reachableHostCount,
        generatedAt: new Date().toISOString()
    };
    cachedAt = now;
    return cachedSnapshot;
}

function isModelAvailableForRow(row, snapshot) {
    const model = normalizeModelName(row?.model);
    if (!model || !snapshot || snapshot.hosts.length === 0) return true;

    const normalizedHost = normalizeHostUrl(row?.host);
    if (normalizedHost && snapshot.byHost.has(normalizedHost)) {
        const host = snapshot.byHost.get(normalizedHost);
        return host.reachable ? host.models.has(model) : true;
    }

    if (snapshot.reachableHostCount > 0) {
        return snapshot.allModels.has(model);
    }

    return true;
}

function serializeHostModelSnapshot(snapshot) {
    return {
        generated_at: snapshot?.generatedAt || null,
        reachable_host_count: snapshot?.reachableHostCount || 0,
        hosts: (snapshot?.hosts || []).map((host) => ({
            name: host.name,
            url: host.url,
            reachable: host.reachable,
            model_count: host.models.size,
            error: host.error
        }))
    };
}

module.exports = {
    getCurrentHostModelSnapshot,
    isModelAvailableForRow,
    serializeHostModelSnapshot
};
