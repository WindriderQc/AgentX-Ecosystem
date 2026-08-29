'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

describe('frozen Planning reference semantics', () => {
  test('does not score empty Pipeline coverage as 100 percent', () => {
    const source = read('core/public/js/planning.js');

    expect(source).toContain('const coverage = activeTasks ?');
    expect(source).toContain(': null;');
    expect(source).toContain("coverage == null ? '—' : `${coverage}%`");
    expect(source).toContain('No open Pipeline tasks; coverage is not scored');
  });

  test('labels saved status, progress, and linkage as historical references', () => {
    const appSource = read('core/public/js/planning.js');
    const editorSource = read('core/public/js/planning-editor.js');

    expect(appSource).toContain('Recorded ${label}');
    expect(appSource).toContain('${progress}% recorded');
    expect(appSource).toContain('This percentage is not a current execution signal');
    expect(appSource).toContain('Historical references only; Pipeline owns execution');
    expect(editorSource).toContain('Historical Planning record.');
    expect(editorSource).toContain('Even 100% is not current execution.');
    expect(editorSource).toContain('Pipeline references');
    expect(editorSource).toContain('Current Pipeline state:');
  });

  test('keeps frozen record details read-only except for explicit correction', () => {
    const source = read('core/public/js/planning-editor.js');

    expect(source).toContain("if (app().isFrozenReference()) return '';");
    expect(source).toContain("${frozen ? 'Correct record' : 'Edit'}");
    expect(source).toContain("${frozen ? '' : `<div class=\"planning-inline-form\">");
    expect(source).toContain("${frozen ? '' : `<form class=\"planning-evidence-form\"");
  });
});
