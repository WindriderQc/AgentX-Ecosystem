'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('both launchers wait for loopback-published product endpoints after container health', () => {
  const bash = fs.readFileSync(path.join(root, 'agentx'), 'utf8');
  const powershell = fs.readFileSync(path.join(root, 'agentx.ps1'), 'utf8');

  assert.match(bash, /wait_published_product_endpoints\(\)/);
  assert.equal((bash.match(/wait_published_product_endpoints \|\| exit 1/g) || []).length, 2);
  assert.match(bash, /http:\/\/127\.0\.0\.1:\$\{port\}\/health/);

  assert.match(powershell, /function Wait-PublishedProductEndpoints/);
  assert.equal((powershell.match(/if \(-not \(Wait-PublishedProductEndpoints\)\) \{ exit 1 \}/g) || []).length, 2);
  assert.match(powershell, /http:\/\/127\.0\.0\.1:\$port\/health/);
});

test('PowerShell launcher calls enforce body, lifecycle, loopback, and redirect bounds', () => {
  const powershell = fs.readFileSync(path.join(root, 'agentx.ps1'), 'utf8');

  assert.match(powershell, /\$agentXHealthResponseLimitBytes = 64KB/);
  assert.match(powershell, /\$agentXOllamaVersionResponseLimitBytes = 16KB/);
  assert.match(powershell, /-not \$Uri\.IsLoopback/);
  assert.match(powershell, /\$handler\.AllowAutoRedirect = \$false/);
  assert.match(powershell, /\$handler\.UseProxy = \$false/);
  assert.match(powershell, /\$handler\.MaxResponseHeadersLength = 16/);
  assert.match(powershell, /HttpCompletionOption\]::ResponseHeadersRead/);
  assert.match(powershell, /\$null -ne \$declaredLength -and \[long\] \$declaredLength -gt \$MaximumResponseBytes/);
  assert.match(powershell, /\$responseStream\.ReadAsync\(/);
  assert.match(powershell, /Invoke-AgentXBoundedWebRequest[^\r\n]+-MaximumResponseBytes \$agentXHealthResponseLimitBytes -MaximumRedirection 0/);
  assert.match(powershell, /Invoke-AgentXBoundedRestMethod[^\r\n]+-MaximumResponseBytes \$agentXOllamaVersionResponseLimitBytes -MaximumRedirection 0/);
});

const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
const pwshAvailable = !spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
  stdio: 'ignore',
}).error;

function runPowerShell(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(pwsh, ['-NoLogo', '-NoProfile', '-Command', source], {
      cwd: root,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('PowerShell launcher bounds test timed out'));
    }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('bounded PowerShell requests reject declared, streamed, redirected, and stalled responses', {
  skip: !pwshAvailable,
}, async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === '/small') {
      const body = JSON.stringify({ version: 'test' });
      response.writeHead(200, {
        'content-length': Buffer.byteLength(body),
        'content-type': 'application/json',
      });
      response.end(body);
      return;
    }
    if (request.url === '/large-declared') {
      const body = 'x'.repeat(128);
      response.writeHead(200, { 'content-length': Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    if (request.url === '/large-streamed') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('x'.repeat(64));
      response.end('x'.repeat(64));
      return;
    }
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/small' });
      response.end();
      return;
    }
    if (request.url === '/slow') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('started');
      setTimeout(() => response.end('finished'), 2_000);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const launcherPath = path.join(root, 'agentx.ps1').replaceAll("'", "''");
  const source = `
. '${launcherPath}' help | Out-Null

function Assert-BoundedFailure {
    param([ScriptBlock] $Action, [string] $ExpectedMessage)
    $failed = $false
    try { & $Action | Out-Null }
    catch {
        $failed = $true
        if ($ExpectedMessage -and $_.Exception.Message -notmatch $ExpectedMessage) { throw }
    }
    if (-not $failed) { throw 'Expected the bounded launcher request to fail.' }
}

$small = Invoke-AgentXBoundedRestMethod -Uri '${baseUrl}/small' -TimeoutSec 2 -MaximumResponseBytes 32 -MaximumRedirection 0
if ($small.version -ne 'test') { throw 'Bounded JSON response was not preserved.' }
Write-Output 'SMALL_OK'
Assert-BoundedFailure { Invoke-AgentXBoundedWebRequest -Uri 'http://example.test/health' -TimeoutSec 2 -MaximumResponseBytes 32 -MaximumRedirection 0 } 'restricted to unencrypted loopback'
Write-Output 'LOOPBACK_OK'
Assert-BoundedFailure { Invoke-AgentXBoundedWebRequest -Uri '${baseUrl}/large-declared' -TimeoutSec 2 -MaximumResponseBytes 32 -MaximumRedirection 0 } 'exceeded the 32-byte limit'
Write-Output 'DECLARED_OK'
Assert-BoundedFailure { Invoke-AgentXBoundedWebRequest -Uri '${baseUrl}/large-streamed' -TimeoutSec 2 -MaximumResponseBytes 32 -MaximumRedirection 0 } 'exceeded the 32-byte limit'
Write-Output 'STREAMED_OK'
Assert-BoundedFailure { Invoke-AgentXBoundedWebRequest -Uri '${baseUrl}/redirect' -TimeoutSec 2 -MaximumResponseBytes 32 -MaximumRedirection 0 } 'reject redirects'
Write-Output 'REDIRECT_OK'
$timer = [Diagnostics.Stopwatch]::StartNew()
Assert-BoundedFailure { Invoke-AgentXBoundedWebRequest -Uri '${baseUrl}/slow' -TimeoutSec 1 -MaximumResponseBytes 32 -MaximumRedirection 0 } ''
$timer.Stop()
if ($timer.ElapsedMilliseconds -gt 3000) { throw 'The full-lifecycle deadline was not enforced.' }
Write-Output 'BOUNDS_OK'
`;
  const result = await runPowerShell(source);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /BOUNDS_OK/);
});
