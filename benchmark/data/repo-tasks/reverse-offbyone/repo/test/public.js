const reverseStr = require('../src/reverseStr');
if (reverseStr('abc') !== 'cba') { console.error('public FAIL'); process.exit(1); }
process.exit(0);
