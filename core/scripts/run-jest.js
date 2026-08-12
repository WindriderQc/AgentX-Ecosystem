const { spawnSync } = require('child_process');
const path = require('path');

const jestBin = path.resolve(__dirname, '../node_modules/jest/bin/jest.js');
const userArgs = process.argv.slice(2);

const hasExplicitWorkerMode = userArgs.some(arg =>
  arg === '--runInBand' ||
  arg.startsWith('--maxWorkers') ||
  arg === '-w'
);

const defaultArgs = ['--max-old-space-size=4096', jestBin];

if (process.platform === 'win32' && !hasExplicitWorkerMode) {
  defaultArgs.push('--runInBand');
}

const result = spawnSync(process.execPath, [...defaultArgs, ...userArgs], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || 'test',
    TEST_LOG_LEVEL: process.env.TEST_LOG_LEVEL || 'error'
  }
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 0);
