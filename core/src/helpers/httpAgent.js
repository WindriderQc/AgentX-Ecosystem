/**
 * HTTP Agent Configuration for Ollama API Calls
 *
 * Provides configured HTTP/HTTPS agents with proper keep-alive and timeout settings
 * to ensure reliable connections across different platforms (Windows/Linux).
 *
 * Issue: node-fetch v2 uses default connection pooling which can lead to stale
 * connections, especially when switching between Windows and Linux hosts.
 * Different platforms handle TCP keep-alive differently, causing first request failures.
 *
 * Solution: Explicit agent configuration with:
 * - Controlled keep-alive behavior
 * - Proper timeout settings
 * - Connection limits to prevent resource exhaustion
 * - Shorter keepAlive intervals to prevent stale connections
 */

const http = require('http');
const https = require('https');

// Agent configuration optimized for Ollama API calls
// Focus: Prevent stale connections while maintaining reasonable performance
const AGENT_CONFIG = {
    // Keep connections alive for reuse
    keepAlive: true,

    // Time (ms) to keep sockets alive when no activity
    // LOWER value prevents stale connections on Linux hosts
    // Windows was more forgiving, Linux closes idle connections faster
    keepAliveMsecs: 1000,  // 1 second - aggressive to prevent staleness

    // Maximum number of sockets to allow per host
    // Ollama typically doesn't need many concurrent connections per host
    maxSockets: 10,

    // Maximum number of sockets to keep open in idle state
    // Keep this LOW to prevent accumulation of stale connections
    maxFreeSockets: 2,

    // Socket timeout (ms) - time to wait for socket to be established
    // Important for detecting dead connections early
    timeout: 60000,

    // Use LIFO scheduling - prefer newer (more likely active) connections
    scheduling: 'lifo'
};

// Create reusable HTTP agent
const httpAgent = new http.Agent(AGENT_CONFIG);

// Create reusable HTTPS agent
const httpsAgent = new https.Agent(AGENT_CONFIG);

/**
 * Get the appropriate agent for a given URL
 * @param {string} url - The URL to determine agent for
 * @returns {http.Agent|https.Agent|null} The appropriate agent
 */
function getAgent(url) {
    if (!url) {
        return null;
    }

    // Determine protocol from URL
    if (url.startsWith('https://') || url.startsWith('HTTPS://')) {
        return httpsAgent;
    }

    return httpAgent;
}

/**
 * Get fetch options with proper agent configuration
 * Merges provided options with agent for the URL
 *
 * @param {string} url - The URL being fetched
 * @param {Object} options - Additional fetch options
 * @returns {Object} Fetch options with agent configured
 */
function getFetchOptions(url, options = {}) {
    const agent = getAgent(url);

    return {
        ...options,
        agent: agent
    };
}

/**
 * Destroy all agents and close their connections
 * Useful for testing or graceful shutdown
 */
function destroyAgents() {
    httpAgent.destroy();
    httpsAgent.destroy();
}

module.exports = {
    httpAgent,
    httpsAgent,
    getAgent,
    getFetchOptions,
    destroyAgents,
    AGENT_CONFIG
};
