const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadState, saveState, DEFAULT_STATE } = require('../../../src/services/overseer/stateStore');

describe('stateStore', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-state-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('loadState returns DEFAULT_STATE when file missing', () => {
    const state = loadState(path.join(tmpDir, 'last-scan.json'));
    expect(state).toEqual(DEFAULT_STATE);
  });

  test('loadState returns DEFAULT_STATE when file is corrupt JSON', () => {
    const p = path.join(tmpDir, 'last-scan.json');
    fs.writeFileSync(p, '{not valid json');
    const state = loadState(p);
    expect(state).toEqual(DEFAULT_STATE);
  });

  test('loadState returns DEFAULT_STATE when schema_version is wrong', () => {
    const p = path.join(tmpDir, 'last-scan.json');
    fs.writeFileSync(p, JSON.stringify({ schema_version: 99 }));
    const state = loadState(p);
    expect(state).toEqual(DEFAULT_STATE);
  });

  test('saveState writes JSON and rotates .bak', () => {
    const p = path.join(tmpDir, 'last-scan.json');
    const s1 = { ...DEFAULT_STATE, last_prework_ts: '2026-04-20T00:00:00Z' };
    saveState(p, s1);
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual(s1);

    const s2 = { ...s1, last_prework_ts: '2026-04-20T00:05:00Z' };
    saveState(p, s2);
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual(s2);
    expect(JSON.parse(fs.readFileSync(p + '.bak', 'utf8'))).toEqual(s1);
  });

  test('saveState creates parent dir if missing', () => {
    const p = path.join(tmpDir, 'nested/dir/last-scan.json');
    saveState(p, DEFAULT_STATE);
    expect(fs.existsSync(p)).toBe(true);
  });

  test('roundtrip preserves seen_todo_hashes', () => {
    const p = path.join(tmpDir, 'last-scan.json');
    const s = { ...DEFAULT_STATE, seen_todo_hashes: { '0001': 'sha256:abc' } };
    saveState(p, s);
    expect(loadState(p)).toEqual(s);
  });
});
