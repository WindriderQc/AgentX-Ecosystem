const max = require('../src/max');
if (max(5, 1) !== 5 || max(-2, -5) !== -2) { console.error('hidden FAIL'); process.exit(1); }
process.exit(0);
