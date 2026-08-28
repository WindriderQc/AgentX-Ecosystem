'use strict';

/**
 * Inference telemetry — the write side of routing observability.
 *
 * Extracted from `modelRouter` in task 0519. Recording what happened is not
 * routing, and keeping it here holds modelRouter inside the service file-size
 * budget while giving the RouteDecision v1 contract a natural home next to it.
 *
 * `modelRouter` re-exports `recordInference` for symbol stability. Existing
 * callers keep working; new code should import from here directly.
 */

const logger = require('../../../config/logger');
const {
    buildRouteDecision,
    fingerprintRuntimeOptions,
    normalizeHostKey,
    normalizeHostOriginUrl,
    normalizeOptionsFingerprint,
    normalizeSelectionSource,
    projectRouteDecision,
} = require('./routeDecision');

/**
 * Last line of defence before a decision is persisted for 30 days.
 *
 * `buildRouteDecision` already guarantees no payload, but callers may hand
 * `recordInference` a hand-assembled object. Dropping the field is strictly
 * better than storing a transcript: losing one row of routing telemetry is
 * recoverable, quietly archiving prompt text is not.
 */
function sanitizedRouteDecision(decision) {
    if (!decision) return null;
    try {
        let configVersion = decision.configVersion;
        if (!configVersion) {
            try {
                configVersion = require('../modelRouterConfig').getRoutingConfigVersion();
            } catch {
                configVersion = 'router-unversioned-v1';
            }
        }
        return projectRouteDecision(decision, {
            configVersion,
            optionsFingerprint: decision.optionsFingerprint || fingerprintRuntimeOptions(null)
        });
    } catch (err) {
        logger.warn('RouteDecision dropped before persistence', { error: err.message, code: err.code });
        return null;
    }
}

function operationalIdentifier(value, max = 200) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length <= max && /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/.test(trimmed)
        ? trimmed
        : null;
}

function parseSafeHttpUrl(value, max = 300) {
    if (typeof value !== 'string' || value.length > max) return null;
    try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
        return parsed;
    } catch {
        return null;
    }
}

function safeOriginUrl(value, max = 300) {
    return typeof value === 'string' && value.length <= max
        ? normalizeHostOriginUrl(value)
        : null;
}

function safeOllamaEndpointUrl(value, max = 300) {
    const parsed = parseSafeHttpUrl(value, max);
    return parsed && ['/api/chat', '/api/generate', '/api/embeddings'].includes(parsed.pathname)
        ? `${parsed.origin}${parsed.pathname}`
        : null;
}

function enumValue(value, allowed) {
    return typeof value === 'string' && allowed.has(value) ? value : null;
}

function safeIsoTimestamp(value) {
    if (typeof value !== 'string') return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function finiteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function booleanOrNull(value) {
    return typeof value === 'boolean' ? value : null;
}

function sanitizeFingerprint(value, rawOptions, fingerprintRawOptions = true) {
    const normalized = normalizeOptionsFingerprint(value);
    if (normalized) return normalized;
    if (fingerprintRawOptions && rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)) {
        return fingerprintRuntimeOptions(rawOptions);
    }
    return null;
}

function sanitizeTarget(value, hostField = 'host') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return {
        model: operationalIdentifier(value.model),
        [hostField]: normalizeHostKey(value[hostField]),
        hostUrl: safeOriginUrl(value.hostUrl),
    };
}

function sanitizeMessageShape(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 6).map((entry) => ({
        index: Math.max(0, Math.round(finiteNumber(entry?.index) ?? 0)),
        role: ['system', 'user', 'assistant', 'tool'].includes(entry?.role)
            ? entry.role
            : 'other',
        chars: Math.max(0, Math.round(finiteNumber(entry?.chars) ?? 0)),
    }));
}

function sanitizeRequestSummary(value, fingerprintRawOptions) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return {
        mode: ['chat', 'generate'].includes(value.mode) ? value.mode : null,
        promptChars: Math.max(0, Math.round(finiteNumber(value.promptChars) ?? 0)),
        systemChars: Math.max(0, Math.round(finiteNumber(value.systemChars) ?? 0)),
        messageCount: Math.max(0, Math.round(finiteNumber(value.messageCount) ?? 0)),
        messageShape: sanitizeMessageShape(value.messageShape),
        optionsFingerprint: sanitizeFingerprint(value.optionsFingerprint, value.options, fingerprintRawOptions),
        stream: booleanOrNull(value.stream),
        thinkConfigured: booleanOrNull(value.thinkConfigured),
        keepAliveConfigured: booleanOrNull(value.keepAliveConfigured),
    };
}

function sanitizeScoredCandidates(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 20).map((entry) => ({
        host: normalizeHostKey(entry?.host),
        name: operationalIdentifier(entry?.name, 100),
        score: finiteNumber(entry?.score),
        reasons: [],
    }));
}

function sanitizeRecommendation(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const scheduler = value.scheduler && typeof value.scheduler === 'object'
        ? {
            host: normalizeHostKey(value.scheduler.host),
            hostUrl: safeOriginUrl(value.scheduler.hostUrl),
            reason: null,
            confidence: enumValue(value.scheduler.confidence, new Set(['none', 'unknown', 'measured', 'low', 'medium', 'high'])),
            warnings: [],
            scored: sanitizeScoredCandidates(value.scheduler.scored || value.scheduler._scored),
            blockedByBenchmarkClaim: booleanOrNull(value.scheduler.blockedByBenchmarkClaim),
        }
        : null;
    return {
        model: operationalIdentifier(value.model),
        host: normalizeHostKey(value.host),
        hostUrl: safeOriginUrl(value.hostUrl),
        source: normalizeSelectionSource(value.source),
        reason: null,
        claimId: operationalIdentifier(value.claimId, 100),
        claimExpiresAt: safeIsoTimestamp(value.claimExpiresAt),
        scheduler,
    };
}

function sanitizeInferenceContract(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const artifact = value.artifact && typeof value.artifact === 'object'
        ? {
            model: operationalIdentifier(value.artifact.model),
            hostId: operationalIdentifier(value.artifact.hostId, 64),
            host: safeOriginUrl(value.artifact.host),
            digest: operationalIdentifier(value.artifact.digest, 128),
            runtimeFingerprint: operationalIdentifier(value.artifact.runtimeFingerprint, 128),
            registryId: operationalIdentifier(value.artifact.registryId, 100),
            registryDigest: operationalIdentifier(value.artifact.registryDigest, 128),
            registryQualified: booleanOrNull(value.artifact.registryQualified),
            identityQualified: booleanOrNull(value.artifact.identityQualified),
            identitySource: enumValue(value.artifact.identitySource, new Set(['core_registry+ollama_tags', 'unresolved'])),
            matchedProfile: operationalIdentifier(value.artifact.matchedProfile, 200),
            hostName: operationalIdentifier(value.artifact.hostName, 100),
        }
        : null;
    const qualification = value.qualification && typeof value.qualification === 'object'
        ? {
            state: enumValue(value.qualification.state, new Set(['available', 'profiled', 'benchmarked', 'qualified', 'unknown'])),
            qualified: booleanOrNull(value.qualification.qualified),
            stale: booleanOrNull(value.qualification.stale),
            exactArtifact: booleanOrNull(value.qualification.exactArtifact),
            source: enumValue(value.qualification.source, new Set(['benchmark_model_profile', 'fallback'])),
        }
        : null;
    return {
        version: value.version === 'agentx.inference-contract.v1' ? value.version : null,
        artifact,
        qualification,
    };
}

/**
 * Preserve the documented routing evidence while refusing every unrecognized
 * field. `routingTrace` predates RouteDecision and was historically free-form;
 * a recursive denylist therefore cannot provide a payload-free contract.
 * Runtime option objects are never retained, only equality fingerprints.
 */
function sanitizeRoutingTrace(trace, { fingerprintRawOptions = true } = {}) {
    if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return null;
    const request = trace.request && typeof trace.request === 'object'
        ? {
            requestedModel: operationalIdentifier(trace.request.requestedModel),
            taskType: operationalIdentifier(trace.request.taskType, 64),
            hostOverride: safeOriginUrl(trace.request.hostOverride),
            callerDetail: null,
            lane: enumValue(trace.request.lane, new Set(['direct', 'interactive', 'automated'])),
            laneRoutesTasks: booleanOrNull(trace.request.laneRoutesTasks),
            crossModelFallbackOptIn: booleanOrNull(trace.request.crossModelFallbackOptIn),
            routeManaged: booleanOrNull(trace.request.routeManaged),
            summary: sanitizeRequestSummary(trace.request.summary, fingerprintRawOptions),
        }
        : null;
    const lane = trace.lane && typeof trace.lane === 'object'
        ? {
            name: enumValue(trace.lane.name, new Set(['direct', 'interactive', 'automated'])),
            route: booleanOrNull(trace.lane.route),
            admit: booleanOrNull(trace.lane.admit),
            recordInferenceSync: booleanOrNull(trace.lane.recordInferenceSync),
            alert: trace.lane.alert === true || trace.lane.alert === false || trace.lane.alert === 'error-only'
                ? trace.lane.alert
                : null,
        }
        : null;
    const selected = trace.selected && typeof trace.selected === 'object'
        ? {
            model: operationalIdentifier(trace.selected.model),
            hostKey: normalizeHostKey(trace.selected.hostKey),
            hostUrl: safeOriginUrl(trace.selected.hostUrl),
            routingSource: normalizeSelectionSource(trace.selected.routingSource),
        }
        : null;
    const artifactResolution = trace.artifactResolution && typeof trace.artifactResolution === 'object'
        ? {
            source: enumValue(trace.artifactResolution.source, new Set([
                'exact_artifact', 'verified_cross_model_fallback', 'verified_degraded_fallback'
            ])),
            requested: operationalIdentifier(trace.artifactResolution.requested),
            resolved: operationalIdentifier(trace.artifactResolution.resolved),
            rewritten: booleanOrNull(trace.artifactResolution.rewritten),
        }
        : null;
    const ollama = trace.ollama && typeof trace.ollama === 'object'
        ? {
            api: ['chat', 'generate'].includes(trace.ollama.api) ? trace.ollama.api : null,
            endpoint: enumValue(trace.ollama.endpoint, new Set(['/api/chat', '/api/generate', '/api/embeddings'])),
            url: safeOllamaEndpointUrl(trace.ollama.url),
            stream: booleanOrNull(trace.ollama.stream),
            thinkConfigured: booleanOrNull(trace.ollama.thinkConfigured),
            keepAliveConfigured: booleanOrNull(trace.ollama.keepAliveConfigured),
            optionsFingerprint: sanitizeFingerprint(
                trace.ollama.optionsFingerprint,
                trace.ollama.options || trace.ollama.runtimeOptions,
                fingerprintRawOptions
            ),
        }
        : null;
    const difference = trace.difference && typeof trace.difference === 'object'
        ? {
            differsFromRecommendation: booleanOrNull(trace.difference.differsFromRecommendation),
            reasons: [],
        }
        : null;

    return {
        version: finiteNumber(trace.version),
        request,
        lane,
        configured: sanitizeTarget(trace.configured),
        recommendation: sanitizeRecommendation(trace.recommendation),
        selected,
        artifactResolution,
        inferenceContract: sanitizeInferenceContract(trace.inferenceContract),
        ollama,
        difference,
        optionsFingerprint: sanitizeFingerprint(
            trace.optionsFingerprint,
            trace.options || trace.runtimeOptions,
            fingerprintRawOptions
        ),
    };
}

function decisionForTelemetry(data = {}) {
    if (data.routeDecision) return sanitizedRouteDecision(data.routeDecision);
    try {
        return sanitizedRouteDecision(buildRouteDecision({
            configVersion: data.configVersion,
            caller: data.caller,
            callerDetail: data.callerDetail,
            consumerContract: data.consumerContract,
            correlationId: data.correlationId,
            workItemId: data.workItemId,
            runtime: data.runtime,
            taskType: data.taskType,
            selectionSource: data.selectionSource || data.routingTrace?.selected?.routingSource,
            requestedPolicy: data.requestedPolicy,
            effectivePolicy: data.effectivePolicy,
            effectiveLane: data.effectiveLane,
            policyDowngraded: data.policyDowngraded,
            outcomeStage: data.outcomeStage,
            outcomeCode: data.outcomeCode,
            outcomeReasonCode: data.outcomeReasonCode,
            selectedModel: data.routedModel || data.model,
            selectedHost: data.routedHost,
            selectedHostUrl: data.routedHostUrl || data.host,
            actualModel: data.model,
            actualHost: data.hostKey || data.routedHost,
            actualHostUrl: data.host || data.routedHostUrl,
            attempt: data.attempt,
            fallbackUsed: data.fallbackUsed,
            fallbackReason: data.fallbackReason,
            degraded: data.degraded,
            degradedReason: data.degradedReason,
            runtimeOptions: data.runtimeOptions,
            classificationMs: data.classificationMs,
            totalMs: data.durationMs
        }));
    } catch (err) {
        logger.warn('RouteDecision could not be synthesized for telemetry', { error: err.message });
        return null;
    }
}

/**
 * Record an inference call to InferenceLog. Fire-and-forget — never throws.
 *
 * Call this AFTER your Ollama fetch completes (success or error).
 *
 * @param {Object} data
 * @param {string}  data.host           - Full Ollama host URL used
 * @param {string}  data.model          - Model name (e.g. 'qwen2.5:7b')
 * @param {'chat'|'benchmark'|'roundtable'|'automation'|'embedding'|'classification'|'unknown'} [data.caller]
 * @param {string}  [data.callerDetail] - Agent ID, task ID, cron name, etc.
 * @param {string}  [data.consumerContract] - Server-attested internal consumer contract
 * @param {string}  [data.runtime]       - agentx | codex | claude-code | external | other
 * @param {string}  [data.correlationId]
 * @param {string}  [data.workItemId]
 * @param {number}  [data.attempt]
 * @param {string}  [data.taskType]     - Routing task type
 * @param {boolean} [data.routed]       - Whether auto-routing was used
 * @param {boolean} [data.fallbackUsed]
 * @param {string}  [data.fallbackReason]
 * @param {Object}  [data.routeDecision] - RouteDecision v1 (task 0519)
 * @param {Object}  [data.observability] - Safe contract/outcome summary; never payload
 * @param {number}  [data.estimatedInputTokensAtDispatch] - Pre-dispatch input estimate; survives upstream failures
 * @param {number}  [data.tokensIn]
 * @param {number}  [data.tokensOut]
 * @param {number}  [data.durationMs]
 * @param {'success'|'error'|'timeout'} [data.status]
 * @param {string}  [data.error]
 */
async function recordInference(data) {
    if (process.env.NODE_ENV === 'test') return; // skip in tests
    const decision = decisionForTelemetry(data);
    let telemetryId = null;
    try {
        const InferenceLog = require('../../../models/InferenceLog');
        const { boundedIdentifier, inferRuntime, positiveAttempt } = require('../../helpers/llmTelemetryContext');
        // Lazy so telemetry does not create a load-time cycle with modelRouter.
        const { resolveHostKey } = require('../modelRouter');
        const host = data.host || data.routedHostUrl || 'unknown';
        const routedHost = data.routedHost || resolveHostKey(data.routedHostUrl || data.host);
        const row = await InferenceLog.create({
            host,
            hostKey: resolveHostKey(host),
            model: data.model || 'unknown',
            caller: data.caller || 'unknown',
            callerDetail: data.callerDetail || null,
            consumerContract: data.consumerContract || null,
            runtime: inferRuntime(data.runtime || data.callerDetail, 'agentx'),
            correlationId: boundedIdentifier(data.correlationId),
            workItemId: boundedIdentifier(data.workItemId),
            attempt: positiveAttempt(data.attempt),
            taskType: data.taskType || null,
            routed: data.routed || false,
            autoRouted: data.autoRouted || false,
            classificationMs: data.classificationMs || 0,
            routedModel: data.routedModel || data.model || null,
            routedHost,
            routedHostUrl: data.routedHostUrl || data.host || null,
            fallbackUsed: data.fallbackUsed || false,
            fallbackReason: data.fallbackReason || null,
            swapped: data.swapped || false,
            routingTrace: sanitizeRoutingTrace(data.routingTrace),
            routeDecision: decision,
            num_ctx: data.num_ctx != null ? data.num_ctx : null,
            num_ctx_source: data.num_ctx_source || null,
            estimatedInputTokensAtDispatch: Number.isFinite(Number(data.estimatedInputTokensAtDispatch))
                ? Math.max(0, Number(data.estimatedInputTokensAtDispatch))
                : null,
            tokensIn: data.tokensIn || 0,
            tokensOut: data.tokensOut || 0,
            durationMs: data.durationMs || 0,
            status: data.status || 'success',
            error: data.error || null,
            timestamp: new Date()
        });
        telemetryId = row?._id?.toString?.() || null;

        // Every persisted row advances windowed inference-rate detectors. The
        // rule engine owns the query and threshold; telemetry emits only the
        // fact that a row completed, so corrected built-ins take effect without
        // duplicating rate policy in every inference route.
        try {
            const alertService = require('../alertService');
            Promise.resolve(alertService.evaluateEvent({
                component: 'platform-inference',
                metric: 'inference_completed',
                source: 'inference-telemetry'
            })).catch(alertError => {
                logger.warn('Inference rate alert dispatch failed (non-fatal)', { error: alertError.message });
            });
        } catch (alertError) {
            logger.warn('Inference rate alert dispatch failed (non-fatal)', { error: alertError.message });
        }
    } catch (_e) {
        // Never break inference because of telemetry failure. Kept at warn
        // (not debug) so silent schema drifts surface promptly — previously
        // the 'proxy' caller value was rejected by the enum for weeks without
        // any user-visible signal.
        logger.warn('InferenceLog write failed (non-fatal)', { error: _e.message, name: _e.name });
    }

    // 0465: the telemetry funnel is also the single observation seam for all
    // inference paths. Callers pass only a safe contract/outcome summary —
    // never prompt, completion, or thinking text. Alerting remains best-effort
    // and cannot make an inference fail.
    if (data.observability && typeof data.observability === 'object') {
        try {
            const { observeInference } = require('../laneObservabilityService');
            void observeInference({
                ...data.observability,
                telemetryId,
                host: data.host || data.routedHostUrl || null,
                hostKey: data.routedHost || null,
                model: data.model || null,
                caller: data.caller || null,
                taskType: data.taskType || null,
                workItemId: data.workItemId || null,
                correlationId: data.correlationId || null,
                routeDecision: decision,
                durationMs: data.durationMs || 0,
                status: data.status || 'success',
            });
        } catch (_e) {
            logger.warn('Lane observation dispatch failed (non-fatal)', { error: _e.message });
        }
    }
}

module.exports = {
    recordInference,
    decisionForTelemetry,
    sanitizedRouteDecision,
    sanitizeRoutingTrace,
};
