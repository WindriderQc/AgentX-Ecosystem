const { average, range } = require('../src/stats');
const values = [2, Number.NaN, 6];
const r = range(values);
if (average(values) !== 4 || !r || r.min !== 2 || r.max !== 6) process.exit(1);
process.exit(0);
