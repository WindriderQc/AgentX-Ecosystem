'use strict';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const SURFACE_AFTER_RE = /^surface_after:\s*(\S+)\s*$/m;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parse the surface_after value out of a TODO file's YAML frontmatter.
 * Returns a JS Date (UTC) on success, or null when:
 *   - no frontmatter block,
 *   - no surface_after key,
 *   - value does not match an accepted format (date-only or RFC3339).
 *
 * Date-only values are interpreted as midnight UTC.
 */
function parseSurfaceAfter(content) {
  if (typeof content !== 'string' || content.length === 0) return null;
  const fm = content.match(FRONTMATTER_RE);
  if (!fm) return null;
  const block = fm[1];
  const m = block.match(SURFACE_AFTER_RE);
  if (!m) return null;
  let raw = m[1].trim();
  // Strip surrounding quotes if present.
  if ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1);
  }
  if (DATE_ONLY_RE.test(raw)) {
    const ts = Date.parse(`${raw}T00:00:00Z`);
    if (!Number.isFinite(ts)) return null;
    return new Date(ts);
  }
  if (RFC3339_RE.test(raw)) {
    const ts = Date.parse(raw);
    if (!Number.isFinite(ts)) return null;
    return new Date(ts);
  }
  return null;
}

/**
 * Returns true when the given TODO id is still open (`- [ ]`) in ROADMAP.md.
 * Returns false when it's closed (`- [x]` / `- [X]`) or the id can't be found.
 *
 * The check is line-oriented and tolerant of variations in the line
 * surrounding the checkbox (e.g. backticked id, plain id, optional bullet).
 */
function isTodoOpenInRoadmap(roadmapContent, todoId) {
  if (typeof roadmapContent !== 'string' || !todoId) return false;
  const idEsc = todoId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match a line that has either `[ ]` or `[x]` and references the id.
  const lineRe = new RegExp(
    `^[\\s\\-*]*\\[( |x|X)\\][^\\n]*\\b${idEsc}\\b`,
    'm'
  );
  const m = roadmapContent.match(lineRe);
  if (!m) return false;
  return m[1] === ' ';
}

module.exports = { parseSurfaceAfter, isTodoOpenInRoadmap };
