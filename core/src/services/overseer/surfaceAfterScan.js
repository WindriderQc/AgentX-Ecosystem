'use strict';

const fs = require('fs');
const path = require('path');
const { parseSurfaceAfter, isTodoOpenInRoadmap } = require('./surfaceAfter');
const { listFlags, writeFlag } = require('./flagStore');

const TODO_ID_RE = /^(\d{4})-[^/]+\.md$/;
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Scan TODOs for past-due `surface_after:` frontmatter and emit one flag per
 * past-due, still-open TODO that hasn't been flagged in the last 24h.
 *
 * Inputs:
 *   - todoDir: path containing TODO/XXXX-*.md files (and ROADMAP.md sibling
 *     OR roadmapPath explicitly).
 *   - flagsDir: where flag JSONs live.
 *   - now: optional current Date (defaults to new Date()).
 *   - roadmapPath: optional override; defaults to <todoDir>/ROADMAP.md.
 *   - dryRun: when true, do not write flags. Returns the would-be flags.
 *
 * Returns an array of `{ todo_id, action, filepath?, flag }` records describing
 * what the scan did (`action` is one of `emitted`, `skipped:closed`,
 * `skipped:future`, `skipped:no-field`, `skipped:duplicate`).
 */
function scanSurfaceAfter({
  todoDir,
  flagsDir,
  now = new Date(),
  roadmapPath = null,
  dryRun = false
} = {}) {
  if (!todoDir || !flagsDir) {
    throw new Error('scanSurfaceAfter: todoDir and flagsDir are required');
  }
  const results = [];
  if (!fs.existsSync(todoDir)) return results;

  const roadmapFile = roadmapPath ?? path.join(todoDir, 'ROADMAP.md');
  const roadmapContent = fs.existsSync(roadmapFile)
    ? fs.readFileSync(roadmapFile, 'utf8')
    : '';

  const existingFlags = listFlags(flagsDir);
  const nowMs = now.getTime();

  const entries = fs.readdirSync(todoDir);
  for (const entry of entries) {
    const m = entry.match(TODO_ID_RE);
    if (!m) continue;
    const todoId = m[1];
    const fullPath = path.join(todoDir, entry);
    const content = fs.readFileSync(fullPath, 'utf8');
    const surfaceAt = parseSurfaceAfter(content);
    if (!surfaceAt) {
      continue; // No field — silently skip; surface_after is opt-in.
    }
    if (surfaceAt.getTime() > nowMs) {
      results.push({ todo_id: todoId, action: 'skipped:future' });
      continue;
    }
    if (!isTodoOpenInRoadmap(roadmapContent, todoId)) {
      results.push({ todo_id: todoId, action: 'skipped:closed' });
      continue;
    }
    // Dedup: any existing surface_after_due flag for this todo with
    // created_at within the last 24h?
    const dup = existingFlags.find(f => {
      if (f.todo_id !== todoId) return false;
      if (f.concern_kind !== 'surface_after_due') return false;
      const createdMs = Date.parse(f.created_at);
      if (!Number.isFinite(createdMs)) return false;
      return (nowMs - createdMs) < DEDUP_WINDOW_MS;
    });
    if (dup) {
      results.push({ todo_id: todoId, action: 'skipped:duplicate' });
      continue;
    }
    const isoNow = now.toISOString();
    const surfaceIso = surfaceAt.toISOString();
    const flag = {
      todo_id: todoId,
      severity: 'concern',
      summary: 'TODO past surface_after date — ready to dispatch',
      details: `${path.relative(path.dirname(todoDir), fullPath) || entry} ` +
        `has surface_after: ${surfaceIso.slice(0, 10)}; current UTC date is ` +
        `${isoNow.slice(0, 10)}. TODO is still open. Operator may now dispatch.`,
      concern_kind: 'surface_after_due',
      related_todos: [],
      suggested_action: 'dispatch',
      created_at: isoNow
    };
    if (dryRun) {
      results.push({ todo_id: todoId, action: 'emitted', flag, filepath: null });
      continue;
    }
    const filepath = writeFlag(flagsDir, flag);
    results.push({ todo_id: todoId, action: 'emitted', flag, filepath });
  }
  return results;
}

module.exports = { scanSurfaceAfter, DEDUP_WINDOW_MS };
