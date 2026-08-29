'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Compose uses a separate persistent recovery volume and scopes the token to Core and RAG', () => {
  const compose = read('docker-compose.yml');
  const core = compose.slice(compose.indexOf('\n  core:'), compose.indexOf('\n  benchmark:'));
  const rag = compose.slice(compose.indexOf('\n  rag:'), compose.indexOf('\nvolumes:'));
  const benchmark = compose.slice(compose.indexOf('\n  benchmark:'), compose.indexOf('\n  rag:'));

  assert.match(core, /BACKUP_DIR:\s*\/backups/);
  assert.match(core, /BACKUP_CONFIG_ROOT:\s*\/app\/product-config/);
  assert.match(core, /- recovery_data:\/backups/);
  assert.match(core, /AGENTX_RECOVERY_TOKEN:/);
  assert.match(rag, /AGENTX_RECOVERY_TOKEN:/);
  assert.doesNotMatch(benchmark, /AGENTX_RECOVERY_TOKEN/);
  assert.equal((compose.match(/^\s+AGENTX_RECOVERY_TOKEN:/gm) || []).length, 2);
  assert.match(compose, /recovery_data:\s*\r?\n\s+name: agentx_ecosystem_recovery_data/);
  assert.doesNotMatch(compose, /(?:^|\n)\s*-\s*(?:\.\/|\/|[A-Za-z]:\\).*:\/backups/);
});

test('Core image packages only the supported secret-free recovery sources', () => {
  const dockerfile = read('docker/core.Dockerfile');
  assert.match(dockerfile, /COPY docker-compose\.yml docker-compose\.ollama\.yml \/app\/product-config\//);
  assert.match(dockerfile, /COPY config\/agentx\.env config\/rag-ingestion-policy\.json config\/product-surfaces\.json config\/adapter-consumer-contracts\.json config\/container-image-pins\.json \/app\/product-config\/config\//);
  assert.doesNotMatch(dockerfile, /COPY\s+(?:\.env|config\/secrets|data\/)/i);

  const service = read('core/src/services/backupService.js');
  for (const source of [
    'docker-compose.yml',
    'docker-compose.ollama.yml',
    'config/agentx.env',
    'config/rag-ingestion-policy.json',
    'config/product-surfaces.json',
    'config/adapter-consumer-contracts.json',
    'config/container-image-pins.json'
  ]) assert.match(service, new RegExp(`'${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  assert.doesNotMatch(service, /BACKUP_RUNTIME_ENV_FILE|crontab\s*',\s*\['-l'\]|config\/secrets\.json|(?:^|\s)'\.env'/m);
});

test('both launchers reuse or create the scoped token and preserve recovery data on ordinary down', () => {
  const bash = read('agentx');
  const powershell = read('agentx.ps1');
  const confirmation = 'delete agentx-ecosystem data and recovery archives';

  assert.match(bash, /ensure_recovery_token\(\)/);
  assert.match(bash, /agentx-ecosystem-core agentx-ecosystem-rag/);
  assert.match(bash, /AGENTX_RECOVERY_TOKEN="\$\(od -An -N32 -tx1 \/dev\/urandom/);
  assert.ok((bash.match(/ensure_recovery_token/g) || []).length >= 4);
  assert.match(powershell, /function Ensure-RecoveryToken/);
  assert.match(powershell, /agentx-ecosystem-core', 'agentx-ecosystem-rag/);
  assert.match(powershell, /\$bytes = New-Object byte\[\] 32/);
  assert.ok((powershell.match(/Ensure-RecoveryToken/g) || []).length >= 4);
  assert.match(bash, new RegExp(confirmation));
  assert.match(powershell, new RegExp(confirmation));

  const bashDown = bash.slice(bash.indexOf('  down)'), bash.indexOf('  status|ps)'));
  const psDown = powershell.slice(powershell.indexOf("    'down' {"), powershell.indexOf("    { $_ -in 'status'"));
  assert.doesNotMatch(bashDown, /--volumes|-v(?:\s|$)/);
  assert.doesNotMatch(psDown, /--volumes|-v(?:\s|$)/);
});

test('portable recovery bundles and partial publications cannot be committed accidentally', () => {
  const gitignore = read('.gitignore');
  assert.match(gitignore, /^agentx-recovery-v1-\*\/$/m);
  assert.match(gitignore, /^\.agentx-recovery-partial-\*\/$/m);
  assert.match(gitignore, /^recovery-drill-receipt\*\.json$/m);
  assert.match(gitignore, /^\.agentx-recovery-receipt-partial-\*$/m);
});
