const factorial = require('../src/factorial');
if (factorial(3) !== 6) { console.error('public FAIL'); process.exit(1); }
process.exit(0);
