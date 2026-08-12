#!/usr/bin/env node
/**
 * sync-agent-prompts.js — keep live OpenClaw agent prompts in step with the
 * canonical role docs in this repo (roles/ + config/agent-registry.yml).
 *
 * Read-only by default: it reports drift and exits non-zero, which makes it
 * safe to wire into a cron or CI check. Writing requires an explicit --apply,
 * and every write is preceded by a timestamped backup on the remote host.
 * Only the tool's own managed block is replaced (see agentPromptSyncService);
 * hand-written workspace content is preserved.
 *
 * Usage:
 *   node core/scripts/sync-agent-prompts.js --ssh yb@192.0.2.66
 *   node core/scripts/sync-agent-prompts.js --ssh yb@192.0.2.66 --apply
 *   node core/scripts/sync-agent-prompts.js --local /home/agentx/.openclaw --agent main
 *
 * Options:
 *   --ssh <user@host>     Reach the OpenClaw host over ssh (BatchMode, key-based)
 *   --local <home>        Operate on a local .openclaw home instead (dev/testing)
 *   --apply               Write changes (default is check-only)
 *   --agent <id>          Restrict to one agent; repeatable
 *   --prompt-file <name>  Target file inside each workspace (default AGENTS.md)
 *   --openclaw-home <dir> Remote OpenClaw home (default /home/agentx/.openclaw)
 *   --json                Machine-readable output
 *
 * Exit codes: 0 = everything in sync (or applied), 1 = drift found in check
 * mode, 2 = a real error (unreachable host, unreadable role doc, bad registry).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const {
  STATE,
  DEFAULT_PROMPT_FILE,
  DEFAULT_OPENCLAW_HOME,
  diagnose,
  upsertManagedBlock,
  resolveOpenclawAgents,
  summarize
} = require('../src/services/agentPromptSyncService');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MISSING_SENTINEL = '__AGENTX_PROMPT_FILE_MISSING__';

function parseArgs(argv) {
  const opts = {
    ssh: null,
    local: null,
    apply: false,
    agents: [],
    promptFile: DEFAULT_PROMPT_FILE,
    openclawHome: DEFAULT_OPENCLAW_HOME,
    json: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ssh') opts.ssh = argv[++i];
    else if (arg === '--local') opts.local = argv[++i];
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--agent') opts.agents.push(argv[++i]);
    else if (arg === '--prompt-file') opts.promptFile = argv[++i];
    else if (arg === '--openclaw-home') opts.openclawHome = argv[++i];
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (opts.local) opts.openclawHome = opts.local;
  return opts;
}

function sshArgs(target, command) {
  const strict = process.env.OPENCLAW_INVENTORY_SSH_STRICT_HOST_KEY_CHECKING || 'no';
  const args = ['-o', 'BatchMode=yes', '-o', `StrictHostKeyChecking=${strict}`];
  if (strict === 'no') args.push('-o', 'UserKnownHostsFile=/dev/null');
  const port = process.env.OPENCLAW_INVENTORY_SSH_PORT;
  if (port) args.push('-p', String(port));
  const keyPath = process.env.OPENCLAW_INVENTORY_SSH_KEY_PATH || process.env.OLLAMA_SSH_KEY_PATH;
  if (keyPath) args.push('-i', String(keyPath));
  args.push(target, command);
  return args;
}

function runRemote(target, command) {
  return execFileSync('ssh', sshArgs(target, command), {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

/** Read a prompt file; returns null when it does not exist. */
function readTarget(opts, targetPath) {
  if (opts.ssh) {
    const quoted = `'${targetPath.replace(/'/g, `'\\''`)}'`;
    const out = runRemote(opts.ssh, `if [ -f ${quoted} ]; then cat ${quoted}; else echo ${MISSING_SENTINEL}; fi`);
    if (out.trim() === MISSING_SENTINEL) return null;
    return out;
  }
  if (!fs.existsSync(targetPath)) return null;
  return fs.readFileSync(targetPath, 'utf8');
}

/** Write a prompt file, backing up the previous contents first. */
function writeTarget(opts, targetPath, contents) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${targetPath}.bak-${stamp}`;
  if (opts.ssh) {
    const quoted = `'${targetPath.replace(/'/g, `'\\''`)}'`;
    const quotedBackup = `'${backupPath.replace(/'/g, `'\\''`)}'`;
    // base64 keeps arbitrary markdown (quotes, backticks, $) intact over ssh.
    const payload = Buffer.from(contents, 'utf8').toString('base64');
    runRemote(
      opts.ssh,
      `if [ -f ${quoted} ]; then cp ${quoted} ${quotedBackup}; fi; ` +
      `mkdir -p "$(dirname ${quoted})" && echo ${payload} | base64 -d > ${quoted}`
    );
    return backupPath;
  }
  if (fs.existsSync(targetPath)) fs.copyFileSync(targetPath, backupPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, contents, 'utf8');
  return backupPath;
}

function loadRegistry() {
  const registryPath = path.join(REPO_ROOT, 'config', 'agent-registry.yml');
  if (!fs.existsSync(registryPath)) {
    throw new Error(`agent registry not found at ${registryPath}`);
  }
  return yaml.load(fs.readFileSync(registryPath, 'utf8'));
}

function loadRoleDoc(relativePath) {
  const abs = path.join(REPO_ROOT, relativePath);
  if (!fs.existsSync(abs)) throw new Error(`role doc missing: ${relativePath}`);
  return fs.readFileSync(abs, 'utf8');
}

const LABEL = {
  [STATE.IN_SYNC]: 'in sync',
  [STATE.DRIFTED]: 'DRIFTED',
  [STATE.NOT_INSTALLED]: 'NOT INSTALLED',
  [STATE.MISSING_TARGET]: 'MISSING TARGET FILE'
};

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  if (opts.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
    process.exit(0);
  }
  if (!opts.ssh && !opts.local) {
    console.error('Specify --ssh <user@host> (live OpenClaw host) or --local <openclaw home>.');
    process.exit(2);
  }

  let agents;
  try {
    agents = resolveOpenclawAgents(loadRegistry(), {
      only: opts.agents,
      openclawHome: opts.openclawHome,
      promptFile: opts.promptFile
    });
  } catch (err) {
    console.error(`Failed to resolve agents: ${err.message}`);
    process.exit(2);
  }

  if (!agents.length) {
    console.error('No OpenClaw agents with role docs matched.');
    process.exit(2);
  }

  const results = [];
  try {
    for (const agent of agents) {
      const liveText = readTarget(opts, agent.targetPath);
      let working = liveText === null ? '' : liveText;
      const docs = [];
      let changed = false;

      for (const source of agent.roleDocs) {
        const canonical = loadRoleDoc(source);
        const verdict = diagnose(source, canonical, liveText);
        docs.push(verdict);
        if (verdict.state !== STATE.IN_SYNC) {
          changed = true;
          if (opts.apply) working = upsertManagedBlock(working, source, canonical);
        }
      }

      let backupPath = null;
      if (opts.apply && changed) {
        backupPath = writeTarget(opts, agent.targetPath, working);
      }

      results.push({
        agent: agent.openclawId,
        registryId: agent.registryId,
        persona: agent.persona,
        targetPath: agent.targetPath,
        targetExisted: liveText !== null,
        applied: Boolean(opts.apply && changed),
        backupPath,
        docs
      });
    }
  } catch (err) {
    console.error(`Sync failed: ${err.message}`);
    process.exit(2);
  }

  const summary = summarize(results);

  if (opts.json) {
    console.log(JSON.stringify({ mode: opts.apply ? 'apply' : 'check', summary, agents: results }, null, 2));
  } else {
    const where = opts.ssh ? `ssh ${opts.ssh}` : `local ${opts.openclawHome}`;
    console.log(`Agent prompt sync (${opts.apply ? 'APPLY' : 'check'}) via ${where}\n`);
    for (const result of results) {
      const applied = result.applied ? '  [applied]' : '';
      console.log(`${result.agent}${result.persona ? ` (${result.persona})` : ''} -> ${result.targetPath}${applied}`);
      if (!result.targetExisted) console.log('  ! target file does not exist on the host');
      for (const doc of result.docs) {
        console.log(`  ${String(LABEL[doc.state]).padEnd(20)} ${doc.source}`);
      }
      if (result.backupPath) console.log(`  backup: ${result.backupPath}`);
      console.log('');
    }
    if (opts.apply) {
      console.log(summary.clean ? 'Nothing to apply — already in sync.' : 'Applied. Reload the agents so they re-read their prompts.');
    } else if (summary.clean) {
      console.log('All canonical role docs are in sync with the live prompts.');
    } else {
      console.log(`${summary.outOfSync} doc(s) out of sync. Re-run with --apply to push them, then reload the agents.`);
    }
  }

  process.exit(!opts.apply && !summary.clean ? 1 : 0);
}

if (require.main === module) main();

module.exports = { parseArgs, sshArgs };
