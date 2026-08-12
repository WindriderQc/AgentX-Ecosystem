const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '../../../scripts/overseer/ttl-sweep.js');

describe('ttl-sweep.js', () => {
  let overseerDir;
  beforeEach(() => {
    overseerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-ttl-'));
    fs.mkdirSync(path.join(overseerDir, 'flags/stale'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(overseerDir, { recursive: true, force: true });
  });

  test('moves flags older than 7 days into stale/', () => {
    const old = {
      todo_id: '0002', severity: 'concern', summary: 's', details: 'd',
      related_todos: [], suggested_action: 'refresh',
      created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    };
    fs.writeFileSync(
      path.join(overseerDir, `flags/${old.created_at.slice(0,10)}-0002.json`),
      JSON.stringify(old)
    );
    const out = JSON.parse(
      execFileSync('node', [SCRIPT, '--overseer-dir', overseerDir], { encoding: 'utf8' })
    );
    expect(out.moved).toEqual(['0002']);
  });
});
