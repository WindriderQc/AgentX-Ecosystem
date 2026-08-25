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
const { assertNoPayload, fingerprintRuntimeOptions } = require('./routeDecision');

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
        assertNoPayload(decision);
        let configVersion = decision.configVersion;
        if (!configVersion) {
            try {
                configVersion = require('../modelRouterConfig').getRoutingConfigVersion();
            } catch {
                configVersion = 'router-unversioned-v1';
            }
        }
        const enriched = {
            ...decision,
            configVersion,
            optionsFingerprint: decision.optionsFingerprint || fingerprintRuntimeOptions(null)
        };
        assertNoPayload(enriched);
        return enriched;
    } catch (err) {
        logger.warn('RouteDecision dropped before persistence', { error: err.message, code: err.code });
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
 * @param {number}  [data.tokensIn]
 * @param {number}  [data.tokensOut]
 * @param {number}  [data.durationMs]
 * @param {'success'|'error'|'timeout'} [data.status]
 * @param {string}  [data.error]
 */
async function recordInference(data) {
    if (process.env.NODE_ENV === 'test') return; // skip in tests
    const decision = sanitizedRouteDecision(data.routeDecision);
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
            routingTrace: data.routingTrace || null,
            routeDecision: decision,
            num_ctx: data.num_ctx != null ? data.num_ctx : null,
            num_ctx_source: data.num_ctx_source || null,
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
    sanitizedRouteDecision,
};
