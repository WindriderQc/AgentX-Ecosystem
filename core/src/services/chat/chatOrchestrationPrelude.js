'use strict';
/**
 * Chat Orchestration Prelude
 *
 * Extracted from chatService.js and chatServiceStream.js to eliminate the
 * duplicated orchestration scaffolding that both paths share:
 *   1. Smart model routing (routeRequest) — auto-route + explicit-model branches
 *   2. RAG context assembly (buildRagContext)
 *   3. Web search call + formatting into a synthetic user/context message
 *
 * Both the non-stream and stream chat paths call `prepareChatOrchestration()`
 * with their current inputs. The helper returns a single bundle; each path
 * then proceeds with its own response-accumulation, flushing, and persistence
 * logic — which intentionally stays in each caller.
 *
 * The stream path threads a per-call `onWebSearchStart` / `onWebSearchDone`
 * pair through `options` so the SSE-only side effects remain in the stream
 * caller. The non-stream path simply omits those hooks.
 */

const logger = require('../../../config/logger');
const { routeRequest } = require('../modelRouter');
const { buildRagContext } = require('./ragContextBuilder');
const { searchWeb } = require('../webSearch');
const { getRagServiceClient } = require('../ragServiceClient');

/**
 * Run the shared prelude for a chat request.
 *
 * @param {Object} params
 * @param {string} params.message - User message
 * @param {string} [params.model] - Requested model (may be 'auto' or null)
 * @param {string} [params.target] - Explicit Ollama target (optional)
 * @param {boolean} [params.autoRoute]
 * @param {string|null} [params.taskType]
 * @param {string} [params.caller] - modelRouter caller tag (e.g. 'chat-service' | 'chat-service-stream')
 * @param {string|null} [params.callerDetail] - fine-grained caller identity (e.g. 'chat-<userId>'),
 *   threaded into the RouteDecision so chat telemetry rows are attributed (task 0519)
 * @param {boolean} [params.ragRequested]
 * @param {Object} [params.ragStore]
 * @param {number} [params.ragTopK]
 * @param {Object} [params.ragFilters]
 * @param {Object} [params.ragOptions] - Passed through to buildRagContext
 * @param {boolean} [params.enableWebSearch]
 * @param {Function} [params.onWebSearchStart] - Optional callback fired before searchWeb()
 * @param {Function} [params.onWebSearchDone]  - Optional callback fired after searchWeb() with result count
 *
 * @returns {Promise<{
 *   routingInfo: Object|null,
 *   effectiveModel: string|null,
 *   effectiveTarget: string|null,
 *   ragUsed: boolean,
 *   ragSources: Array,
 *   ragContext: string|null,
 *   webSearchResults: Array,
 *   webSearchContext: string|null
 * }>}
 */
async function prepareChatOrchestration({
    message,
    model,
    target,
    autoRoute = false,
    taskType = null,
    caller = 'chat-service',
    callerDetail = null,
    ragRequested = false,
    ragStore = null,
    ragTopK,
    ragFilters,
    ragOptions,
    enableWebSearch = false,
    onWebSearchStart,
    onWebSearchDone
} = {}) {
    // 1. Smart Model Routing — mirrors the historical two-branch shape so
    //    routing metadata stays identical across both paths.
    let effectiveModel = model;
    let effectiveTarget = target;
    let routingInfo = null;

    if (autoRoute || taskType) {
        routingInfo = await routeRequest(message, {
            autoRoute,
            taskType,
            preferredModel: model && model !== 'auto' ? model : null,
            caller,
            callerDetail
        });
        effectiveModel = routingInfo.model;
        effectiveTarget = routingInfo.target;

        if (routingInfo.routed) {
            logger.info('Request routed', {
                taskType: routingInfo.taskType,
                model: routingInfo.model,
                target: routingInfo.target
            });
        }
    } else if (!effectiveTarget && effectiveModel) {
        routingInfo = await routeRequest(message, {
            preferredModel: effectiveModel,
            caller,
            callerDetail
        });
        effectiveTarget = routingInfo.target;
    }

    // 2. RAG — opt-in; delegate to shared builder, return same shape both paths need.
    let ragUsed = false;
    let ragSources = [];
    let ragContext = null;

    if (ragRequested && message) {
        const store = ragStore || getRagServiceClient();
        const ragResult = await buildRagContext(message, store, {
            effectiveTarget,
            ragTopK,
            ragFilters,
            ragOptions
        });
        ragUsed = ragResult.ragUsed;
        ragSources = ragResult.ragSources;
        ragContext = ragResult.ragContext;
    }

    // 3. Web search — surface callbacks so the stream path can emit SSE events
    //    at the right moment without owning the require('./webSearch') itself.
    let webSearchResults = [];
    let webSearchContext = null;

    if (enableWebSearch && message) {
        try {
            if (typeof onWebSearchStart === 'function') onWebSearchStart();
            const searchResult = await searchWeb(message);
            webSearchResults = searchResult.results || [];
            if (searchResult.formatted) {
                webSearchContext = searchResult.formatted;
            }
            if (typeof onWebSearchDone === 'function') {
                onWebSearchDone(webSearchResults.length);
            }
        } catch (err) {
            logger.warn('Web search failed', { caller, error: err.message });
            if (typeof onWebSearchDone === 'function') onWebSearchDone(0);
        }
    }

    return {
        routingInfo,
        effectiveModel,
        effectiveTarget,
        ragUsed,
        ragSources,
        ragContext,
        webSearchResults,
        webSearchContext
    };
}

module.exports = { prepareChatOrchestration };
