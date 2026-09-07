const { execFileSync } = require('child_process');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function processExists(pid) {
  if (!pid) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcessTree(pid) {
  if (!processExists(pid)) return;

  // On Windows SIGTERM kills the root immediately, losing its descendants.
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { /* already exited */ }
    if (processExists(pid)) throw new Error(`Owned test process ${pid} did not stop`);
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // ignore
  }

  const gracefulDeadline = Date.now() + 1500;
  while (Date.now() < gracefulDeadline && processExists(pid)) {
    await sleep(100);
  }

  if (!processExists(pid)) return;

  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // ignore
  }

  const forcedDeadline = Date.now() + 5000;
  while (Date.now() < forcedDeadline && processExists(pid)) {
    await sleep(100);
  }
  if (processExists(pid)) throw new Error(`Owned test process ${pid} did not stop`);
}

module.exports = {
  processExists,
  sleep,
  terminateProcessTree
};
