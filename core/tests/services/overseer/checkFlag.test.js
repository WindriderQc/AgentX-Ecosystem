const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '../../../scripts/overseer/check-flag.js');

function runCheck(args) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout?.toString() ?? '' };
  }
}

describe('check-flag.js', () => {
  let overseerDir;
  beforeEach(() => {
    overseerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-check-'));
    fs.mkdirSync(path.join(overseerDir, 'flags'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(overseerDir, { recursive: true, force: true });
  });

  test('exits 0 with empty stdout when no flag exists', () => {
    const r = runCheck(['--todo-id', '0001', '--overseer-dir', overseerDir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  test('exits 1 with flag JSON when flag exists', () => {
    const flag = {
      todo_id: '0001', severity: 'concern', summary: 's', details: 'd',
      related_todos: [], suggested_action: 'refresh',
      created_at: '2026-04-20T00:00:00Z'
    };
    fs.writeFileSync(
      path.join(overseerDir, 'flags/2026-04-20-0001.json'),
      JSON.stringify(flag)
    );
    const r = runCheck(['--todo-id', '0001', '--overseer-dir', overseerDir]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual(flag);
  });

  test('exits 0 and prints BYPASS when bypass marker is present', () => {
    fs.writeFileSync(path.join(overseerDir, '.overseer-bypass'), '');
    const flag = {
      todo_id: '0001', severity: 'concern', summary: 's', details: 'd',
      related_todos: [], suggested_action: 'refresh',
      created_at: '2026-04-20T00:00:00Z'
    };
    fs.writeFileSync(
      path.join(overseerDir, 'flags/2026-04-20-0001.json'),
      JSON.stringify(flag)
    );
    const r = runCheck(['--todo-id', '0001', '--overseer-dir', overseerDir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('BYPASS');
  });

  test('exits 0 when flag file is malformed (fail-open)', () => {
    fs.writeFileSync(path.join(overseerDir, 'flags/2026-04-20-0001.json'), '{broken');
    const r = runCheck(['--todo-id', '0001', '--overseer-dir', overseerDir]);
    expect(r.exitCode).toBe(0);
  });
});
