const clamp = require('../src/clamp');
if (clamp(5, 0, 10) !== 5) { console.error('public FAIL'); process.exit(1); }
process.exit(0);
