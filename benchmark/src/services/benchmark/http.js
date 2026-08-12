const root = typeof global !== 'undefined' ? global : {};
const fetchImpl = typeof root.fetch === 'function'
    ? root.fetch.bind(root)
    : require('node-fetch');

function benchmarkFetch(...args) {
    return fetchImpl(...args);
}

module.exports = {
    benchmarkFetch
};
