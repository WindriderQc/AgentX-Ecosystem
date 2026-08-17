// Buddy notes file. Facts live in a markdown file inside the linked source's
// workspace; YAML frontmatter is the source of truth.

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');

const FACT_CAP = 200;
const MAX_TEXT = 500;

function buddyHome() {
  return process.env.BUDDY_HOME || path.join(os.homedir(), '.buddy');
}
function hermesHome() {
  return process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
}
function openclawHome() {
  return process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
}

function resolveNotesRoot(buddy) {
  const source = buddy?.personality?.source || 'standalone';
  if (source === 'hermes') return path.resolve(hermesHome());
  if (source === 'openclaw') return path.resolve(openclawHome());
  return path.resolve(buddyHome());
}

// Resolves the absolute notes file path for a buddy doc.
function resolveNotesPath(buddy) {
  const personality = (buddy && buddy.personality) || {};
  const source = personality.source || 'standalone';
  if (source === 'hermes') {
    return path.join(resolveNotesRoot(buddy), 'buddy.md');
  }
  if (source === 'openclaw') {
    const agentId = personality.agentId || '';
    if (!agentId) throw new Error('openclaw personality requires agentId for notes file');
    if (
      typeof agentId !== 'string'
      || agentId.length > 120
      || agentId.includes('\0')
      || /[\\/]/.test(agentId)
      || agentId === '.'
      || agentId === '..'
    ) {
      throw new Error('openclaw personality agentId contains unsafe path characters');
    }
    const root = resolveNotesRoot(buddy);
    const workspace = path.resolve(root, `workspace-${agentId}`);
    if (path.dirname(workspace) !== root) {
      throw new Error('openclaw personality agentId resolves outside the workspace root');
    }
    return path.join(workspace, 'BUDDY.md');
  }
  // AgentX local and legacy standalone both keep notes in Buddy's own home.
  return path.join(resolveNotesRoot(buddy), 'notes.md');
}

async function assertSafeNotesReadPath(buddy, filePath = resolveNotesPath(buddy)) {
  const expectedPath = path.resolve(resolveNotesPath(buddy));
  const candidatePath = path.resolve(filePath);
  if (candidatePath !== expectedPath) {
    throw new Error('resolved notes path does not match the expected personality workspace');
  }
  const fileInfo = await fs.lstat(candidatePath);
  if (fileInfo.isSymbolicLink()) {
    throw new Error('notes archive must not be a symbolic link');
  }
  const [realRoot, realFile] = await Promise.all([
    fs.realpath(resolveNotesRoot(buddy)),
    fs.realpath(candidatePath),
  ]);
  const relative = path.relative(realRoot, realFile);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('notes archive resolves outside the personality workspace');
  }
  return fileInfo;
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const v = t.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

function normalizeFact(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, MAX_TEXT) : '';
  if (!text) return null;
  const addedAt = raw.addedAt ? new Date(raw.addedAt) : new Date();
  const weight = (Number.isFinite(raw.weight) && raw.weight >= 0 && raw.weight <= 1)
    ? raw.weight : 1.0;
  const tags = normalizeTags(raw.tags);
  const out = { text, addedAt, weight, tags };
  if (raw.forgottenAt) out.forgottenAt = new Date(raw.forgottenAt);
  return out;
}

// Splits an existing file into {frontmatter object, manualBody string}.
// `manualBody` excludes the auto-gen `## Active` and `## Forgotten` H2 sections
// (and any leading `# Buddy notes` heading + intro paragraph we generate).
function parseFile(content) {
  if (typeof content !== 'string') return { fm: null, manual: '', warning: null };
  const normalizedContent = content.startsWith('\uFEFF') ? content.slice(1) : content;
  let body = normalizedContent;
  let fm = null;
  let warning = null;
  const fmMatch = normalizedContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fmMatch) {
    try {
      fm = yaml.load(fmMatch[1]) || null;
    } catch (e) {
      console.warn('[buddyNotesFile] malformed frontmatter, salvaging body:', e.message);
      fm = null;
      warning = `malformed frontmatter: ${e.message}`;
    }
    body = normalizedContent.slice(fmMatch[0].length);
  } else if (/^---\r?\n/.test(normalizedContent)) {
    warning = 'unterminated frontmatter';
  }
  // Strip auto-gen sections by splitting on H2 headings.
  const manual = stripAutoSections(body);
  return { fm, manual, warning };
}

const AUTO_HEADINGS = new Set([
  '## Active',
  '## Forgotten (kept for history)',
]);
const AUTO_INTRO_HEADING = '# Buddy notes';

function stripAutoSections(body) {
  const lines = body.split(/\r?\n/);
  const out = [];
  let inAuto = false;
  let inIntro = false;
  let consumedIntroBlanks = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Detect headings to flip state.
    if (line.startsWith('# ') || line.startsWith('## ')) {
      if (line === AUTO_INTRO_HEADING) {
        inIntro = true;
        inAuto = false;
        consumedIntroBlanks = 0;
        continue;
      }
      if (AUTO_HEADINGS.has(line)) {
        inAuto = true;
        inIntro = false;
        continue;
      }
      // Other headings end auto state.
      inAuto = false;
      inIntro = false;
    }
    if (inAuto) continue;
    if (inIntro) {
      // Skip the intro paragraph (until a blank line + next heading or 3+ blanks).
      // Simpler: skip until next heading.
      continue;
    }
    out.push(line);
  }
  // Trim trailing/leading blank runs.
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

function fmFacts(fm) {
  if (!fm || !Array.isArray(fm.facts)) return [];
  return fm.facts.map(normalizeFact).filter(Boolean);
}

async function ensureDir(p) {
  await fs.mkdir(path.dirname(p), { recursive: true });
}

async function readRawFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Reads + parses the file. Returns { facts, file, manual }.
async function readNotes(buddy) {
  const filePath = resolveNotesPath(buddy);
  const content = await readRawFile(filePath);
  if (content === null) return { facts: [], file: filePath, manual: '' };
  const { fm, manual } = parseFile(content);
  return { facts: fmFacts(fm), file: filePath, manual };
}

function fmtDate(d) {
  try {
    return new Date(d).toISOString();
  } catch (_) {
    return new Date().toISOString();
  }
}

function fmtDateOnly(d) {
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch (_) {
    return '';
  }
}

function renderBody(facts, manual) {
  const active = facts.filter(f => !f.forgottenAt)
    .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  const forgotten = facts.filter(f => f.forgottenAt)
    .sort((a, b) => new Date(b.forgottenAt) - new Date(a.forgottenAt));

  const parts = [];
  parts.push('# Buddy notes');
  parts.push('');
  parts.push('This file is maintained by buddy. The frontmatter is the source of truth.');
  parts.push('You can edit by hand if you keep the YAML valid; buddy preserves any sections');
  parts.push('outside `## Active` and `## Forgotten (kept for history)` on next write.');
  parts.push('');
  parts.push('## Active');
  parts.push('');
  if (active.length === 0) {
    parts.push('_(none)_');
  } else {
    for (const f of active) {
      parts.push('- ' + f.text);
      const meta = [];
      if (f.tags && f.tags.length) meta.push('tags: ' + f.tags.join(', '));
      const d = fmtDateOnly(f.addedAt);
      if (d) meta.push('added: ' + d);
      if (meta.length) parts.push('  - ' + meta.join(' · '));
    }
  }
  parts.push('');
  parts.push('## Forgotten (kept for history)');
  parts.push('');
  if (forgotten.length === 0) {
    parts.push('_(none)_');
  } else {
    for (const f of forgotten) {
      parts.push('- ~~' + f.text + '~~');
      const meta = [];
      if (f.tags && f.tags.length) meta.push('tags: ' + f.tags.join(', '));
      const da = fmtDateOnly(f.addedAt);
      const df = fmtDateOnly(f.forgottenAt);
      if (da) meta.push('added: ' + da);
      if (df) meta.push('forgotten: ' + df);
      if (meta.length) parts.push('  - ' + meta.join(' · '));
    }
  }
  if (manual && manual.trim()) {
    parts.push('');
    parts.push(manual.trim());
  }
  parts.push('');
  return parts.join('\n');
}

function serialize(facts, manual) {
  const fm = {
    buddy_notes_version: 1,
    updated: new Date().toISOString(),
    facts: facts.map(f => {
      const out = {
        text: f.text,
        addedAt: fmtDate(f.addedAt),
        weight: f.weight,
        tags: f.tags || [],
      };
      if (f.forgottenAt) out.forgottenAt = fmtDate(f.forgottenAt);
      return out;
    }),
  };
  const fmYaml = yaml.dump(fm, { lineWidth: 200, noRefs: true });
  return '---\n' + fmYaml + '---\n\n' + renderBody(facts, manual);
}

async function atomicWrite(filePath, content) {
  await ensureDir(filePath);
  const tmp = filePath + '.tmp.' + crypto.randomBytes(6).toString('hex');
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

// Cap pruning: keep at most FACT_CAP facts. Drop oldest forgotten first;
// if still over, drop oldest active.
function applyCap(facts) {
  if (facts.length <= FACT_CAP) return facts;
  const forgotten = facts.filter(f => f.forgottenAt)
    .sort((a, b) => new Date(a.forgottenAt) - new Date(b.forgottenAt));
  const active = facts.filter(f => !f.forgottenAt)
    .sort((a, b) => new Date(a.addedAt) - new Date(b.addedAt));
  const drop = new Set();
  let over = facts.length - FACT_CAP;
  for (const f of forgotten) { if (over <= 0) break; drop.add(f); over--; }
  for (const f of active)    { if (over <= 0) break; drop.add(f); over--; }
  return facts.filter(f => !drop.has(f));
}

// Atomically appends a fact. Returns the updated facts array (active+forgotten).
async function appendFact(buddy, payload) {
  const filePath = resolveNotesPath(buddy);
  const existing = await readRawFile(filePath);
  const { fm, manual } = existing ? parseFile(existing) : { fm: null, manual: '' };
  const facts = fmFacts(fm);
  const fact = normalizeFact({
    text: payload && payload.text,
    weight: payload && payload.weight,
    tags: payload && payload.tags,
    addedAt: new Date(),
  });
  if (!fact) throw new Error('text is required');
  facts.push(fact);
  const capped = applyCap(facts);
  await atomicWrite(filePath, serialize(capped, manual));
  return { facts: capped, file: filePath };
}

// Mark the i-th active fact (in addedAt-desc order) as forgotten.
async function forgetFact(buddy, index) {
  const filePath = resolveNotesPath(buddy);
  const existing = await readRawFile(filePath);
  const { fm, manual } = existing ? parseFile(existing) : { fm: null, manual: '' };
  const facts = fmFacts(fm);
  const active = facts.filter(f => !f.forgottenAt)
    .map((f, i) => ({ f, srcIdx: facts.indexOf(f) }))
    .sort((a, b) => new Date(b.f.addedAt) - new Date(a.f.addedAt));
  if (index < 0 || index >= active.length) {
    throw new Error('index out of range');
  }
  const target = active[index];
  facts[target.srcIdx] = { ...target.f, forgottenAt: new Date() };
  const capped = applyCap(facts);
  await atomicWrite(filePath, serialize(capped, manual));
  return { facts: capped, file: filePath };
}

// Bulk replace (used for migration from Mongo facts).
async function writeNotes(buddy, factsArray) {
  const filePath = resolveNotesPath(buddy);
  const existing = await readRawFile(filePath);
  const { manual } = existing ? parseFile(existing) : { manual: '' };
  const facts = (Array.isArray(factsArray) ? factsArray : [])
    .map(normalizeFact)
    .filter(Boolean);
  const capped = applyCap(facts);
  await atomicWrite(filePath, serialize(capped, manual));
  return { facts: capped, file: filePath };
}

// Idempotent: if Buddy.facts (mongo) is non-empty AND notes file has no facts,
// migrate Mongo -> file and clear Mongo.facts.
async function migrateMongoFacts(buddy, BuddyModel) {
  if (!buddy) return { migrated: 0 };
  const mongoFacts = Array.isArray(buddy.facts) ? buddy.facts : [];
  if (mongoFacts.length === 0) return { migrated: 0 };
  let filePath;
  try {
    filePath = resolveNotesPath(buddy);
  } catch (_) {
    return { migrated: 0 };
  }
  const existing = await readRawFile(filePath);
  if (existing) {
    const { fm } = parseFile(existing);
    const have = fmFacts(fm);
    if (have.length > 0) return { migrated: 0 };
  }
  // Write the mongo facts to file.
  await writeNotes(buddy, mongoFacts);
  // Clear in mongo (best-effort).
  if (BuddyModel && typeof BuddyModel.updateOne === 'function') {
    try {
      await BuddyModel.updateOne({ seed: buddy.seed || 'global' }, { $set: { facts: [] } });
      if (Array.isArray(buddy.facts)) buddy.facts = [];
    } catch (e) {
      console.warn('[buddyNotesFile] mongo clear after migration failed:', e.message);
    }
  }
  console.info('[buddy] migrated ' + mongoFacts.length + ' Mongo facts to ' + filePath);
  return { migrated: mongoFacts.length, file: filePath };
}

module.exports = {
  FACT_CAP,
  resolveNotesPath,
  resolveNotesRoot,
  assertSafeNotesReadPath,
  readNotes,
  appendFact,
  forgetFact,
  writeNotes,
  migrateMongoFacts,
  // exported for tests
  _parseFile: parseFile,
  _serialize: serialize,
  _normalizeFact: normalizeFact,
  _applyCap: applyCap,
};
