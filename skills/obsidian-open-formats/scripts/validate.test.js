'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  validateCanvasData,
  validateFile,
  validateMarkdownText,
} = require('./validate');

test('accepts ordinary Markdown and closed frontmatter', () => {
  assert.deepEqual(validateMarkdownText('# Note\n\n[[Related note]]\n'), []);
  assert.deepEqual(validateMarkdownText('---\ntitle: Note\n---\n\n# Note\n'), []);
});

test('rejects unterminated frontmatter and NUL content', () => {
  assert.match(validateMarkdownText('---\ntitle: Note\n')[0], /no closing/);
  assert.match(validateMarkdownText('# Note\0')[0], /NUL/);
});

test('accepts a connected Canvas', () => {
  const canvas = {
    nodes: [
      { id: 'a', type: 'text', x: 0, y: 0, width: 300, height: 120, text: '# A' },
      { id: 'b', type: 'file', x: 400, y: 0, width: 300, height: 200, file: 'B.md' },
    ],
    edges: [{ id: 'a-b', fromNode: 'a', toNode: 'b', toEnd: 'arrow' }],
  };
  assert.deepEqual(validateCanvasData(canvas), []);
});

test('rejects duplicate IDs and dangling Canvas edges', () => {
  const errors = validateCanvasData({
    nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 300, height: 120, text: 'A' }],
    edges: [{ id: 'a', fromNode: 'a', toNode: 'missing' }],
  });
  assert.ok(errors.some((error) => error.includes('duplicates a')));
  assert.ok(errors.some((error) => error.includes('missing node missing')));
});

test('validates files by extension without external dependencies', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-obsidian-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const markdownPath = path.join(directory, 'note.md');
  const canvasPath = path.join(directory, 'map.canvas');
  fs.writeFileSync(markdownPath, '# Valid\n', 'utf8');
  fs.writeFileSync(canvasPath, '{"nodes":[],"edges":[]}', 'utf8');

  assert.deepEqual(validateFile(markdownPath).errors, []);
  assert.deepEqual(validateFile(canvasPath).errors, []);
});
