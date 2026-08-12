const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanSurfaceAfter } = require('../../../src/services/overseer/surfaceAfterScan');
const { listFlags } = require('../../../src/services/overseer/flagStore');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-sa-'));
  const todoDir = path.join(root, 'TODO');
  const flagsDir = path.join(root, 'OVERSEER/flags');
  fs.mkdirSync(todoDir, { recursive: true });
  fs.mkdirSync(flagsDir, { recursive: true });
  return { root, todoDir, flagsDir };
}

function writeRoadmap(todoDir, lines) {
  fs.writeFileSync(path.join(todoDir, 'ROADMAP.md'), lines.join('\n') + '\n');
}

function writeTodo(todoDir, name, frontmatter, body = '# t\n') {
  const fm = frontmatter
    ? `---\n${frontmatter}\n---\n\n`
    : '';
  fs.writeFileSync(path.join(todoDir, name), fm + body);
}

describe('scanSurfaceAfter', () => {
  test('past surface_after + open in roadmap → emits flag with surface_after_due', () => {
    const { todoDir, flagsDir } = setup();
    writeRoadmap(todoDir, ['- [ ] `0186` Soak validation']);
    writeTodo(todoDir, '0186-soak.md', 'surface_after: 2020-01-01');

    const results = scanSurfaceAfter({ todoDir, flagsDir, now: new Date('2026-04-30T12:00:00Z') });

    const emitted = results.find(r => r.todo_id === '0186');
    expect(emitted.action).toBe('emitted');
    expect(emitted.flag.concern_kind).toBe('surface_after_due');
    expect(emitted.flag.severity).toBe('concern');
    expect(emitted.flag.suggested_action).toBe('dispatch');

    const onDisk = listFlags(flagsDir).find(f => f.todo_id === '0186');
    expect(onDisk).toBeDefined();
    expect(onDisk.concern_kind).toBe('surface_after_due');
  });

  test('closed in ROADMAP ([x]) → no flag', () => {
    const { todoDir, flagsDir } = setup();
    writeRoadmap(todoDir, ['- [x] `0186` Soak validation']);
    writeTodo(todoDir, '0186-soak.md', 'surface_after: 2020-01-01');

    const results = scanSurfaceAfter({ todoDir, flagsDir, now: new Date('2026-04-30T12:00:00Z') });

    const r = results.find(x => x.todo_id === '0186');
    expect(r.action).toBe('skipped:closed');
    expect(listFlags(flagsDir)).toEqual([]);
  });

  test('future surface_after → no flag', () => {
    const { todoDir, flagsDir } = setup();
    writeRoadmap(todoDir, ['- [ ] `0186` Soak validation']);
    writeTodo(todoDir, '0186-soak.md', 'surface_after: 2099-01-01');

    const results = scanSurfaceAfter({ todoDir, flagsDir, now: new Date('2026-04-30T12:00:00Z') });

    const r = results.find(x => x.todo_id === '0186');
    expect(r.action).toBe('skipped:future');
    expect(listFlags(flagsDir)).toEqual([]);
  });

  test('TODO with no surface_after frontmatter is silently skipped', () => {
    const { todoDir, flagsDir } = setup();
    writeRoadmap(todoDir, ['- [ ] `0001` plain']);
    writeTodo(todoDir, '0001-plain.md', null);

    const results = scanSurfaceAfter({ todoDir, flagsDir, now: new Date('2026-04-30T12:00:00Z') });

    expect(results).toEqual([]);
    expect(listFlags(flagsDir)).toEqual([]);
  });

  test('repeated scans within 24h do not duplicate the flag', () => {
    const { todoDir, flagsDir } = setup();
    writeRoadmap(todoDir, ['- [ ] `0186` Soak validation']);
    writeTodo(todoDir, '0186-soak.md', 'surface_after: 2020-01-01');

    const t0 = new Date('2026-04-30T00:00:00Z');
    scanSurfaceAfter({ todoDir, flagsDir, now: t0 });
    const t1 = new Date('2026-04-30T23:00:00Z'); // 23h later
    const second = scanSurfaceAfter({ todoDir, flagsDir, now: t1 });

    const r = second.find(x => x.todo_id === '0186');
    expect(r.action).toBe('skipped:duplicate');

    const flags = listFlags(flagsDir).filter(f => f.todo_id === '0186');
    expect(flags).toHaveLength(1);
  });

  test('after 24h dedup window expires, a new flag is emitted', () => {
    const { todoDir, flagsDir } = setup();
    writeRoadmap(todoDir, ['- [ ] `0186` Soak validation']);
    writeTodo(todoDir, '0186-soak.md', 'surface_after: 2020-01-01');

    const t0 = new Date('2026-04-30T00:00:00Z');
    scanSurfaceAfter({ todoDir, flagsDir, now: t0 });
    const t1 = new Date('2026-05-01T01:00:00Z'); // 25h later
    const second = scanSurfaceAfter({ todoDir, flagsDir, now: t1 });

    const r = second.find(x => x.todo_id === '0186');
    expect(r.action).toBe('emitted');
  });

  test('dryRun=true does not write the flag to disk', () => {
    const { todoDir, flagsDir } = setup();
    writeRoadmap(todoDir, ['- [ ] `0186` Soak validation']);
    writeTodo(todoDir, '0186-soak.md', 'surface_after: 2020-01-01');

    const results = scanSurfaceAfter({
      todoDir, flagsDir, now: new Date('2026-04-30T12:00:00Z'), dryRun: true
    });

    expect(results.find(r => r.todo_id === '0186').action).toBe('emitted');
    expect(listFlags(flagsDir)).toEqual([]);
  });

  test('mixed batch: future / past / closed / no-field — only past+open emits', () => {
    const { todoDir, flagsDir } = setup();
    writeRoadmap(todoDir, [
      '- [ ] `0001` future',
      '- [ ] `0002` past-open',
      '- [x] `0003` past-closed',
      '- [ ] `0004` no field'
    ]);
    writeTodo(todoDir, '0001-future.md', 'surface_after: 2099-01-01');
    writeTodo(todoDir, '0002-past-open.md', 'surface_after: 2020-01-01');
    writeTodo(todoDir, '0003-past-closed.md', 'surface_after: 2020-01-01');
    writeTodo(todoDir, '0004-no-field.md', null);

    const results = scanSurfaceAfter({ todoDir, flagsDir, now: new Date('2026-04-30T12:00:00Z') });

    const byId = Object.fromEntries(results.map(r => [r.todo_id, r.action]));
    expect(byId['0001']).toBe('skipped:future');
    expect(byId['0002']).toBe('emitted');
    expect(byId['0003']).toBe('skipped:closed');
    expect(byId['0004']).toBeUndefined(); // no field → no result row

    const flagged = listFlags(flagsDir).map(f => f.todo_id).sort();
    expect(flagged).toEqual(['0002']);
  });
});
