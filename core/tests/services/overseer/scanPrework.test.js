const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '../../../scripts/overseer/scan-prework.js');

function run(env, args) {
  const stdout = execFileSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return JSON.parse(stdout);
}

describe('scan-prework.js', () => {
  let repoDir;
  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-scan-'));
    fs.mkdirSync(path.join(repoDir, 'TODO'));
    fs.mkdirSync(path.join(repoDir, 'overseer/state'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test('first run with two TODOs returns both as changed', () => {
    fs.writeFileSync(path.join(repoDir, 'TODO/0001-foo.md'), 'a');
    fs.writeFileSync(path.join(repoDir, 'TODO/0002-bar.md'), 'b');
    const out = run({}, [
      '--todo-dir', path.join(repoDir, 'TODO'),
      '--overseer-dir', path.join(repoDir, 'overseer')
    ]);
    expect(out.changed.map(c => c.id).sort()).toEqual(['0001', '0002']);
    expect(out.dry_run).toBe(false);
  });

  test('second run with no changes returns empty changed list', () => {
    fs.writeFileSync(path.join(repoDir, 'TODO/0001-foo.md'), 'a');
    const args = [
      '--todo-dir', path.join(repoDir, 'TODO'),
      '--overseer-dir', path.join(repoDir, 'overseer')
    ];
    run({}, args);
    const out2 = run({}, args);
    expect(out2.changed).toEqual([]);
  });

  test('emits a surface_after_due flag when a TODO past surface_after is open', () => {
    fs.writeFileSync(
      path.join(repoDir, 'TODO/0186-soak.md'),
      '---\nsurface_after: 2020-01-01\n---\n\n# soak\n'
    );
    fs.writeFileSync(
      path.join(repoDir, 'TODO/ROADMAP.md'),
      '# Roadmap\n- [ ] `0186` Soak validation\n'
    );
    const out = run({}, [
      '--todo-dir', path.join(repoDir, 'TODO'),
      '--overseer-dir', path.join(repoDir, 'overseer')
    ]);
    expect(Array.isArray(out.surface_after)).toBe(true);
    const row = out.surface_after.find(r => r.todo_id === '0186');
    expect(row).toBeDefined();
    expect(row.action).toBe('emitted');
    const flagFiles = fs.readdirSync(path.join(repoDir, 'overseer/flags'))
      .filter(n => n.endsWith('.json'));
    expect(flagFiles).toHaveLength(1);
    const flag = JSON.parse(
      fs.readFileSync(path.join(repoDir, 'overseer/flags', flagFiles[0]), 'utf8')
    );
    expect(flag.todo_id).toBe('0186');
    expect(flag.concern_kind).toBe('surface_after_due');
  });

  test('OVERSEER_DRY_RUN=1 does not persist state', () => {
    fs.writeFileSync(path.join(repoDir, 'TODO/0001-foo.md'), 'a');
    const args = [
      '--todo-dir', path.join(repoDir, 'TODO'),
      '--overseer-dir', path.join(repoDir, 'overseer')
    ];
    const out = run({ OVERSEER_DRY_RUN: '1' }, args);
    expect(out.dry_run).toBe(true);
    expect(out.changed.map(c => c.id)).toEqual(['0001']);

    const out2 = run({}, args);
    expect(out2.changed.map(c => c.id)).toEqual(['0001']);
  });
});
