const root = typeof global !== 'undefined' ? global : {};
const fetchImpl = typeof root.fetch === 'function'
    ? root.fetch.bind(root)
    : require('node-fetch');

function benchmarkFetch(url, options = {}) {
    // Ollama endpoints are never allowed to redirect the Benchmark service to
    // another network target. Callers may add transport controls, but cannot
    // opt this boundary back out.
    return fetchImpl(url, { ...options, redirect: 'manual' });
}

module.exports = {
    benchmarkFetch
};
