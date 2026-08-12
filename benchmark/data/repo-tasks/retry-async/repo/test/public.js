const retry = require('../src/retry');
(async () => {
  let calls = 0;
  const value = await retry(async () => { calls += 1; if (calls < 2) throw new Error('again'); return 'ok'; }, 3);
  if (value !== 'ok' || calls !== 2) process.exit(1);
})().catch(() => process.exit(1));
