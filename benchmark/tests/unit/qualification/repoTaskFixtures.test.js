'use strict';

const fs = require('fs');
const { loadRepoTasks } = require('../../../src/services/qualification/repoTaskFixtures');
const {
  gradeRun,
  materializeFixture,
  runCommand
} = require('../../../src/services/qualification/executableRepoGrader');
const { makeScratchRoot } = require('../../../src/services/qualification/calibrationProbes');
const { buildPassAtKReport } = require('../../../src/services/qualification/passAtK');

const tasks = loadRepoTasks();

describe('repoTaskFixtures manifest', () => {
  test('loads thirteen tasks with unique ids and representative categories', () => {
    expect(tasks).toHaveLength(13);
    const ids = tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(13);
    for (const t of tasks) {
      expect(t.fixture.fixtureDir).toBeTruthy();
      expect(t.fixtureFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(t.fixture.publicTest.cmd).toBe('node');
      expect(t.fixture.hiddenTest).toBeTruthy();
      expect(Array.isArray(t.fixture.allowedPaths)).toBe(true);
      expect(t.instructions).toBeTruthy();
      expect(t.solutionDiff).toMatch(/^--- a\//m);
    }
    const categories = new Set(tasks.map((t) => t.category));
    for (const category of [
      'feature', 'async-error-handling', 'api-preserving-refactor',
      'multi-file-feature', 'validation-edge-cases', 'test-repair',
      'concurrency-refactor'
    ]) expect(categories.has(category)).toBe(true);
  });
});

describe.each(tasks.map((t) => [t.id, t]))('repo task: %s', (_id, task) => {
  test('the planted bug makes the public test fail pre-patch', () => {
    // Materialize the untouched fixture and run its public test directly.
    const root = makeScratchRoot('fixture-baseline-');
    try {
      materializeFixture(root, { fixtureDir: task.fixture.fixtureDir });
      const res = runCommand(root, task.fixture.publicTest, 15_000);
      expect(res.ran).toBe(true);
      expect(res.pass).toBe(false); // bug is real: unpatched repo fails
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('the golden solution diff passes public + hidden tests in scope', () => {
    const rec = gradeRun({ fixture: task.fixture, diff: task.solutionDiff, model: 'golden', task: task.id });
    expect(rec.grade.applied).toBe(true);
    expect(rec.grade.publicPass).toBe(true);
    expect(rec.grade.hiddenPass).toBe(true);
    expect(rec.grade.scopeViolation).toBe(false);
    expect(rec.grade.pass).toBe(true);
    // The golden fix touches only files the task declares as editable.
    for (const touched of rec.touchedFiles) {
      expect(task.fixture.allowedPaths).toContain(touched);
    }
  });

  test('an empty patch is graded as a failure (no fix)', () => {
    const rec = gradeRun({ fixture: task.fixture, diff: '', model: 'no-op', task: task.id });
    expect(rec.grade.pass).toBe(false);
  });
});

describe('full-set qualification harness (golden run)', () => {
  test('grading every task with its golden diff yields pass@1 = 1.0', () => {
    const runs = tasks.map((t) =>
      gradeRun({ fixture: t.fixture, diff: t.solutionDiff, model: 'golden', task: t.id })
    );
    expect(runs.every((r) => r.grade.pass)).toBe(true);
    const report = buildPassAtKReport(runs, { ks: [1] });
    const golden = report.find((r) => r.model === 'golden');
    expect(golden.samples).toBe(13);
    expect(golden.correct).toBe(13);
    expect(golden.passAtK['pass@1']).toBe(1);
  });
});
