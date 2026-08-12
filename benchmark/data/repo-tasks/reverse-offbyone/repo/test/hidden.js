const reverseStr = require('../src/reverseStr');
if (reverseStr('hello') !== 'olleh' || reverseStr('x') !== 'x') { console.error('hidden FAIL'); process.exit(1); }
process.exit(0);
