const isEven = require('../src/isEven');
if (isEven(4) !== true) { console.error('public FAIL'); process.exit(1); }
process.exit(0);
