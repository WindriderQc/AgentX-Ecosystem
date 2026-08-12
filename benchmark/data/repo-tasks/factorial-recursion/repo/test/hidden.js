const factorial = require('../src/factorial');
if (factorial(5) !== 120 || factorial(0) !== 1 || factorial(1) !== 1) { console.error('hidden FAIL'); process.exit(1); }
process.exit(0);
