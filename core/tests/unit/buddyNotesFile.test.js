// Phase 6h — buddyNotesFile unit tests.
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let TMP_ROOT;

function setHomes() {
  TMP_ROOT = path.join(os.tmpdir(), 'buddy-notes-' + crypto.randomBytes(6).toString('hex'));
  process.env.BUDDY_HOME = path.join(TMP_ROOT, '.buddy');
  process.env.OPENCLAW_HOME = path.join(TMP_ROOT, '.openclaw');
  process.env.HERMES_HOME = path.join(TMP_ROOT, '.hermes');
}

beforeEach(() => {
  jest.resetModules();
  setHomes();
});

afterEach(async () => {
  if (TMP_ROOT && fs.existsSync(TMP_ROOT)) {
    await fsp.rm(TMP_ROOT, { recursive: true, force: true });
  }
  delete process.env.BUDDY_HOME;
});

function getMod() {
  return require('../../src/services/buddyNotesFile');
}

describe('resolveNotesPath', () => {
  test('standalone -> BUDDY_HOME/notes.md', () => {
    const m = getMod();
    const p = m.resolveNotesPath({ personality: { source: 'standalone' } });
    expect(p).toBe(path.join(TMP_ROOT, '.buddy', 'notes.md'));
  });

  test('openclaw -> OPENCLAW_HOME/workspace-X/BUDDY.md', () => {
    const m = getMod();
    const p = m.resolveNotesPath({ personality: { source: 'openclaw', agentId: 'leadx' } });
    expect(p).toBe(path.join(TMP_ROOT, '.openclaw', 'workspace-leadx', 'BUDDY.md'));
  });

  test('openclaw rejects agent ids that could escape the workspace root', () => {
    const m = getMod();
    expect(() => m.resolveNotesPath({
      personality: { source: 'openclaw', agentId: 'main/../../secrets' },
    })).toThrow(/unsafe path characters/);
  });

  test('openclaw preserves discovered single-directory Unicode agent ids', () => {
    const m = getMod();
    const p = m.resolveNotesPath({ personality: { source: 'openclaw', agentId: 'équipe locale' } });
    expect(p).toBe(path.join(TMP_ROOT, '.openclaw', 'workspace-équipe locale', 'BUDDY.md'));
  });

  test('openclaw without agentId throws', () => {
    const m = getMod();
    expect(() => m.resolveNotesPath({ personality: { source: 'openclaw' } })).toThrow();
  });

  test('hermes -> HERMES_HOME/buddy.md', () => {
    const m = getMod();
    const p = m.resolveNotesPath({ personality: { source: 'hermes' } });
    expect(p).toBe(path.join(TMP_ROOT, '.hermes', 'buddy.md'));
  });

  test('default (no personality) is standalone', () => {
    const m = getMod();
    const p = m.resolveNotesPath({});
    expect(p).toBe(path.join(TMP_ROOT, '.buddy', 'notes.md'));
  });
});

describe('append + read round-trip', () => {
  test('appendFact then readNotes returns same fact', async () => {
    const m = getMod();
    const buddy = { personality: { source: 'standalone' } };
    await m.appendFact(buddy, { text: 'fact one', tags: ['preferences', 'hardware'] });
    const r = await m.readNotes(buddy);
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].text).toBe('fact one');
    expect(r.facts[0].tags).toEqual(['preferences', 'hardware']);
    expect(r.facts[0].weight).toBe(1);
  });

  test('frontmatter + body both present after write', async () => {
    const m = getMod();
    const buddy = { personality: { source: 'standalone' } };
    await m.appendFact(buddy, { text: 'visible fact' });
    const filePath = m.resolveNotesPath(buddy);
    const content = await fsp.readFile(filePath, 'utf8');
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toMatch(/buddy_notes_version: 1/);
    expect(content).toMatch(/## Active/);
    expect(content).toMatch(/visible fact/);
  });

  test('multiple facts maintain order on read (desc by addedAt)', async () => {
    const m = getMod();
    const buddy = { personality: { source: 'standalone' } };
    await m.appendFact(buddy, { text: 'first' });
    await new Promise(r => setTimeout(r, 5));
    await m.appendFact(buddy, { text: 'second' });
    const r = await m.readNotes(buddy);
    expect(r.facts.map(f => f.text).sort()).toEqual(['first', 'second']);
  });
});

describe('forgetFact', () => {
  test('marks forgottenAt without deleting', async () => {
    const m = getMod();
    const buddy = { personality: { source: 'standalone' } };
    await m.appendFact(buddy, { text: 'a' });
    await new Promise(r => setTimeout(r, 5));
    await m.appendFact(buddy, { text: 'b' });
    // index 0 in active-desc order should be 'b'
    await m.forgetFact(buddy, 0);
    const r = await m.readNotes(buddy);
    expect(r.facts).toHaveLength(2);
    const active = r.facts.filter(f => !f.forgottenAt);
    const forgotten = r.facts.filter(f => f.forgottenAt);
    expect(active.map(f => f.text)).toEqual(['a']);
    expect(forgotten.map(f => f.text)).toEqual(['b']);
  });

  test('out-of-range index throws', async () => {
    const m = getMod();
    const buddy = { personality: { source: 'standalone' } };
    await m.appendFact(buddy, { text: 'only one' });
    await expect(m.forgetFact(buddy, 5)).rejects.toThrow(/out of range/);
  });
});

describe('cap pruning', () => {
  test('over cap prunes oldest forgotten first', async () => {
    const m = getMod();
    const buddy = { personality: { source: 'standalone' } };
    const facts = [];
    const base = Date.now() - 1_000_000_000;
    // Build 200 active + 1 forgotten (oldest), call writeNotes then append → 201 → drops the forgotten.
    facts.push({
      text: 'oldest forgotten', addedAt: new Date(base), forgottenAt: new Date(base + 100), weight: 1, tags: [],
    });
    for (let i = 0; i < 199; i++) {
      facts.push({ text: 'active ' + i, addedAt: new Date(base + 1000 + i), weight: 1, tags: [] });
    }
    await m.writeNotes(buddy, facts);
    let r = await m.readNotes(buddy);
    expect(r.facts).toHaveLength(200);
    await m.appendFact(buddy, { text: 'new one' });
    r = await m.readNotes(buddy);
    expect(r.facts).toHaveLength(200);
    const texts = r.facts.map(f => f.text);
    expect(texts).not.toContain('oldest forgotten');
    expect(texts).toContain('new one');
  });

  test('over cap with no forgotten prunes oldest active', async () => {
    const m = getMod();
    const buddy = { personality: { source: 'standalone' } };
    const facts = [];
    const base = Date.now() - 1_000_000_000;
    for (let i = 0; i < 200; i++) {
      facts.push({ text: 'active ' + i, addedAt: new Date(base + i * 1000), weight: 1, tags: [] });
    }
    await m.writeNotes(buddy, facts);
    await m.appendFact(buddy, { text: 'newest' });
    const r = await m.readNotes(buddy);
    expect(r.facts).toHaveLength(200);
    const texts = r.facts.map(f => f.text);
    expect(texts).not.toContain('active 0');
    expect(texts).toContain('newest');
  });
});

describe('manual sections preserved', () => {
  test('user-added section between auto headings is preserved on rewrite', async () => {
    const m = getMod();
    const buddy = { personality: { source: 'standalone' } };
    await m.appendFact(buddy, { text: 'first' });
    const filePath = m.resolveNotesPath(buddy);
    let content = await fsp.readFile(filePath, 'utf8');
    // Inject a user section after the auto-gen body.
    content += '\n## Notes (manual)\n\nThis is my own scratchpad.\n';
    await fsp.writeFile(filePath, content);

    await m.appendFact(buddy, { text: 'second' });
    const after = await fsp.readFile(filePath, 'utf8');
    expect(after).toMatch(/## Notes \(manual\)/);
    expect(after).toMatch(/scratchpad/);
    expect(after).toMatch(/first/);
    expect(after).toMatch(/second/);
  });
});

describe('malformed YAML', () => {
  test('returns empty list with warning, does not crash', async () => {
    const m = getMod();
    const buddy = { personality: { source: 'standalone' } };
    const filePath = m.resolveNotesPath(buddy);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, '---\nfacts: [this: is: not: valid yaml\n---\nbody\n');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await m.readNotes(buddy);
    expect(r.facts).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('parses BOM-prefixed frontmatter without changing the underlying file', () => {
    const m = getMod();
    const parsed = m._parseFile('\uFEFF---\nfacts:\n  - text: Exact BOM fact 🦉\n---\nmanual\n');
    expect(parsed.warning).toBeNull();
    expect(parsed.fm.facts[0].text).toBe('Exact BOM fact 🦉');
    expect(parsed.manual).toContain('manual');
  });

  test('reports an unterminated frontmatter block', () => {
    const m = getMod();
    const parsed = m._parseFile('---\nfacts:\n  - text: never closed\n');
    expect(parsed.fm).toBeNull();
    expect(parsed.warning).toBe('unterminated frontmatter');
  });

  test('rejects a notes-file symlink before migration reads it', async () => {
    const m = getMod();
    const buddy = { personality: { source: 'standalone' } };
    const filePath = m.resolveNotesPath(buddy);
    const outside = path.join(TMP_ROOT, 'outside.md');
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(outside, 'outside');
    await fsp.symlink(outside, filePath, 'file');
    await expect(m.assertSafeNotesReadPath(buddy, filePath))
      .rejects.toThrow('must not be a symbolic link');
  });
});

describe('migrateMongoFacts', () => {
  test('migrates when file is missing and clears mongo', async () => {
    const m = getMod();
    const buddy = {
      seed: 'global',
      personality: { source: 'standalone' },
      facts: [
        { text: 'mig 1', addedAt: new Date(), weight: 1 },
        { text: 'mig 2', addedAt: new Date(), weight: 0.5 },
      ],
    };
    let updated = null;
    const BuddyModel = {
      updateOne: jest.fn(async (q, u) => { updated = { q, u }; return { acknowledged: true }; }),
    };
    const res = await m.migrateMongoFacts(buddy, BuddyModel);
    expect(res.migrated).toBe(2);
    const r = await m.readNotes(buddy);
    expect(r.facts).toHaveLength(2);
    expect(BuddyModel.updateOne).toHaveBeenCalled();
    expect(updated.u.$set.facts).toEqual([]);
    // idempotent: second call no-ops
    const res2 = await m.migrateMongoFacts(buddy, BuddyModel);
    expect(res2.migrated).toBe(0);
  });

  test('skips migration when file already has facts', async () => {
    const m = getMod();
    const buddy = {
      seed: 'global',
      personality: { source: 'standalone' },
      facts: [{ text: 'mongo', addedAt: new Date(), weight: 1 }],
    };
    await m.appendFact(buddy, { text: 'pre-existing' });
    const BuddyModel = { updateOne: jest.fn() };
    const res = await m.migrateMongoFacts(buddy, BuddyModel);
    expect(res.migrated).toBe(0);
    expect(BuddyModel.updateOne).not.toHaveBeenCalled();
  });
});
