/**
 * Execution Host Validator
 * Pre-batch validation that the execution host is a reachable Ollama endpoint
 * and all requested models are available.
 */

const { benchmarkFetch: fetch } = require('./http');
const { normalizeModelName } = require('./modelMetadata');
const { getConfiguredHosts } = require('../../helpers/ollamaHostConfig');
const { admitOllamaTargetResolved } = require('../../helpers/ollamaTargetAdmission');
const { readBoundedJson } = require('../../helpers/boundedJsonResponse');

/**
 * Validate that a host is a reachable Ollama endpoint with the requested models.
 * @param {string} host - Ollama host URL
 * @param {string[]} models - Model names to check
 * @returns {Promise<{valid: boolean, error?: string, available_models?: string[]}>}
 */
async function validateExecutionHost(host, models) {
    let normalizedHost;
    try {
        normalizedHost = await admitOllamaTargetResolved(String(host || '').trim(), {
            configuredHosts: getConfiguredHosts()
        });
    } catch (error) {
        return { valid: false, error: error.message };
    }
    const normalizedModels = Array.isArray(models)
        ? [...new Set(models.map(normalizeModelName).filter(Boolean))]
        : [];

    if (normalizedModels.length === 0) {
        return { valid: false, error: 'At least one execution model is required' };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
        const tagsRes = await fetch(`${normalizedHost}/api/tags`, {
            method: 'GET',
            signal: controller.signal,
            redirect: 'manual'
        });
        if (!tagsRes.ok) {
            return { valid: false, error: `Execution host is not a valid Ollama endpoint: HTTP ${tagsRes.status}` };
        }

        let tagsData;
        try {
            tagsData = await readBoundedJson(tagsRes);
        } catch (error) {
            return { valid: false, error: error.code === 'OLLAMA_RESPONSE_TOO_LARGE'
                ? error.message
                : 'Execution host returned invalid JSON' };
        }

        const available = (tagsData.models || []).map((m) => normalizeModelName(m.name || m.model));
        const availableSet = new Set(available);
        const missing = normalizedModels.filter(m => !availableSet.has(m));

        if (missing.length > 0) {
            return {
                valid: false,
                error: `Models not found on execution host: ${missing.join(', ')}`,
                available_models: available
            };
        }

        return { valid: true, host: normalizedHost, available_models: available };
    } catch (err) {
        const msg = err.name === 'AbortError' ? 'timeout' : err.message;
        return { valid: false, error: `Cannot reach execution host ${normalizedHost}: ${msg}` };
    } finally {
        clearTimeout(timeoutId);
    }
}

module.exports = { validateExecutionHost };
