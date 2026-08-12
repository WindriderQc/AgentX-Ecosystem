'use strict';
const fs = require('fs');
const path = require('path');

const VALID_SEVERITIES = new Set(['concern', 'conflict', 'drift']);
const VALID_ACTIONS = new Set(['merge', 'refresh', 'defer', 'reject', 'dispatch']);
const VALID_CONCERN_KINDS = new Set(['surface_after_due']);
const PROPOSAL_SOFT_CAP = 20;
const TTL_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function validateFlag(flag) {
  const required = ['todo_id', 'severity', 'summary', 'details', 'suggested_action', 'created_at'];
  for (const k of required) {
    if (flag[k] === undefined || flag[k] === null || flag[k] === '') {
      throw new Error(`flag missing required field: ${k}`);
    }
  }
  if (!VALID_SEVERITIES.has(flag.severity)) {
    throw new Error(`invalid severity: ${flag.severity}`);
  }
  if (!VALID_ACTIONS.has(flag.suggested_action)) {
    throw new Error(`invalid suggested_action: ${flag.suggested_action}`);
  }
  if (flag.concern_kind !== undefined && flag.concern_kind !== null
      && !VALID_CONCERN_KINDS.has(flag.concern_kind)) {
    throw new Error(`invalid concern_kind: ${flag.concern_kind}`);
  }
}

function flagFilename(flag) {
  const date = flag.created_at.slice(0, 10);
  return `${date}-${flag.todo_id}.json`;
}

function writeFlag(flagsDir, flag) {
  validateFlag(flag);
  if (!flag.related_todos) flag.related_todos = [];
  fs.mkdirSync(flagsDir, { recursive: true });
  const filepath = path.join(flagsDir, flagFilename(flag));
  fs.writeFileSync(filepath, JSON.stringify(flag, null, 2) + '\n');
  return filepath;
}

function readFlag(filepath) {
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

function listFlags(flagsDir) {
  if (!fs.existsSync(flagsDir)) return [];
  const entries = fs.readdirSync(flagsDir, { withFileTypes: true });
  const flags = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    try {
      flags.push(readFlag(path.join(flagsDir, e.name)));
    } catch (_err) { /* skip malformed */ }
  }
  return flags;
}

function deleteFlag(filepath) {
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
}

function sweepStaleFlags(flagsDir, nowDate = new Date()) {
  if (!fs.existsSync(flagsDir)) return [];
  const staleDir = path.join(flagsDir, 'stale');
  fs.mkdirSync(staleDir, { recursive: true });
  const cutoffMs = nowDate.getTime() - TTL_DAYS * MS_PER_DAY;
  const moved = [];

  for (const entry of fs.readdirSync(flagsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const src = path.join(flagsDir, entry.name);
    let flag;
    try { flag = JSON.parse(fs.readFileSync(src, 'utf8')); }
    catch (_err) { continue; }
    const createdMs = Date.parse(flag.created_at);
    if (Number.isFinite(createdMs) && createdMs < cutoffMs) {
      fs.renameSync(src, path.join(staleDir, entry.name));
      moved.push(flag.todo_id);
    }
  }
  return moved;
}

module.exports = {
  writeFlag, readFlag, listFlags, deleteFlag,
  sweepStaleFlags,
  PROPOSAL_SOFT_CAP, TTL_DAYS,
  VALID_CONCERN_KINDS
};
