const fs = require('fs');
const { spawnSync } = require('child_process');
const source = fs.readFileSync(require.resolve('./public'), 'utf8');
const run = spawnSync(process.execPath, ['test/public.js'], { cwd: require('path').join(__dirname, '..') });
if (run.status !== 0) process.exit(1);
if (!/discount\(100,\s*0\.2\)\s*!==\s*20/.test(source)) process.exit(1);
if (!/discount\(50,\s*0\)\s*!==\s*0/.test(source)) process.exit(1);
process.exit(0);
