'use strict';

/**
 * Authoritative judge readiness.
 *
 * A judge is ready only when an operator-controlled selection points at a
 * configured Ollama host, that host answers its inventory endpoint, and the
 * selected model is already installed there. Product defaults and the default
 * chat model are deliberately not treated as judge selections.
 */

const fs = require('fs');
const path = require('path');
const {
    getConfiguredHosts,
    normalizeHostUrl,
    readConfigFile
} = require('../../helpers/ollamaHostConfig');
const { hostUrlKey } = require('../../../../shared/ollamaHostConfig');
const { benchmarkFetch } = require('./http');
const { readBoundedJson } = require('../../helpers/boundedJsonResponse');
const {
    admitOllamaTarget,
    OllamaTargetAdmissionError
} = require('../../helpers/ollamaTargetAdmission');

const DEFAULTS_PATH = process.env.JUDGE_DEFAULTS_PATH
    || path.join(process.cwd(), 'config', 'judge-host-defaults.json');
const DEFAULT_TIMEOUT_MS = 5000;

function normalizeModelName(name) {
    return String(name || '').trim().replace(/:latest$/i, '');
}

function readJudgeDefaults(filePath = DEFAULTS_PATH) {
    try {
        if (!fs.existsSync(filePath)) return {};
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function findHostValue(map, hostUrl) {
    const targetKey = hostUrlKey(hostUrl);
    if (!targetKey) return null;
    for (const [rawHost, value] of Object.entries(map || {})) {
        if (hostUrlKey(rawHost) === targetKey && value) return value;
    }
    return null;
}

function getExplicitGlobalJudgeSelection({ config = readConfigFile(), env = process.env } = {}) {
    const setupModel = normalizeModelName(config?.judge?.model);
    const setupHost = normalizeHostUrl(config?.judge?.host);
    if (setupModel && setupHost) {
        return { host: setupHost, model: setupModel, source: 'setup' };
    }

    // JUDGE_MODEL is the signal that the operator explicitly selected a judge.
    // AGENTX_DEFAULT_CHAT_MODEL and the product fallback are intentionally not
    // judge selections.
    const envModel = normalizeModelName(env.JUDGE_MODEL);
    const envHost = normalizeHostUrl(env.JUDGE_HOST || env.OLLAMA_HOST);
    if (envModel && envHost) {
        return { host: envHost, model: envModel, source: 'environment' };
    }

    return null;
}

function selectedJudgeForHost(host, defaults, globalSelection) {
    const defaultModel = normalizeModelName(findHostValue(defaults, host.url));
    if (defaultModel) {
        return { model: defaultModel, source: 'host-default' };
    }

    if (globalSelection && hostUrlKey(globalSelection.host) === hostUrlKey(host.url)) {
        return { model: globalSelection.model, source: globalSelection.source };
    }

    return { model: null, source: null };
}

async function probeHostInventory(hostUrl, {
    fetchImpl = benchmarkFetch,
    timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
        const response = await fetchImpl(`${hostUrl}/api/tags`, {
            method: 'GET',
            signal: controller.signal,
            redirect: 'manual'
        });
        if (!response.ok) {
            return {
                reachable: false,
                models: [],
                latencyMs: Date.now() - startedAt,
                error: `inventory returned HTTP ${response.status}`
            };
        }

        const payload = await readBoundedJson(response);
        const models = (payload.models || [])
            .map((entry) => ({
                name: normalizeModelName(entry?.name || entry?.model),
                size: Number(entry?.size) || 0,
                details: entry?.details || {}
            }))
            .filter((entry) => entry.name);

        return {
            reachable: true,
            models,
            latencyMs: Date.now() - startedAt,
            error: null
        };
    } catch (error) {
        return {
            reachable: false,
            models: [],
            latencyMs: Date.now() - startedAt,
            error: error?.name === 'AbortError'
                ? `inventory probe timed out after ${timeoutMs}ms`
                : (error?.message || 'inventory probe failed')
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

function hostReason({ reachable, selectedModel, modelAvailable }) {
    if (!reachable) return 'host_unreachable';
    if (!selectedModel) return 'no_judge_selected';
    if (!modelAvailable) return 'selected_model_unavailable';
    return 'ready';
}

function readinessCode(hosts, readyHostCount, selectedHostCount, reachableHostCount) {
    if (readyHostCount > 0) return readyHostCount === hosts.length ? 'ready' : 'partially_ready';
    if (hosts.length === 0) return 'no_hosts_configured';
    if (reachableHostCount === 0) return 'hosts_unreachable';
    if (selectedHostCount === 0) return 'no_judge_selected';
    return 'selected_models_unavailable';
}

function blockerForHost(host) {
    switch (host.reason) {
    case 'no_judge_selected':
        return `${host.hostName}: choose an installed model as judge`;
    case 'host_unreachable':
        return `${host.hostName}: ${host.error || 'host is unreachable'}`;
    case 'selected_model_unavailable':
        return `${host.hostName}: selected judge ${host.selectedModel} is not installed`;
    default:
        return null;
    }
}

function toPublicReadiness(state) {
    return {
        ready: state.ready,
        status: state.status,
        code: state.code,
        checked_at: state.checked_at,
        configured_host_count: state.configured_host_count,
        reachable_host_count: state.reachable_host_count,
        selected_host_count: state.selected_host_count,
        ready_host_count: state.ready_host_count,
        summary: state.summary,
        blockers: state.blockers,
        hosts: state.hosts.map((host) => ({
            hostId: host.hostId,
            hostName: host.hostName,
            hostUrl: host.hostUrl,
            reachable: host.reachable,
            selectedModel: host.selectedModel,
            selectionSource: host.selectionSource,
            modelAvailable: host.modelAvailable,
            ready: host.ready,
            reason: host.reason,
            error: host.error,
            latency_ms: host.latency_ms,
            available_model_count: host.available_model_count
        })),
        preferred_target: state.preferred_target,
        evidence_modes: state.evidence_modes,
        setup: state.setup,
        retry: state.retry
    };
}

async function getJudgeReadiness(options = {}) {
    const hosts = options.hosts || getConfiguredHosts();
    const defaults = options.defaults || readJudgeDefaults(options.defaultsPath);
    const globalSelection = options.globalSelection === undefined
        ? getExplicitGlobalJudgeSelection({ config: options.config, env: options.env })
        : options.globalSelection;

    const inventories = await Promise.all(hosts.map((host) =>
        probeHostInventory(host.url, {
            fetchImpl: options.fetchImpl,
            timeoutMs: options.timeoutMs
        })
    ));

    const hostStates = hosts.map((host, index) => {
        const inventory = inventories[index];
        const selected = selectedJudgeForHost(host, defaults, globalSelection);
        const modelAvailable = !!(selected.model && inventory.models.some(
            (entry) => entry.name === normalizeModelName(selected.model)
        ));
        const ready = !!(selected.model && inventory.reachable && modelAvailable);

        return {
            hostId: host.id || `host-${index + 1}`,
            hostName: host.name || host.url,
            hostUrl: host.url,
            reachable: inventory.reachable,
            selectedModel: selected.model,
            selectionSource: selected.source,
            modelAvailable,
            ready,
            reason: hostReason({
                reachable: inventory.reachable,
                selectedModel: selected.model,
                modelAvailable
            }),
            error: inventory.error,
            latency_ms: inventory.latencyMs,
            available_model_count: inventory.models.length,
            models: inventory.models
        };
    });

    const reachableHostCount = hostStates.filter((host) => host.reachable).length;
    const selectedHostCount = hostStates.filter((host) => !!host.selectedModel).length;
    const readyHosts = hostStates.filter((host) => host.ready);
    const code = readinessCode(hostStates, readyHosts.length, selectedHostCount, reachableHostCount);
    const ready = readyHosts.length > 0;
    const preferred = readyHosts[0] || null;
    const summary = ready
        ? `${readyHosts.length}/${hostStates.length} configured host${hostStates.length === 1 ? '' : 's'} ${readyHosts.length === 1 ? 'has' : 'have'} a selected, reachable judge.`
        : `0/${hostStates.length} configured host${hostStates.length === 1 ? '' : 's'} ${hostStates.length === 1 ? 'has' : 'have'} a selected, reachable judge.`;

    const state = {
        ready,
        status: ready ? (readyHosts.length === hostStates.length ? 'ready' : 'degraded') : 'blocked',
        code,
        checked_at: new Date().toISOString(),
        configured_host_count: hostStates.length,
        reachable_host_count: reachableHostCount,
        selected_host_count: selectedHostCount,
        ready_host_count: readyHosts.length,
        summary,
        blockers: hostStates.map(blockerForHost).filter(Boolean),
        hosts: hostStates,
        preferred_target: preferred
            ? { host: preferred.hostUrl, model: preferred.selectedModel, source: preferred.selectionSource }
            : null,
        evidence_modes: {
            deterministic: {
                status: 'available',
                label: 'Deterministic evidence',
                description: 'Exact, format, reference, and rule-based evidence remains available without a judge.'
            },
            judge_scored: {
                status: ready ? 'available' : 'blocked',
                label: 'Judge-scored evidence',
                description: ready
                    ? 'At least one explicitly selected judge is reachable.'
                    : 'Judge-dependent scoring and retry actions are blocked until an installed model is explicitly selected.'
            }
        },
        setup: {
            href: hostStates.length > 0 ? '#the-bench' : '/setup?focus=judge',
            label: hostStates.length > 0 ? 'Choose a judge' : 'Configure a host and judge',
            description: hostStates.length > 0
                ? 'Select an already-installed model in The Bench. Agent X will not download or choose a model automatically.'
                : 'Connect a host, then explicitly select one of its installed models. Agent X will not download or choose a model automatically.'
        },
        retry: {
            method: 'GET',
            href: '/api/benchmark/judge/readiness?refresh=1',
            label: 'Retry readiness check'
        }
    };

    return options.includeModels ? state : toPublicReadiness(state);
}

async function resolveReadyJudgeTarget(requested = {}, options = {}) {
    const hosts = options.hosts || getConfiguredHosts();
    const hasRequestedHost = typeof requested.host === 'string' && !!requested.host.trim();
    const hasRequestedModel = typeof requested.model === 'string' && !!requested.model.trim();

    // Reject incomplete and malformed caller-selected targets before probing
    // any host. Configuration-owned hosts remain the only discovery surface;
    // request data can select one of them, never introduce a new target.
    if (hasRequestedHost !== hasRequestedModel) {
        return {
            ready: false,
            code: 'incomplete_judge_target',
            error: 'Judge host and model must be selected together.',
            target: null,
            readiness: null
        };
    }

    if ((requested.host !== undefined && requested.host !== null && !hasRequestedHost)
        || (requested.model !== undefined && requested.model !== null && !hasRequestedModel)) {
        return {
            ready: false,
            code: 'invalid_judge_target',
            error: 'Judge host and model must be non-empty strings.',
            target: null,
            readiness: null
        };
    }

    let requestedHost = null;
    if (hasRequestedHost) {
        try {
            requestedHost = admitOllamaTarget(requested.host, {
                configuredHosts: hosts,
                env: options.env || process.env
            });
        } catch (error) {
            return {
                ready: false,
                code: error instanceof OllamaTargetAdmissionError
                    ? 'invalid_judge_target'
                    : 'judge_target_admission_failed',
                error: error?.message || 'Judge target could not be admitted.',
                target: null,
                readiness: null
            };
        }

        const configuredHost = hosts.find(
            (entry) => hostUrlKey(entry.url) === hostUrlKey(requestedHost)
        );
        if (!configuredHost) {
            return {
                ready: false,
                code: 'judge_host_not_configured',
                error: 'The selected judge host is not in the configured host allowlist.',
                target: null,
                readiness: null
            };
        }
        requestedHost = configuredHost.url;
    }

    const requestedModel = normalizeModelName(requested.model);
    const readiness = await getJudgeReadiness({ ...options, hosts, includeModels: true });

    if (!requestedHost && !requestedModel) {
        if (readiness.preferred_target) {
            return {
                ready: true,
                code: 'ready',
                error: null,
                target: readiness.preferred_target,
                readiness: toPublicReadiness(readiness)
            };
        }
        return {
            ready: false,
            code: readiness.code,
            error: 'No selected, reachable judge is ready.',
            target: null,
            readiness: toPublicReadiness(readiness)
        };
    }

    const host = readiness.hosts.find((entry) => hostUrlKey(entry.hostUrl) === hostUrlKey(requestedHost));
    if (!host) {
        return {
            ready: false,
            code: 'judge_host_not_configured',
            error: 'The selected judge host is not in the configured host allowlist.',
            target: null,
            readiness: toPublicReadiness(readiness)
        };
    }

    const modelAvailable = host.models.some((entry) => entry.name === requestedModel);
    if (!host.reachable || !modelAvailable) {
        return {
            ready: false,
            code: host.reachable ? 'judge_model_unavailable' : 'judge_host_unreachable',
            error: host.reachable
                ? `Judge model ${requestedModel} is not installed on ${host.hostName}.`
                : `Judge host ${host.hostName} is unreachable.`,
            target: null,
            readiness: toPublicReadiness(readiness)
        };
    }

    return {
        ready: true,
        code: 'ready',
        error: null,
        target: { host: host.hostUrl, model: requestedModel, source: 'request' },
        readiness: toPublicReadiness(readiness)
    };
}

function judgeUnavailablePayload(check, action = 'Judge-scored action') {
    return {
        status: 'error',
        code: 'JUDGE_NOT_READY',
        error: `${action} unavailable: ${check?.error || 'no selected, reachable judge is ready.'}`,
        readiness: check?.readiness || null,
        setup: check?.readiness?.setup || {
            href: '/setup?focus=judge',
            label: 'Choose a judge'
        }
    };
}

module.exports = {
    getJudgeReadiness,
    resolveReadyJudgeTarget,
    judgeUnavailablePayload,
    normalizeModelName,
    readJudgeDefaults,
    getExplicitGlobalJudgeSelection,
    selectedJudgeForHost,
    probeHostInventory,
    toPublicReadiness
};
