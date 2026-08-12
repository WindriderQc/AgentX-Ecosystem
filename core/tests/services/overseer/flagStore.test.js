const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  writeFlag,
  readFlag,
  listFlags,
  deleteFlag,
  PROPOSAL_SOFT_CAP
} = require('../../../src/services/overseer/flagStore');

describe('flagStore (CRUD + cap)', () => {
  let flagsDir;
  beforeEach(() => {
    flagsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-flags-'));
  });
  afterEach(() => {
    fs.rmSync(flagsDir, { recursive: true, force: true });
  });

  const validFlag = {
    todo_id: '0142',
    severity: 'concern',
    summary: 'stale line ref',
    details: 'foo.js:42 no longer contains referenced logic',
    related_todos: [],
    suggested_action: 'refresh',
    created_at: '2026-04-20T14:00:00Z'
  };

  test('writeFlag + readFlag round-trips', () => {
    const p = writeFlag(flagsDir, validFlag);
    expect(fs.existsSync(p)).toBe(true);
    expect(readFlag(p)).toEqual(validFlag);
  });

  test('writeFlag filename is YYYY-MM-DD-<todo-id>.json', () => {
    const p = writeFlag(flagsDir, validFlag);
    expect(path.basename(p)).toBe('2026-04-20-0142.json');
  });

  test('writeFlag rejects invalid severity', () => {
    expect(() => writeFlag(flagsDir, { ...validFlag, severity: 'info' }))
      .toThrow(/severity/);
  });

  test('writeFlag rejects missing required fields', () => {
    expect(() => writeFlag(flagsDir, { ...validFlag, todo_id: undefined }))
      .toThrow(/todo_id/);
  });

  test('writeFlag overwrites existing flag for same todo on same day', () => {
    writeFlag(flagsDir, validFlag);
    const updated = { ...validFlag, summary: 'updated' };
    writeFlag(flagsDir, updated);
    const found = listFlags(flagsDir).find(f => f.todo_id === '0142');
    expect(found.summary).toBe('updated');
  });

  test('listFlags returns all flags (excluding stale/)', () => {
    writeFlag(flagsDir, validFlag);
    writeFlag(flagsDir, { ...validFlag, todo_id: '0099', created_at: '2026-04-19T00:00:00Z' });
    fs.mkdirSync(path.join(flagsDir, 'stale'), { recursive: true });
    fs.writeFileSync(path.join(flagsDir, 'stale/old.json'), JSON.stringify(validFlag));

    const flags = listFlags(flagsDir);
    expect(flags.map(f => f.todo_id).sort()).toEqual(['0099', '0142']);
  });

  test('deleteFlag removes the file', () => {
    const p = writeFlag(flagsDir, validFlag);
    deleteFlag(p);
    expect(fs.existsSync(p)).toBe(false);
  });

  test('exports PROPOSAL_SOFT_CAP = 20', () => {
    expect(PROPOSAL_SOFT_CAP).toBe(20);
  });
});

const { sweepStaleFlags, TTL_DAYS } = require('../../../src/services/overseer/flagStore');

describe('flagStore (TTL + archive)', () => {
  let flagsDir;
  beforeEach(() => {
    flagsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-flags-'));
  });
  afterEach(() => {
    fs.rmSync(flagsDir, { recursive: true, force: true });
  });

  test('TTL_DAYS is 7', () => {
    expect(TTL_DAYS).toBe(7);
  });

  test('sweepStaleFlags moves flags older than 7 days into stale/', () => {
    const fresh = {
      todo_id: '0001', severity: 'concern', summary: 's', details: 'd',
      related_todos: [], suggested_action: 'refresh',
      created_at: '2026-04-19T00:00:00Z'
    };
    const old = { ...fresh, todo_id: '0002', created_at: '2026-04-01T00:00:00Z' };
    writeFlag(flagsDir, fresh);
    writeFlag(flagsDir, old);

    const now = new Date('2026-04-20T00:00:00Z');
    const moved = sweepStaleFlags(flagsDir, now);

    expect(moved).toEqual(['0002']);
    expect(fs.existsSync(path.join(flagsDir, '2026-04-19-0001.json'))).toBe(true);
    expect(fs.existsSync(path.join(flagsDir, '2026-04-01-0002.json'))).toBe(false);
    expect(fs.existsSync(path.join(flagsDir, 'stale/2026-04-01-0002.json'))).toBe(true);
  });

  test('sweepStaleFlags skips the stale/ subdir itself', () => {
    const now = new Date('2026-04-20T00:00:00Z');
    fs.mkdirSync(path.join(flagsDir, 'stale'), { recursive: true });
    expect(() => sweepStaleFlags(flagsDir, now)).not.toThrow();
  });
});
