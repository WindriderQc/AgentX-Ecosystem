/**
 * Test Execution
 * Single benchmark test runner against a model endpoint
 */

const logger = require('../../../config/logger');
const { getFetchOptions } = require('../../helpers/httpAgent');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const { classifyBenchmarkError } = require('./errorClassifier');
const { benchmarkFetch: fetch } = require('./http');
const { resolveAdaptedModel } = require('../profiler/adaptedModelResolver');
const { getModelDigest } = require('./modelDigestService');

/**
 * Run a single benchmark test
 */
async function runTest({ model, host, prompt }) {
    if (!model || !host || !prompt) {
        throw new Error('model, host, and prompt are required');
    }

    const effectiveModel = await resolveAdaptedModel(model, host);
    const start = Date.now();

    try {
        // Use /api/chat for proper chat template application on instruction-tuned models
        const url = `${host}/api/chat`;
        const fetchOptions = getFetchOptions(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: effectiveModel,
                messages: [{ role: 'user', content: prompt }],
                stream: false,
                options: {}
            }),
            timeout: 600000
        });
        const response = await fetch(url, fetchOptions);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        const latency = Date.now() - start;
        const responseText = data.message?.content || '';
        const tokens = data.eval_count || Math.ceil(responseText.length / 4);
        const timeToFirstTokenMs = data.prompt_eval_duration > 0
            ? Number((data.prompt_eval_duration / 1e6).toFixed(1))
            : null;

        let promptMeta = {};
        try {
            const promptDef = await BenchmarkPrompt.findOne({ prompt });
            if (promptDef) {
                promptMeta = {
                    prompt_level: promptDef.level,
                    prompt_category: promptDef.category,
                    prompt_name: promptDef.name
                };
            }
        } catch (err) {
            // Ignore lookup errors
        }

        const tokensPerSec = (tokens > 0 && latency > 0)
            ? Number((tokens / (latency / 1000)).toFixed(2))
            : 0;
        const modelDigest = await getModelDigest(host, model);

        const result = new BenchmarkResult({
            model,
            model_digest: modelDigest,
            host,
            prompt,
            ...promptMeta,
            latency,
            tokens,
            tokens_per_sec: tokensPerSec,
            time_to_first_token_ms: timeToFirstTokenMs,
            response: responseText,
            success: true,
            timestamp: new Date()
        });

        await result.save();

        logger.info('Benchmark test completed', {
            model, host, latency, tokens_per_sec: result.tokens_per_sec
        });

        return result;

    } catch (err) {
        const classified = classifyBenchmarkError(err);
        const modelDigest = await getModelDigest(host, model);
        const result = new BenchmarkResult({
            model,
            model_digest: modelDigest,
            host,
            prompt,
            error: err.message,
            infra_error: classified.infra,
            error_type: classified.type,
            error_http_status: classified.httpStatus,
            success: false,
            timestamp: new Date()
        });

        await result.save();
        logger.error('Benchmark test failed', { model, host, error: err.message });

        throw err;
    }
}

module.exports = { runTest };
