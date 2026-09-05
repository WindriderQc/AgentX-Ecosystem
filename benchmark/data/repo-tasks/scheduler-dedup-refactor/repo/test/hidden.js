const fs = require('fs');
const JobScheduler = require('../src/JobScheduler');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate, label) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

(async () => {
  const source = fs.readFileSync(require.resolve('../src/JobScheduler'), 'utf8');
  if (/\bset(?:Interval|Timeout)\s*\(/.test(source)) {
    throw new Error('scheduler still uses polling');
  }

  const cached = new JobScheduler(1);
  let cachedCalls = 0;
  const firstValue = await cached.submit('cached', async () => { cachedCalls += 1; return 42; });
  const secondValue = await cached.submit('cached', async () => { cachedCalls += 1; return 99; });
  if (firstValue !== 42 || secondValue !== 42 || cachedCalls !== 1) {
    throw new Error('completed success was not cached consistently');
  }

  const sentinel = new Error('sentinel failure');
  let errorCalls = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await cached.submit('failed', async () => { errorCalls += 1; throw sentinel; });
      throw new Error('cached error unexpectedly resolved');
    } catch (error) {
      if (error !== sentinel) throw error;
    }
  }
  if (errorCalls !== 1) throw new Error(`failed job executed ${errorCalls} times`);

  const scheduler = new JobScheduler(2);
  const starts = [];
  const releases = new Map();
  let active = 0;
  let maxActive = 0;
  const jobs = ['a', 'b', 'c', 'd'].map((id) => scheduler.submit(id, async () => {
    starts.push(id);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => releases.set(id, resolve));
    active -= 1;
    return id;
  }));

  await waitUntil(() => starts.length === 2, 'first two jobs');
  if (starts.join(',') !== 'a,b') throw new Error(`FIFO violated at start: ${starts.join(',')}`);
  releases.get('a')();
  await waitUntil(() => starts.length === 3, 'third job');
  if (starts[2] !== 'c') throw new Error(`third start was ${starts[2]}`);
  releases.get('b')();
  await waitUntil(() => starts.length === 4, 'fourth job');
  if (starts[3] !== 'd') throw new Error(`fourth start was ${starts[3]}`);
  releases.get('c')();
  releases.get('d')();

  const values = await Promise.all(jobs);
  if (values.join(',') !== 'a,b,c,d') throw new Error('job values changed');
  if (maxActive > 2) throw new Error(`concurrency exceeded: ${maxActive}`);
})().then(() => process.exit(0)).catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
