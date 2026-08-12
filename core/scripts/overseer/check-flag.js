#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { listFlags } = require('../../src/services/overseer/flagStore');
const { isBypassed } = require('../../src/services/overseer/bypassCheck');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--todo-id') out.todoId = argv[++i];
    else if (argv[i] === '--overseer-dir') out.overseerDir = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.todoId) {
    process.stderr.write('usage: check-flag.js --todo-id <id> [--overseer-dir <path>]\n');
    process.exit(2);
  }
  const overseerDir = args.overseerDir ?? path.resolve(
    __dirname, '../../../TODO/OVERSEER'
  );

  if (isBypassed(overseerDir)) {
    process.stdout.write('BYPASS\n');
    process.exit(0);
  }

  const flagsDir = path.join(overseerDir, 'flags');
  const flags = listFlags(flagsDir);
  const found = flags.find(f => f.todo_id === args.todoId);
  if (!found) process.exit(0);

  process.stdout.write(JSON.stringify(found) + '\n');
  process.exit(1);
}

main();
