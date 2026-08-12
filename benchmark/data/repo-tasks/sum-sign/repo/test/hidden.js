const sum = require('../src/sum');
if (sum(-1, 1) !== 0 || sum(10, 5) !== 15) { console.error('hidden FAIL'); process.exit(1); }
process.exit(0);
