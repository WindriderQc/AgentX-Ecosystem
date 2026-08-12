'use strict';

/**
 * repoTaskFixtures — loads the repository-repair task fixtures used by the
 * executable coding qualification (task 0452). Each task on disk is:
 *
 *   data/repo-tasks/<dir>/
 *     repo/               a tiny self-contained project with one bounded task
 *       src/...           source and/or tests to repair or extend
 *       test/public.js    the test the candidate is shown; fails pre-patch
 *       test/hidden.js    withheld test; also fails pre-patch
 *     solution.diff       golden reference change (validates the fixture is solvable)
 *     task.json           { id, title, allowedPaths, publicTest, hiddenTest, ... }
 *
 * loadRepoTasks() returns fixture specs shaped for executableRepoGrader.gradeRun:
 * `fixture.fixtureDir` points at the on-disk repo so gradeRun copies it into an
 * isolated scratch root. `solutionDiff` is the reference patch — used to prove a
 * task is well-formed and solvable, and as a sanity anchor in tests. A real
 * qualification run replaces it with each candidate model's produced diff.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_ROOT = path.join(__dirname, '..', '..', '..', 'data', 'repo-tasks');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Fingerprint every task input, including withheld tests and the golden diff. */
function taskFixtureFingerprint(taskDir) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  walk(taskDir);
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(taskDir, file).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Load and normalize every task listed in the manifest. */
function loadRepoTasks(root = DEFAULT_ROOT) {
  const manifest = readJson(path.join(root, 'manifest.json'));
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) {
    throw new Error('repoTaskFixtures: manifest.tasks is empty');
  }
  return manifest.tasks.map((entry) => {
    const taskDir = path.join(root, entry.dir);
    const task = readJson(path.join(taskDir, 'task.json'));
    const repoDir = path.join(taskDir, 'repo');
    const solutionPath = path.join(taskDir, 'solution.diff');

    if (!task.publicTest || !task.publicTest.cmd) {
      throw new Error(`repoTaskFixtures: task ${task.id || entry.dir} is missing publicTest.cmd`);
    }
    if (!fs.existsSync(repoDir)) {
      throw new Error(`repoTaskFixtures: task ${task.id || entry.dir} has no repo/ directory`);
    }

    return {
      id: task.id,
      title: task.title,
      instructions: task.instructions || task.title,
      language: task.language || 'javascript',
      category: entry.category || null,
      fixtureFingerprint: taskFixtureFingerprint(taskDir),
      fixture: {
        fixtureDir: repoDir,
        publicTest: task.publicTest,
        hiddenTest: task.hiddenTest || null,
        regressionTest: task.regressionTest || null,
        allowedPaths: task.allowedPaths || null,
        strip: task.strip
      },
      solutionDiff: fs.readFileSync(solutionPath, 'utf8')
    };
  });
}

module.exports = { loadRepoTasks, taskFixtureFingerprint, DEFAULT_ROOT };
