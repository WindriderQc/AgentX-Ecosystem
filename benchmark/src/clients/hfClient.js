'use strict';

/**
 * Minimal HuggingFace API client (Node stdlib only, no deps).
 * Used by the model-intake route to discover GGUF candidates.
 */

const https = require('https');

function httpGetJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'agentx-benchmark-intake' }, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}

/**
 * Fetch the top GGUF models for a family, sorted by downloads.
 * @returns {Promise<Array<{id, downloads, likes}>>}
 */
async function fetchFamily(family, limit = 15) {
  const url = `https://huggingface.co/api/models?search=${encodeURIComponent(family)}`
    + `&sort=downloads&direction=-1&limit=${limit}&filter=gguf`;
  const data = await httpGetJson(url);
  return (Array.isArray(data) ? data : []).map((m) => ({ id: m.id, downloads: m.downloads, likes: m.likes }));
}

module.exports = { httpGetJson, fetchFamily };
