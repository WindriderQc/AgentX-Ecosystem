const clamp = require('../src/clamp');
if (clamp(-3, 0, 10) !== 0 || clamp(99, 0, 10) !== 10) { console.error('hidden FAIL'); process.exit(1); }
process.exit(0);
