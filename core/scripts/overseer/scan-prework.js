#!/usr/bin/env node
'use strict';
const path = require('path');
const { diffTodos } = require('../../src/services/overseer/todoDiffer');
const { loadState, saveState } = require('../../src/services/overseer/stateStore');
const { scanSurfaceAfter } = require('../../src/services/overseer/surfaceAfterScan');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--todo-dir') out.todoDir = argv[++i];
    else if (argv[i] === '--overseer-dir') out.overseerDir = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const todoDir = args.todoDir ?? path.resolve(__dirname, '../../../TODO');
  const overseerDir = args.overseerDir ?? path.resolve(
    __dirname, '../../../TODO/OVERSEER'
  );
  const statePath = path.join(overseerDir, 'state/last-scan.json');
  const dryRun = process.env.OVERSEER_DRY_RUN === '1';

  const state = loadState(statePath);
  const { changed, nextHashes } = diffTodos(todoDir, state.seen_todo_hashes);
  const runNow = new Date();
  const runTs = runNow.toISOString();

  // Surface-after pass: emit a flag for any open TODO whose
  // surface_after frontmatter date has fallen into the past.
  const flagsDir = path.join(overseerDir, 'flags');
  const surfaceAfterResults = scanSurfaceAfter({
    todoDir,
    flagsDir,
    now: runNow,
    dryRun
  });

  if (!dryRun) {
    saveState(statePath, {
      ...state,
      last_prework_ts: runTs,
      seen_todo_hashes: nextHashes
    });
  }

  process.stdout.write(JSON.stringify({
    run_ts: runTs,
    changed,
    surface_after: surfaceAfterResults,
    dry_run: dryRun
  }, null, 2) + '\n');
}

main();
