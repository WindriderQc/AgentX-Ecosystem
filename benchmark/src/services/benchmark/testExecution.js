/**
 * Test Execution
 * Single benchmark test runner against a model endpoint
 */

const logger = require('../../../config/logger');
const { getFetchOptions } = require('../../helpers/httpAgent');
const { withBenchmarkServiceAuth } = require('../../helpers/coreServiceAuth');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const { classifyBenchmarkError } = require('./errorClassifier');
const { benchmarkFetch: fetch } = require('./http');
const { getModelDigest } = require('./modelDigestService');
const { getConfiguredHosts } = require('../../helpers/ollamaHostConfig');
const { admitOllamaTargetResolved } = require('../../helpers/ollamaTargetAdmission');
const crypto = require('crypto');
const { getBenchmarkClaimIdentity } = require('../../clients/coreApiClient');
const {
    acquireBenchmarkClaims,
    releaseBenchmarkClaims,
    startBenchmarkClaimHeartbeat
} = require('./benchmarkClaimLifecycle');

/**
 * Run a single benchmark test
 */
async function runTest({ model, host, prompt }) {
    if (!model || !host || !prompt) {
        throw new Error('model, host, and prompt are required');
    }

    host = await admitOllamaTargetResolved(host, { configuredHosts: getConfiguredHosts() });

    const claimId = `benchmark-single-${crypto.randomBytes(8).toString('hex')}`;
    const claimedHosts = await acquireBenchmarkClaims([host], claimId, 10 * 60 * 1000);
    const claimAbort = new AbortController();
    const stopHeartbeat = startBenchmarkClaimHeartbeat(claimedHosts, claimId, 10 * 60 * 1000, {
        onFatal: error => claimAbort.abort(error)
    });
    await stopHeartbeat.ready;
    try {
        stopHeartbeat.assertActive();
    } catch (error) {
        await stopHeartbeat.drain();
        await releaseBenchmarkClaims(claimedHosts, claimId);
        throw error;
    }

    const start = Date.now();
    let persistedResult = null;

    const persistResultWithFence = async (result) => {
        stopHeartbeat.assertActive();
        try {
            await result.save({ signal: claimAbort.signal });
            persistedResult = result;
            stopHeartbeat.assertActive();
            return result;
        } catch (error) {
            if (persistedResult?._id || result?._id) {
                await BenchmarkResult.deleteOne({ _id: persistedResult?._id || result._id }).catch(() => {});
            }
            throw error;
        }
    };

    try {
        // Route through Core's direct Benchmark lane so the exact claim proof
        // is enforced rather than relying on an unfenced direct Ollama call.
        const url = `${process.env.CORE_URL || 'http://localhost:3080'}/api/inference/generate`;
        const claimIdentity = getBenchmarkClaimIdentity(host, claimId);
        if (!claimIdentity) throw new Error('Missing exact benchmark claim proof');
        const fetchOptions = getFetchOptions(url, {
            method: 'POST',
            headers: withBenchmarkServiceAuth({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                model,
                host,
                messages: [{ role: 'user', content: prompt }],
                stream: false,
                rawResponse: true,
                callerDetail: 'benchmark-single-test',
                ...claimIdentity,
                options: {}
            }),
            timeout: 600000,
            signal: claimAbort.signal,
            redirect: 'manual'
        });
        const response = await fetch(url, fetchOptions);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        const latency = Date.now() - start;
        const responseText = data.message?.content || '';
        const tokens = data.eval_count || Math.ceil(responseText.length / 4);
        stopHeartbeat.assertActive();
        const promptEvalDurationMs = data.prompt_eval_duration > 0
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
        const modelDigest = await getModelDigest(host, model, { signal: claimAbort.signal });
        stopHeartbeat.assertActive();

        const result = new BenchmarkResult({
            model,
            model_digest: modelDigest,
            host,
            prompt,
            ...promptMeta,
            latency,
            tokens,
            tokens_per_sec: tokensPerSec,
            time_to_first_token_ms: null,
            prompt_eval_duration_ms: promptEvalDurationMs,
            response: responseText,
            success: true,
            timestamp: new Date()
        });

        await persistResultWithFence(result);

        logger.info('Benchmark test completed', {
            model, host, latency, tokens_per_sec: result.tokens_per_sec
        });

        return result;

    } catch (err) {
        // Claim loss aborts the in-flight Core/Ollama request. Do not start a
        // digest lookup or persist a result after ownership has been lost.
        if (claimAbort.signal.aborted || stopHeartbeat.getFailure?.()) {
            throw (claimAbort.signal.reason instanceof Error
                ? claimAbort.signal.reason
                : stopHeartbeat.getFailure?.() || err);
        }
        stopHeartbeat.assertActive();
        const classified = classifyBenchmarkError(err);
        const modelDigest = await getModelDigest(host, model, { signal: claimAbort.signal });
        stopHeartbeat.assertActive();
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

        await persistResultWithFence(result);
        logger.error('Benchmark test failed', { model, host, error: err.message });

        throw err;
    } finally {
        if (typeof stopHeartbeat.drainHosts === 'function') await stopHeartbeat.drainHosts();
        const release = await releaseBenchmarkClaims(claimedHosts, claimId, {
            releaseWorkloadAdmission: false
        });
        await stopHeartbeat.drain();
        if (release.failed === 0) {
            const workload = await require('../../clients/coreApiClient').releaseWorkloadAdmission(claimId);
            if (workload?.released !== true) {
                release.failed += 1;
                release.workloadAdmission = workload;
            }
        }
        if (release.failed > 0) {
            // The test evidence is only authoritative when the exact host
            // snapshot was restored and the linked workload admission could
            // be released. Invalidate any possibly committed result before
            // surfacing a failed lifecycle receipt.
            if (persistedResult?._id) {
                await BenchmarkResult.deleteOne({ _id: persistedResult._id }).catch(() => {});
                persistedResult = null;
            }
            const error = new Error(
                release.details?.find(detail => !detail.released)?.reason
                || release.workloadAdmission?.reason
                || 'Benchmark runtime restore/release failed'
            );
            error.code = 'BENCHMARK_RUNTIME_RESTORE_FAILED';
            throw error;
        }
    }
}

module.exports = { runTest };
