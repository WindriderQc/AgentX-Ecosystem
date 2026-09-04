/**
 * Judge Model Validator
 * Pre-batch validation: checks judge model availability and structured output capability
 */

const logger = require('../../../config/logger');
const { benchmarkFetch: fetch } = require('./http');
const { generateWithWorkloadAdmission } = require('../../clients/coreApiClient');

const VALIDATION_TIMEOUT_MS = 30000;

function combinedSignal(timeoutSignal, externalSignal) {
    if (!externalSignal) return timeoutSignal;
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeoutSignal, externalSignal]);
    const controller = new AbortController();
    const forward = signal => controller.abort(signal.reason);
    for (const signal of [timeoutSignal, externalSignal]) {
        if (signal.aborted) forward(signal);
        else signal.addEventListener('abort', () => forward(signal), { once: true });
    }

    return controller.signal;
}

function throwIfExternalAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    const error = new Error('Judge validation workload authority stopped');
    error.code = 'BENCHMARK_CLAIM_STOPPED';
    throw error;
}

/**
 * Validate that a judge model is available and can produce structured JSON output.
 *
 * Step 1 (hard): model must exist on the host — fail if not found.
 * Step 2 (soft): test generation for JSON output — timeout is treated as valid
 *   (cold-loading a large model can exceed the timeout; the benchmark warmup
 *   phase handles that separately).
 *
 * @param {string} host - Ollama host URL (e.g. http://localhost:11434)
 * @param {string} model - Model name to validate
 * @param {Object} [options] - Options
 * @param {Function} [options._fetch] - Override fetch for testing
 * @returns {Promise<{valid: boolean, error?: string, warning?: string, available_models?: string[], latency_ms?: number}>}
 */
async function validateJudgeModel(host, model, options = {}) {
    const _fetch = options._fetch || fetch;
    const start = Date.now();
    throwIfExternalAborted(options.signal);

    if (!host || !model) {
        return {
            valid: false,
            code: 'JUDGE_TARGET_INCOMPLETE',
            error: 'host and model are required'
        };
    }

    // Step 1 (HARD): Check model exists in host's model list.
    let availableModels = [];
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        let res;

        try {
            res = await _fetch(`${host}/api/tags`, {
                method: 'GET',
                signal: combinedSignal(controller.signal, options.signal),
                redirect: 'manual'
            });
        } finally {
            clearTimeout(timeoutId);
        }

        if (!res.ok) {
            return {
                valid: false,
                code: 'JUDGE_HOST_UNAVAILABLE',
                error: `Failed to list models on judge host: HTTP ${res.status}`,
                latency_ms: Date.now() - start
            };
        }

        const data = await res.json();
        availableModels = (data.models || []).map(m => m.name);

        const found = availableModels.some(name => name === model);

        if (!found) {
            return {
                valid: false,
                code: 'JUDGE_MODEL_UNAVAILABLE',
                error: `Judge model "${model}" not found on judge host ${host}`,
                available_models: availableModels,
                latency_ms: Date.now() - start
            };
        }
    } catch (err) {
        throwIfExternalAborted(options.signal);
        const msg = err.name === 'AbortError' ? 'Host unreachable (timeout)' : err.message;
        return {
            valid: false,
            code: 'JUDGE_HOST_UNREACHABLE',
            error: `Cannot connect to judge host ${host}: ${msg}`,
            latency_ms: Date.now() - start
        };
    }

    if (options.metadataOnly === true || !options.signal?.workloadId) {
        return {
            valid: true,
            warning: 'Generation smoke-test deferred until an exact workload admission is active.',
            available_models: availableModels,
            latency_ms: Date.now() - start,
            generation_deferred: true
        };
    }

    // Step 2 (SOFT): Verify model can produce a response. This is a connectivity
    // smoke-test only — if the host is busy, VRAM-constrained, or the model is
    // cold-loading, errors here should NOT block batch start. The benchmark warmup
    // phase handles cold starts and actual capability verification.
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
        let res;

        const testPrompt = 'Rate this response on a scale of 0-10. Respond ONLY with JSON: {"score": 5, "reason": "test"}';
        try {
            const generated = await (options._generate || generateWithWorkloadAdmission)(
                options.signal.workloadId,
                {
                    host,
                    model,
                    messages: [{ role: 'user', content: testPrompt }],
                    stream: false,
                    rawResponse: true,
                    callerDetail: 'benchmark-judge-validation',
                    think: false,
                    options: { num_predict: 100, temperature: 0.1 }
                },
                { signal: combinedSignal(controller.signal, options.signal) }
            );
            res = {
                ok: generated?.status === 'success' || generated?.data != null,
                status: generated?.statusCode || 200,
                json: async () => generated?.data || generated
            };
        } finally {
            clearTimeout(timeoutId);
        }

        if (!res.ok) {
            // HTTP error (e.g. 500 from VRAM pressure or model still loading) —
            // model is registered on the host so treat as valid with a warning.
            logger.warn('Judge model validation: generation returned HTTP error (host busy/VRAM), model is registered — treating as valid', {
                host, model, status: res.status, latency_ms: Date.now() - start
            });
            return {
                valid: true,
                warning: `Judge host returned HTTP ${res.status} during smoke-test (host may be busy). Warmup phase will verify capability.`,
                available_models: availableModels,
                latency_ms: Date.now() - start
            };
        }

        const data = await res.json();
        const text = String(data.message?.content ?? data.response ?? '').trim();

        // Try to parse JSON from response
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
            // Non-JSON response — model exists and responds, but didn't follow format.
            // Treat as valid with warning; actual judging quality is assessed at warmup.
            logger.warn('Judge model validation: response contains no JSON (model may need instruction tuning check)', {
                model,
                host,
                text: text.substring(0, 200),
                visibleResponseEmpty: text.length === 0,
                thinkingCharacters: String(data.message?.thinking || data.thinking || '').length
            });
            return {
                valid: true,
                warning: 'Judge model responded but output was not JSON. Warmup phase will verify scoring capability.',
                available_models: availableModels,
                latency_ms: Date.now() - start
            };
        }

        try {
            const jsonStr = text.substring(firstBrace, lastBrace + 1);
            JSON.parse(jsonStr); // throws if malformed
        } catch (_parseErr) {
            return {
                valid: true,
                warning: 'Judge model output contained malformed JSON. Warmup phase will verify scoring capability.',
                available_models: availableModels,
                latency_ms: Date.now() - start
            };
        }

        logger.info('Judge model validated successfully', { host, model, latency_ms: Date.now() - start });
        return {
            valid: true,
            available_models: availableModels,
            latency_ms: Date.now() - start
        };
    } catch (err) {
        throwIfExternalAborted(options.signal);
        if (err.name === 'AbortError') {
            // Timeout = model is cold-loading. Still valid — warmup handles this.
            logger.info('Judge model validation: generation timed out (cold start), model is registered — treating as valid', {
                host, model, timeout_ms: VALIDATION_TIMEOUT_MS, latency_ms: Date.now() - start
            });
            return {
                valid: true,
                warning: 'Judge model is loading (cold start). Warmup phase will handle this.',
                available_models: availableModels,
                latency_ms: Date.now() - start
            };
        }
        // Network or other error after step 1 passed — model is registered, treat as valid
        logger.warn('Judge model validation: generation check failed (network/error), model is registered — treating as valid', {
            host, model, error: err.message, latency_ms: Date.now() - start
        });
        return {
            valid: true,
            warning: `Judge smoke-test failed (${err.message}). Model is registered on host. Warmup phase will verify.`,
            available_models: availableModels,
            latency_ms: Date.now() - start
        };
    }
}

/**
 * Probe judge model capabilities via Ollama /api/show.
 * Returns model info including context window size.
 */
async function probeJudgeCapability(host, model, options = {}) {
    const _fetch = options._fetch || fetch;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        let res;
        try {
            res = await _fetch(`${host}/api/show`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model }),
                signal: combinedSignal(controller.signal, options.signal),
                redirect: 'manual'
            });
        } finally {
            clearTimeout(timeoutId);
        }

        if (!res.ok) {
            return { ok: false, error: `HTTP ${res.status}` };
        }

        const data = await res.json();
        const modelInfo = data.model_info || {};

        // Ollama exposes context_length in model_info (key varies by model family)
        let contextLength = null;
        for (const [key, value] of Object.entries(modelInfo)) {
            if (/context_length/i.test(key) && typeof value === 'number') {
                contextLength = value;
                break;
            }
        }

        const parameterSize = data.details?.parameter_size || null;

        return { ok: true, context_length: contextLength, parameter_size: parameterSize };
    } catch (err) {
        throwIfExternalAborted(options.signal);
        return { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
    }
}

module.exports = { validateJudgeModel, probeJudgeCapability };
