const JobScheduler = require('../src/JobScheduler');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const scheduler = new JobScheduler(2);
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const first = scheduler.submit('duplicate', async () => {
    calls += 1;
    await gate;
    return 'shared-value';
  });
  const second = scheduler.submit('duplicate', async () => {
    calls += 1;
    return 'wrong-second-run';
  });

  await delay(20);
  if (calls !== 1) throw new Error(`duplicate job executed ${calls} times`);
  release();
  const values = await Promise.all([first, second]);
  if (values[0] !== 'shared-value' || values[1] !== 'shared-value') {
    throw new Error(`duplicate callers did not share the same value: ${JSON.stringify(values)}`);
  }
})().then(() => process.exit(0)).catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
