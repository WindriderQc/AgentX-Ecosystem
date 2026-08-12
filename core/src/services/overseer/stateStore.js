'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_STATE = {
  schema_version: 1,
  last_prework_ts: null,
  last_holistic_ts: null,
  seen_todo_hashes: {}
};

function loadState(filePath) {
  if (!fs.existsSync(filePath)) return { ...DEFAULT_STATE };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return { ...DEFAULT_STATE };
  }
  if (!parsed || parsed.schema_version !== 1) return { ...DEFAULT_STATE };
  return {
    schema_version: 1,
    last_prework_ts: parsed.last_prework_ts ?? null,
    last_holistic_ts: parsed.last_holistic_ts ?? null,
    seen_todo_hashes: parsed.seen_todo_hashes ?? {}
  };
}

function saveState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, filePath + '.bak');
  }
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n');
}

module.exports = { loadState, saveState, DEFAULT_STATE };
