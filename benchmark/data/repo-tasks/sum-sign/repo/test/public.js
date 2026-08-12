const sum = require('../src/sum');
if (sum(2, 3) !== 5) { console.error('public FAIL'); process.exit(1); }
process.exit(0);
