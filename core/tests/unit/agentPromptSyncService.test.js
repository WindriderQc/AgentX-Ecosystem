/**
 * Unit tests for the roles/ -> live workspace prompt sync (0457 follow-up).
 * The whole point of the managed-block design is that it never destroys
 * hand-written host content and that drift detection is exact, so those two
 * properties get the most coverage.
 */

const {
  STATE,
  fingerprint,
  buildManagedBlock,
  findManagedBlock,
  upsertManagedBlock,
  diagnose,
  resolveOpenclawAgents,
  toOpenclawId,
  summarize
} = require('../../src/services/agentPromptSyncService');

const SOURCE = 'roles/Nestor.md';
const CANONICAL = '# Nestor\n\nRoute errands to add_personal_task.\n';

describe('buildManagedBlock / findManagedBlock', () => {
  test('wraps content in markers carrying the source and content sha', () => {
    const block = buildManagedBlock(SOURCE, CANONICAL);
    expect(block).toContain(`<!-- agentx:role-sync source=${SOURCE} sha256=${fingerprint(CANONICAL.trimEnd())} -->`);
    expect(block).toContain(`<!-- /agentx:role-sync source=${SOURCE} -->`);
    expect(block).toContain('Route errands to add_personal_task.');
  });

  test('is deterministic — same content yields an identical block', () => {
    expect(buildManagedBlock(SOURCE, CANONICAL)).toBe(buildManagedBlock(SOURCE, CANONICAL));
  });

  test('normalizes CRLF so a Windows checkout does not read as drift', () => {
    const crlf = buildManagedBlock(SOURCE, '# Nestor\r\n\r\nline\r\n');
    const lf = buildManagedBlock(SOURCE, '# Nestor\n\nline\n');
    expect(crlf).toBe(lf);
  });

  test('finds only the block matching the requested source', () => {
    const text = [buildManagedBlock('roles/Main.md', 'main doc'), buildManagedBlock(SOURCE, CANONICAL)].join('\n\n');
    const found = findManagedBlock(text, SOURCE);
    expect(found).not.toBeNull();
    expect(found.sha).toBe(fingerprint(CANONICAL.trimEnd()));
    expect(findManagedBlock(text, 'roles/Nope.md')).toBeNull();
    expect(findManagedBlock('', SOURCE)).toBeNull();
  });
});

describe('upsertManagedBlock', () => {
  const HANDWRITTEN = '# Host notes\n\nThis line is hand-written on .66 and must survive.\n';

  test('appends without destroying existing hand-written content', () => {
    const result = upsertManagedBlock(HANDWRITTEN, SOURCE, CANONICAL);
    expect(result).toContain('This line is hand-written on .66 and must survive.');
    expect(findManagedBlock(result, SOURCE)).not.toBeNull();
  });

  test('replaces only its own block on re-apply, preserving surrounding text', () => {
    const first = upsertManagedBlock(`${HANDWRITTEN}\n${buildManagedBlock(SOURCE, 'OLD CONTENT')}\n\n# Trailing host section\n`, SOURCE, CANONICAL);
    expect(first).toContain('This line is hand-written on .66 and must survive.');
    expect(first).toContain('# Trailing host section');
    expect(first).not.toContain('OLD CONTENT');
    expect(first).toContain('Route errands to add_personal_task.');
  });

  test('is idempotent — applying twice changes nothing', () => {
    const once = upsertManagedBlock(HANDWRITTEN, SOURCE, CANONICAL);
    expect(upsertManagedBlock(once, SOURCE, CANONICAL)).toBe(once);
  });

  test('handles an empty/missing target file', () => {
    const result = upsertManagedBlock('', SOURCE, CANONICAL);
    expect(diagnose(SOURCE, CANONICAL, result).state).toBe(STATE.IN_SYNC);
  });

  test('survives markdown containing quotes, backticks and $ (ssh payload safety)', () => {
    const nasty = "Use `openclaw agent --message 'hi'` and $HOME \"quoted\".\n";
    const result = upsertManagedBlock(HANDWRITTEN, SOURCE, nasty);
    expect(diagnose(SOURCE, nasty, result).state).toBe(STATE.IN_SYNC);
  });

  test('keeps multiple sources independent in one file', () => {
    let text = upsertManagedBlock(HANDWRITTEN, 'roles/Nestor.md', 'nestor v1');
    text = upsertManagedBlock(text, 'roles/Main.md', 'main v1');
    text = upsertManagedBlock(text, 'roles/Nestor.md', 'nestor v2');
    expect(diagnose('roles/Nestor.md', 'nestor v2', text).state).toBe(STATE.IN_SYNC);
    expect(diagnose('roles/Main.md', 'main v1', text).state).toBe(STATE.IN_SYNC);
    expect(text).toContain('This line is hand-written on .66 and must survive.');
  });
});

describe('diagnose', () => {
  test('missing target file', () => {
    expect(diagnose(SOURCE, CANONICAL, null).state).toBe(STATE.MISSING_TARGET);
  });

  test('target exists but was never synced', () => {
    const verdict = diagnose(SOURCE, CANONICAL, '# just host notes\n');
    expect(verdict.state).toBe(STATE.NOT_INSTALLED);
    expect(verdict.liveSha).toBeNull();
  });

  test('detects drift when the repo doc changes', () => {
    const live = upsertManagedBlock('', SOURCE, 'stale role content');
    const verdict = diagnose(SOURCE, CANONICAL, live);
    expect(verdict.state).toBe(STATE.DRIFTED);
    expect(verdict.liveSha).not.toBe(verdict.expectedSha);
  });

  test('reports in-sync for identical content', () => {
    const live = upsertManagedBlock('', SOURCE, CANONICAL);
    expect(diagnose(SOURCE, CANONICAL, live).state).toBe(STATE.IN_SYNC);
  });
});

describe('resolveOpenclawAgents', () => {
  const registry = {
    agents: {
      codex: { type: 'coding_agent', role_docs: ['./roles/Worker.md'] }, // no runtime -> skipped
      main: {
        runtime: 'openclaw',
        persona: 'Nestor',
        canonical_persona_doc: './roles/Nestor.md',
        role_docs: ['./roles/Nestor.md', './roles/Main.md']
      },
      clawdx_coder: { runtime: 'openclaw', role_docs: ['./roles/ClawdXCoder.md'] },
      ghost: { runtime: 'openclaw' } // no docs -> skipped
    }
  };

  test('selects only openclaw agents that have role docs', () => {
    const agents = resolveOpenclawAgents(registry);
    expect(agents.map((a) => a.openclawId)).toEqual(['clawdx-coder', 'main']);
  });

  test('maps registry underscores to workspace hyphens', () => {
    expect(toOpenclawId('clawdx_coder')).toBe('clawdx-coder');
    const agents = resolveOpenclawAgents(registry);
    const coder = agents.find((a) => a.registryId === 'clawdx_coder');
    expect(coder.targetPath).toBe('/home/agentx/.openclaw/workspace-clawdx-coder/AGENTS.md');
  });

  test('puts the canonical persona doc first and de-duplicates', () => {
    const main = resolveOpenclawAgents(registry).find((a) => a.openclawId === 'main');
    expect(main.roleDocs).toEqual(['roles/Nestor.md', 'roles/Main.md']);
    expect(main.persona).toBe('Nestor');
  });

  test('honours the agent filter by either id form', () => {
    expect(resolveOpenclawAgents(registry, { only: ['main'] })).toHaveLength(1);
    expect(resolveOpenclawAgents(registry, { only: ['clawdx-coder'] })).toHaveLength(1);
    expect(resolveOpenclawAgents(registry, { only: ['nope'] })).toHaveLength(0);
  });

  test('respects custom home and prompt file', () => {
    const agents = resolveOpenclawAgents(registry, { openclawHome: '/tmp/oc/', promptFile: 'TOOLS.md', only: ['main'] });
    expect(agents[0].targetPath).toBe('/tmp/oc/workspace-main/TOOLS.md');
  });

  test('tolerates an empty or malformed registry', () => {
    expect(resolveOpenclawAgents(null)).toEqual([]);
    expect(resolveOpenclawAgents({ agents: { x: null } })).toEqual([]);
  });
});

describe('summarize', () => {
  test('counts states and flags cleanliness', () => {
    const clean = summarize([{ docs: [{ state: STATE.IN_SYNC }, { state: STATE.IN_SYNC }] }]);
    expect(clean.clean).toBe(true);
    expect(clean.outOfSync).toBe(0);

    const dirty = summarize([
      { docs: [{ state: STATE.IN_SYNC }, { state: STATE.DRIFTED }] },
      { docs: [{ state: STATE.MISSING_TARGET }] }
    ]);
    expect(dirty.clean).toBe(false);
    expect(dirty.outOfSync).toBe(2);
    expect(dirty.counts[STATE.DRIFTED]).toBe(1);
  });
});
