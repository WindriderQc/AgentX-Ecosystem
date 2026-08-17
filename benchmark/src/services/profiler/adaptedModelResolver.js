'use strict';

const { getFetchOptions } = require('../../helpers/httpAgent');
const { benchmarkFetch: fetch } = require('../benchmark/http');
const { isAdaptedModel, buildAdaptedName } = require('./namingConvention');

/**
 * Resolve adapted model name: prefer ax/<model> when deployed on the target host.
 *
 * This is the invariant that makes host-safe profiling meaningful: any caller
 * that picks a base model name gets silently upgraded to the ax/-prefixed
 * variant if one exists on the host. Without this, upstream Modelfile defaults
 * re-inflate ctx past the host's VRAM envelope.
 *
 * @param {string} model
 * @param {string} host  Full URL including scheme
 * @returns {Promise<string>} effective model name to send to Ollama
 */
async function resolveAdaptedModel(model, host) {
    if (!model || !host) return model;
    if (isAdaptedModel(model)) return model;
    const adaptedName = buildAdaptedName(model);
    try {
        const url = `${host}/api/show`;
        const fetchOptions = getFetchOptions(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: adaptedName }),
            timeout: 3000
        });
        const resp = await fetch(url, fetchOptions);
        if (resp.ok) return adaptedName;
    } catch { /* base model stands */ }
    return model;
}

module.exports = { resolveAdaptedModel };
