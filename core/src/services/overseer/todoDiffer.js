'use strict';
const fs = require('fs');
const path = require('path');
const { hashTodoContent } = require('./hashUtils');

const TODO_ID_RE = /^(\d{4})-[^/]+\.md$/;

function diffTodos(todoDir, previousHashes) {
  if (!fs.existsSync(todoDir)) return { changed: [], nextHashes: {} };

  const entries = fs.readdirSync(todoDir);
  const changed = [];
  const nextHashes = {};

  for (const entry of entries) {
    const m = entry.match(TODO_ID_RE);
    if (!m) continue;
    const id = m[1];
    const fullPath = path.join(todoDir, entry);
    const content = fs.readFileSync(fullPath, 'utf8');
    const hash = hashTodoContent(content);
    nextHashes[id] = hash;
    if (previousHashes[id] !== hash) {
      changed.push({ id, path: fullPath, content, hash });
    }
  }

  return { changed, nextHashes };
}

module.exports = { diffTodos };
