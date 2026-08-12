'use strict';

const { gradeRun, toJsonlLine } = require('../../../src/services/qualification/executableRepoGrader');
const { buildPassAtKReport } = require('../../../src/services/qualification/passAtK');

// --- Fixture: a tiny "sum has a sign bug" repository-repair task -------------
// sum.js returns a - b (the bug). Public + hidden tests fail until it becomes
// a + b. Fixture files and the patches below are kept byte-consistent so
// `git apply -p1` matches context exactly.
const SUM_BUGGY = 'function sum(a, b) {\n  return a - b;\n}\nmodule.exports = sum;\n';
const TEST_PUBLIC = "const sum = require('./sum');\nif (sum(2, 3) !== 5) { process.exit(1); }\nprocess.exit(0);\n";
const TEST_HIDDEN = "const sum = require('./sum');\nif (sum(-1, 1) !== 0 || sum(10, 5) !== 15) { process.exit(1); }\nprocess.exit(0);\n";
// Regression: sum must remain a callable function — green before AND after.
const TEST_REGRESSION = "const sum = require('./sum');\nif (typeof sum !== 'function') { process.exit(1); }\nprocess.exit(0);\n";

function fixture(extra = {}) {
  return {
    files: {
      'sum.js': SUM_BUGGY,
      'test_public.js': TEST_PUBLIC,
      'test_hidden.js': TEST_HIDDEN,
      'test_regression.js': TEST_REGRESSION
    },
    publicTest: { cmd: 'node', args: ['test_public.js'] },
    hiddenTest: { cmd: 'node', args: ['test_hidden.js'] },
    allowedPaths: ['sum.js'],
    ...extra
  };
}

// Correct fix: a - b  ->  a + b, touching only sum.js.
const GOOD_DIFF = [
  '--- a/sum.js',
  '+++ b/sum.js',
  '@@ -1,3 +1,3 @@',
  ' function sum(a, b) {',
  '-  return a - b;',
  '+  return a + b;',
  ' }',
  ''
].join('\n');

// Wrong fix: a - b -> a * b. Applies cleanly but tests fail.
const WRONG_DIFF = [
  '--- a/sum.js',
  '+++ b/sum.js',
  '@@ -1,3 +1,3 @@',
  ' function sum(a, b) {',
  '-  return a - b;',
  '+  return a * b;',
  ' }',
  ''
].join('\n');

// Correct fix to sum.js PLUS an out-of-scope new file.
const OUT_OF_SCOPE_DIFF = [
  '--- a/sum.js',
  '+++ b/sum.js',
  '@@ -1,3 +1,3 @@',
  ' function sum(a, b) {',
  '-  return a - b;',
  '+  return a + b;',
  ' }',
  '--- /dev/null',
  '+++ b/sneaky.txt',
  '@@ -0,0 +1 @@',
  '+gotcha',
  ''
].join('\n');

// Context that does not match the file -> git apply rejects it.
const BROKEN_DIFF = [
  '--- a/sum.js',
  '+++ b/sum.js',
  '@@ -1,3 +1,3 @@',
  ' function NOTFOUND(a, b) {',
  '-  return a - b;',
  '+  return a + b;',
  ' }',
  ''
].join('\n');

describe('executableRepoGrader.gradeRun', () => {
  test('passes when the correct patch fixes public + hidden tests in scope', () => {
    const rec = gradeRun({ fixture: fixture(), diff: GOOD_DIFF, model: 'good', attempt: 1 });
    expect(rec.grade.applied).toBe(true);
    expect(rec.grade.publicPass).toBe(true);
    expect(rec.grade.hiddenPass).toBe(true);
    expect(rec.grade.scopeViolation).toBe(false);
    expect(rec.grade.pass).toBe(true);
    expect(rec.touchedFiles).toEqual(['sum.js']);
    expect(rec.grade.reason).toBe('all_executable_checks_passed');
  });

  test('fails when the patch applies but tests still fail', () => {
    const rec = gradeRun({ fixture: fixture(), diff: WRONG_DIFF, model: 'wrong' });
    expect(rec.grade.applied).toBe(true);
    expect(rec.grade.publicPass).toBe(false);
    expect(rec.grade.pass).toBe(false);
    expect(rec.grade.reason).toMatch(/public_test_failed/);
  });

  test('fails on out-of-scope edits even when the tests pass', () => {
    const rec = gradeRun({ fixture: fixture(), diff: OUT_OF_SCOPE_DIFF, model: 'sneaky' });
    expect(rec.grade.applied).toBe(true);
    expect(rec.grade.publicPass).toBe(true);   // sum.js was fixed correctly
    expect(rec.grade.scopeViolation).toBe(true);
    expect(rec.grade.pass).toBe(false);        // scope violation overrides passing tests
    expect(rec.outOfScope).toContain('sneaky.txt');
    expect(rec.grade.reason).toMatch(/out_of_scope_edits/);
  });

  test('fails (not crashes) when the patch does not apply', () => {
    const rec = gradeRun({ fixture: fixture(), diff: BROKEN_DIFF, model: 'nonapplying' });
    expect(rec.grade.applied).toBe(false);
    expect(rec.grade.pass).toBe(false);
    expect(rec.grade.reason).toMatch(/patch_did_not_apply/);
    expect(rec.touchedFiles).toEqual([]);
  });

  test('empty patch is a failing outcome, not an error', () => {
    const rec = gradeRun({ fixture: fixture(), diff: '', model: 'empty' });
    expect(rec.grade.applied).toBe(false);
    expect(rec.grade.pass).toBe(false);
  });

  test('honours a regression test that must stay green before and after', () => {
    const rec = gradeRun({
      fixture: fixture({ regressionTest: { cmd: 'node', args: ['test_regression.js'] } }),
      diff: GOOD_DIFF,
      model: 'good-with-regression'
    });
    expect(rec.grade.regressionPass).toBe(true);
    expect(rec.grade.pass).toBe(true);
  });

  test('throws only on a malformed fixture (missing publicTest)', () => {
    expect(() => gradeRun({ fixture: { files: {} }, diff: GOOD_DIFF })).toThrow(/publicTest\.cmd is required/);
  });

  test('cleans up its scratch root by default and passes through metadata', () => {
    const rec = gradeRun({ fixture: fixture(), diff: GOOD_DIFF, model: 'm1', attempt: 2, task: 'sum-repair' });
    expect(rec.scratchRoot).toBeNull();
    expect(rec.model).toBe('m1');
    expect(rec.attempt).toBe(2);
    expect(rec.task).toBe('sum-repair');
    expect(typeof rec.durationMs).toBe('number');
  });
});

describe('executableRepoGrader + passAtK integration', () => {
  test('run records aggregate into a per-model pass@k report', () => {
    const runs = [
      gradeRun({ fixture: fixture(), diff: GOOD_DIFF, model: 'candidate', attempt: 1 }),
      gradeRun({ fixture: fixture(), diff: GOOD_DIFF, model: 'candidate', attempt: 2 }),
      gradeRun({ fixture: fixture(), diff: WRONG_DIFF, model: 'candidate', attempt: 3 })
    ];
    // Emitted JSONL round-trips.
    const parsed = runs.map((r) => JSON.parse(toJsonlLine(r)));
    expect(parsed[0].grade.pass).toBe(true);

    const report = buildPassAtKReport(runs, { ks: [1, 3] });
    const row = report.find((r) => r.model === 'candidate');
    expect(row.samples).toBe(3);
    expect(row.correct).toBe(2);
    expect(row.passAtK['pass@1']).toBeCloseTo(2 / 3, 10);
    expect(row.passAtK['pass@3']).toBe(1);
  });
});
