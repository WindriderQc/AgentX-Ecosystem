const discount = require('../src/discount');
if (discount(100, 0.2) !== 25) { console.error('discount assertion failed'); process.exit(1); }
process.exit(0);
