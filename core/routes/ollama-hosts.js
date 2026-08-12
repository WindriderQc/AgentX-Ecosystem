/**
 * Ollama Hosts Routes
 * Returns configured Ollama hosts with their available models
 */

const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const logger = require('../config/logger');
const { getConfiguredHosts, validateHostUrl } = require('../src/helpers/ollamaHostConfig');

async function fetchOllamaJson(hostUrl, endpoint) {
    const response = await fetch(`${hostUrl}${endpoint}`, {
        method: 'GET',
        timeout: 3000
    });

    if (!response.ok) {
        throw new Error(`${endpoint} returned HTTP ${response.status}`);
    }

    return response.json();
}

// Fetch the complete model inventory and runtime version from one Ollama host.
// `models` intentionally keeps its historical generation-only semantics because
// chat and benchmark clients consume it. `installedModels` is the additive,
// unfiltered fleet-truth view (embeddings and diagnostic artifacts included).
async function fetchModels(hostUrl) {
    const [tagsResult, versionResult] = await Promise.allSettled([
        fetchOllamaJson(hostUrl, '/api/tags'),
        fetchOllamaJson(hostUrl, '/api/version')
    ]);

    if (tagsResult.status === 'rejected') {
        return {
            success: false,
            error: tagsResult.reason?.message || 'Unable to fetch Ollama tags',
            models: [],
            installedModels: [],
            ollamaVersion: versionResult.status === 'fulfilled' ? versionResult.value?.version || null : null,
            versionError: versionResult.status === 'rejected' ? versionResult.reason?.message : undefined
        };
    }

    const inventory = Array.isArray(tagsResult.value?.models) ? tagsResult.value.models : [];
    const installedModels = inventory
        .map(model => model?.name)
        .filter(Boolean);

    // Filter out embedding and diagnostic models for the legacy generation picker.
    const models = inventory
        .filter(m => {
            const name = String(m?.name || '').toLowerCase();
            const family = m?.details?.family?.toLowerCase() || '';

            // Exclude known embedding keywords
            if (name.includes('embed') || name.includes('nomic') || name.includes('bert')) {
                return false;
            }

            // Exclude embedding families
            if (family === 'bert' || family === 'nomic-bert') {
                return false;
            }

            // Exclude diagnostic models
            if (name.includes('diagnostic')) {
                return false;
            }

            return true;
        })
        .map(m => m.name);

    return {
        success: true,
        models,
        installedModels,
        ollamaVersion: versionResult.status === 'fulfilled' ? versionResult.value?.version || null : null,
        versionError: versionResult.status === 'rejected' ? versionResult.reason?.message : undefined
    };
}

/**
 * GET /api/ollama-hosts
 * Get all configured Ollama hosts with their models
 */
router.get('/', async (req, res) => {
    try {
        const configuredHosts = getConfiguredHosts();

        // Fetch models from each host in parallel
        const hostsWithModels = await Promise.all(
            configuredHosts.map(async (host) => {
                const result = await fetchModels(host.url);
                return {
                    ...host,
                    available: result.success,
                    models: result.models,
                    installedModels: result.installedModels,
                    ollamaVersion: result.ollamaVersion,
                    versionError: result.versionError,
                    error: result.error
                };
            })
        );

        res.json({
            status: 'success',
            data: {
                hosts: hostsWithModels,
                total: hostsWithModels.length,
                available: hostsWithModels.filter(h => h.available).length
            }
        });
    } catch (err) {
        logger.error('Failed to fetch Ollama hosts', { error: err.message });
        res.status(500).json({
            status: 'error',
            error: err.message
        });
    }
});

/**
 * GET /api/ollama-hosts/:hostId/models
 * Get models for a specific host
 */
router.get('/:hostId/models', async (req, res) => {
    try {
        const { hostId } = req.params;
        const configuredHosts = getConfiguredHosts();
        const host = configuredHosts.find(h => h.id === hostId);

        if (!host) {
            return res.status(404).json({
                status: 'error',
                error: 'Host not found'
            });
        }

        const result = await fetchModels(host.url);

        res.json({
            status: 'success',
            data: {
                host: host,
                available: result.success,
                models: result.models,
                installedModels: result.installedModels,
                ollamaVersion: result.ollamaVersion,
                versionError: result.versionError,
                error: result.error
            }
        });
    } catch (err) {
        logger.error('Failed to fetch models', { error: err.message });
        res.status(500).json({
            status: 'error',
            error: err.message
        });
    }
});

/**
 * GET /api/ollama-hosts/proxy/tags
 * Proxy endpoint for fetching models from configured Ollama host
 * This avoids CORS issues when frontend needs to access Ollama API
 */
router.get('/proxy/tags', async (req, res) => {
    try {
        // Use custom host from query param or default to primary configured host.
        // Custom host MUST be in the configured allowlist (task 0182 follow-up):
        // even read-only proxies forward TCP to wherever this URL points, so an
        // arbitrary URL is still an SSRF vector for whatever runs on it.
        const customHost = req.query.host;
        let ollamaHost;

        if (customHost) {
            const validation = validateHostUrl(customHost);
            if (!validation.valid) {
                return res.status(400).json({
                    error: 'Host URL not in configured allowlist',
                    detail: validation.error,
                    configured: getConfiguredHosts().map(h => h.url)
                });
            }
            ollamaHost = validation.host;
        } else {
            const configuredHosts = getConfiguredHosts();
            ollamaHost = configuredHosts[0]?.url;

            if (!ollamaHost) {
                throw new Error('No Ollama hosts configured');
            }
        }

        const response = await fetch(`${ollamaHost}/api/tags`, {
            method: 'GET',
            timeout: 5000
        });

        if (!response.ok) {
            throw new Error(`Ollama returned HTTP ${response.status}`);
        }

        const data = await response.json();

        // Return in Ollama's native format for compatibility
        res.json(data);
    } catch (err) {
        logger.error('Failed to proxy Ollama tags', { error: err.message });
        res.status(500).json({
            status: 'error',
            error: err.message,
            models: []
        });
    }
});

module.exports = router;
