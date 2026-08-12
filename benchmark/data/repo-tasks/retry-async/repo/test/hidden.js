const retry = require('../src/retry');
(async () => {
  let calls = 0;
  try { await retry(async () => { calls += 1; throw new Error(`fail-${calls}`); }, 2); process.exit(1); }
  catch (error) { if (calls !== 2 || error.message !== 'fail-2') process.exit(1); }
  for (const invalid of [0, -1, 1.5]) {
    try { await retry(async () => 'no', invalid); process.exit(1); } catch (error) { if (!(error instanceof TypeError)) process.exit(1); }
  }
})().catch(() => process.exit(1));
