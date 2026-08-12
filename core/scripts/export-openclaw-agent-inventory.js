#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const {
  buildInventoryFromState,
  buildOpenClawAgentInventory,
  collectRemoteOpenClawState,
} = require('../src/services/openclawAgentInventoryService');

function usage() {
  console.log(`Usage: node core/scripts/export-openclaw-agent-inventory.js [options]

Options:
  --output <path>              Write output to a file instead of stdout
  --format <yaml|json>         Output format (default: yaml)
  --openclaw-home <path>       Local OpenClaw home (default: OPENCLAW_HOME or ~/.openclaw)
  --config-path <path>         Local openclaw.json path
  --ssh <user@host>            Collect read-only state from a remote OpenClaw host over ssh
  --remote-openclaw-home <p>   Remote OpenClaw home (default: /home/agentx/.openclaw)
  --include-content            Include bounded, redacted prompt/MEMORY.md content
  --include-runtime-status     Include openclaw status --json --all where available
  --no-cli                     Local mode only: skip openclaw CLI probes
  --help                       Show this help
`);
}

function parseArgs(argv) {
  const opts = {
    format: 'yaml',
    includeContent: false,
    includeRuntimeStatus: false,
    useCli: true,
    remoteOpenClawHome: '/home/agentx/.openclaw',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--output') {
      opts.output = argv[++i];
    } else if (arg === '--format') {
      opts.format = argv[++i];
    } else if (arg === '--openclaw-home') {
      opts.openclawHome = argv[++i];
    } else if (arg === '--config-path') {
      opts.configPath = argv[++i];
    } else if (arg === '--ssh') {
      opts.ssh = argv[++i];
    } else if (arg === '--remote-openclaw-home') {
      opts.remoteOpenClawHome = argv[++i];
    } else if (arg === '--include-content') {
      opts.includeContent = true;
    } else if (arg === '--include-runtime-status') {
      opts.includeRuntimeStatus = true;
    } else if (arg === '--no-cli') {
      opts.useCli = false;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['yaml', 'json'].includes(opts.format)) {
    throw new Error(`Unsupported format: ${opts.format}`);
  }
  return opts;
}

function render(inventory, format) {
  if (format === 'json') return `${JSON.stringify(inventory, null, 2)}\n`;
  return yaml.dump(inventory, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }

  const inventory = opts.ssh
    ? await buildInventoryFromState(await collectRemoteOpenClawState({
      ...opts,
      sshTarget: opts.ssh,
    }), opts)
    : await buildOpenClawAgentInventory(opts);

  const output = render(inventory, opts.format);
  if (opts.output) {
    fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
    fs.writeFileSync(opts.output, output);
    console.log(`Wrote ${opts.output}`);
  } else {
    process.stdout.write(output);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
