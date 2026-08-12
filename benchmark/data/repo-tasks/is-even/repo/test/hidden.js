const isEven = require('../src/isEven');
if (isEven(3) !== false || isEven(0) !== true) { console.error('hidden FAIL'); process.exit(1); }
process.exit(0);
