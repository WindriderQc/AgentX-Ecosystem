'use strict';

const { fork } = require('node:child_process');
const path = require('node:path');
const fixture = path.join(__dirname, '../fixtures/serverShutdown.child.js');

function run(phase) {
  return new Promise((resolve, reject) => {
    const child = fork(fixture, [phase], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const events = [];
    let stderr = '';
    let signalled = false;
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Fixture failed to exit naturally: ${phase}; ${events}; ${stderr}`));
    }, 5000);
    child.stderr.on('data', data => { stderr += data; });
    child.stdout.resume();
    child.on('error', error => { clearTimeout(deadline); reject(error); });
    child.on('message', message => {
      if (message.event) events.push(message.event);
      const trigger = ['before-tick', 'deadline', 'cleanup-error'].includes(phase) ? 'ready' : 'dispatched';
      if (message.event !== trigger || signalled) return;
      signalled = true;
      if (process.platform === 'win32') {
        child.send({ signal: 'SIGTERM' });
        child.send({ signal: 'SIGINT' });
      } else {
        child.kill('SIGTERM');
        child.kill('SIGINT');
      }
    });
    child.on('exit', (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, events, stderr });
    });
  });
}

test('signal before the watchdog tick starts no metadata or inference work', async () => {
  const result = await run('before-tick');
  expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
  expect(result.events).not.toContain('metadata');
  expect(result.events).not.toContain('acquired');
  expect(result.events.filter(event => event === 'stop')).toHaveLength(1);
  expect(result.events.filter(event => event === 'disconnected')).toHaveLength(1);
});

test('signal during a probe waits for its exact receipt and skips the next host', async () => {
  const result = await run('pending-probe');
  expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
  expect(result.events.filter(event => event === 'dispatched')).toHaveLength(1);
  expect(result.events.filter(event => event === 'metadata')).toHaveLength(1);
  expect(result.events).not.toContain('unknown');
  expect(result.events.indexOf('completed')).toBeGreaterThan(result.events.indexOf('stop'));
  expect(result.events.indexOf('disconnected')).toBeGreaterThan(result.events.indexOf('completed'));
});

test('a missing terminal is quarantined before disconnect, never called complete', async () => {
  const result = await run('missing-terminal');
  expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
  expect(result.events).not.toContain('completed');
  expect(result.events).toContain('unknown');
  expect(result.events.indexOf('disconnected')).toBeGreaterThan(result.events.indexOf('unknown'));
});

test('a hung stop has a bounded nonzero exit', async () => {
  const result = await run('deadline');
  expect(result.code).toBe(1);
  expect(result.events).toContain('Core shutdown exceeded its deadline');
});

test('cleanup errors still disconnect and exit nonzero', async () => {
  const result = await run('cleanup-error');
  expect(result.code).toBe(1);
  expect(result.events).toContain('disconnected');
});
