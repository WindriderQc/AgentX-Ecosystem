#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { listFlags, deleteFlag } = require('../../src/services/overseer/flagStore');

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
    process.stderr.write('usage: ack-flag.js --todo-id <id> [--overseer-dir <path>]\n');
    process.exit(2);
  }
  const overseerDir = args.overseerDir ?? path.resolve(
    __dirname, '../../../TODO/OVERSEER'
  );
  const flagsDir = path.join(overseerDir, 'flags');

  if (!fs.existsSync(flagsDir)) process.exit(0);

  for (const entry of fs.readdirSync(flagsDir)) {
    if (!entry.endsWith('.json')) continue;
    const full = path.join(flagsDir, entry);
    let flag;
    try { flag = JSON.parse(fs.readFileSync(full, 'utf8')); }
    catch (_err) { continue; }
    if (flag.todo_id === args.todoId) deleteFlag(full);
  }
  process.exit(0);
}

main();
