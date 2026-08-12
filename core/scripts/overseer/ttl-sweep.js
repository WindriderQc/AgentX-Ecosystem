#!/usr/bin/env node
'use strict';
const path = require('path');
const { sweepStaleFlags } = require('../../src/services/overseer/flagStore');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--overseer-dir') out.overseerDir = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const overseerDir = args.overseerDir ?? path.resolve(
    __dirname, '../../../TODO/OVERSEER'
  );
  const moved = sweepStaleFlags(path.join(overseerDir, 'flags'), new Date());
  process.stdout.write(JSON.stringify({ moved }) + '\n');
}

main();
