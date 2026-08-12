const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '../../../scripts/overseer/ack-flag.js');

function runAck(args) {
  try {
    execFileSync('node', [SCRIPT, ...args]);
    return 0;
  } catch (err) {
    return err.status;
  }
}

describe('ack-flag.js', () => {
  let overseerDir;
  beforeEach(() => {
    overseerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-ack-'));
    fs.mkdirSync(path.join(overseerDir, 'flags'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(overseerDir, { recursive: true, force: true });
  });

  test('deletes matching flag file', () => {
    const flag = {
      todo_id: '0001', severity: 'concern', summary: 's', details: 'd',
      related_todos: [], suggested_action: 'refresh',
      created_at: '2026-04-20T00:00:00Z'
    };
    const p = path.join(overseerDir, 'flags/2026-04-20-0001.json');
    fs.writeFileSync(p, JSON.stringify(flag));
    const rc = runAck(['--todo-id', '0001', '--overseer-dir', overseerDir]);
    expect(rc).toBe(0);
    expect(fs.existsSync(p)).toBe(false);
  });

  test('exits 0 even if no flag exists (idempotent)', () => {
    const rc = runAck(['--todo-id', '0999', '--overseer-dir', overseerDir]);
    expect(rc).toBe(0);
  });

  test('does not touch flags for other todos', () => {
    const other = {
      todo_id: '0002', severity: 'concern', summary: 's', details: 'd',
      related_todos: [], suggested_action: 'refresh',
      created_at: '2026-04-20T00:00:00Z'
    };
    const pOther = path.join(overseerDir, 'flags/2026-04-20-0002.json');
    fs.writeFileSync(pOther, JSON.stringify(other));
    runAck(['--todo-id', '0001', '--overseer-dir', overseerDir]);
    expect(fs.existsSync(pOther)).toBe(true);
  });
});
