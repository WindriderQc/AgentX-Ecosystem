/**
 * Agent prompt sync — close the roles/ -> live workspace drift gap (0457 follow-up).
 *
 * THE PROBLEM THIS SOLVES
 * `roles/*.md` is the declared authority for agent behaviour, and
 * `config/agent-registry.yml` maps each agent to its role docs. But the live
 * OpenClaw agents never read those files: they read prompt files inside their
 * own workspace on the OpenClaw host (`/home/agentx/.openclaw/workspace-<id>/AGENTS.md`
 * and friends). Nothing synced the two, and nothing detected the divergence —
 * so a role doc could be edited, committed, reviewed and deployed while the
 * running agent kept following a months-old copy. That is exactly how the
 * secretary lane shipped correctly and still behaved wrongly: Nestor obeyed a
 * stale Do·Light list and filed grocery errands as engineering work orders.
 *
 * THE APPROACH: MANAGED BLOCKS, NOT FILE OVERWRITES
 * Workspace prompt files legitimately contain hand-written, host-specific
 * content that is NOT in the repo. Overwriting them wholesale would destroy
 * that, and a whole-file hash comparison would report drift forever. So each
 * synced role doc is wrapped in a delimited block carrying the source path and
 * a sha256 of the canonical content:
 *
 *   <!-- agentx:role-sync source=roles/Nestor.md sha256=<64hex> -->
 *   ...canonical role content...
 *   <!-- /agentx:role-sync source=roles/Nestor.md -->
 *
 * Everything outside the markers is left untouched. Drift is then an exact,
 * boring question — does the block's declared sha match the repo file's sha —
 * instead of a fuzzy diff. Re-applying is idempotent.
 *
 * This module is pure (string + object transforms only). All filesystem and
 * ssh I/O lives in core/scripts/sync-agent-prompts.js so the logic stays
 * testable without a live host.
 */

const crypto = require('crypto');

const DEFAULT_PROMPT_FILE = 'AGENTS.md';
const DEFAULT_OPENCLAW_HOME = '/home/agentx/.openclaw';

/** Content states a target file can be in, relative to the canonical doc. */
const STATE = {
  IN_SYNC: 'in-sync',
  DRIFTED: 'drifted',
  NOT_INSTALLED: 'not-installed',
  MISSING_TARGET: 'missing-target'
};

function fingerprint(content) {
  return crypto.createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function beginMarker(source, sha) {
  return `<!-- agentx:role-sync source=${source} sha256=${sha} -->`;
}

function endMarker(source) {
  return `<!-- /agentx:role-sync source=${source} -->`;
}

/**
 * Wrap canonical content in a managed block keyed by its repo-relative source
 * path. The sha in the header describes the CONTENT, so a reader (or this
 * tool) can tell staleness without fetching the repo.
 */
function buildManagedBlock(source, content) {
  const body = String(content ?? '').replace(/\r\n/g, '\n').trimEnd();
  return `${beginMarker(source, fingerprint(body))}\n${body}\n${endMarker(source)}`;
}

/** Locate an existing managed block for `source`. Returns null when absent. */
function findManagedBlock(text, source) {
  if (typeof text !== 'string' || !text) return null;
  const esc = escapeRegex(source);
  const re = new RegExp(
    `<!-- agentx:role-sync source=${esc} sha256=([a-f0-9]{64}) -->[\\s\\S]*?<!-- /agentx:role-sync source=${esc} -->`
  );
  const match = re.exec(text);
  if (!match) return null;
  return { sha: match[1], start: match.index, end: match.index + match[0].length, raw: match[0] };
}

/**
 * Insert or replace the managed block for `source`, preserving every other
 * byte of the file. A file with no block yet gets one appended, so first-time
 * installs never clobber existing hand-written guidance.
 */
function upsertManagedBlock(text, source, content) {
  const block = buildManagedBlock(source, content);
  const existing = findManagedBlock(text, source);
  if (existing) {
    return text.slice(0, existing.start) + block + text.slice(existing.end);
  }
  const base = String(text ?? '').replace(/\r\n/g, '\n').trimEnd();
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

/**
 * Compare one canonical doc against the live file text.
 * `liveText === null` means the target file does not exist on the host.
 */
function diagnose(source, content, liveText) {
  const body = String(content ?? '').replace(/\r\n/g, '\n').trimEnd();
  const expectedSha = fingerprint(body);
  if (liveText === null || liveText === undefined) {
    return { source, state: STATE.MISSING_TARGET, expectedSha, liveSha: null };
  }
  const existing = findManagedBlock(liveText, source);
  if (!existing) {
    return { source, state: STATE.NOT_INSTALLED, expectedSha, liveSha: null };
  }
  if (existing.sha !== expectedSha) {
    return { source, state: STATE.DRIFTED, expectedSha, liveSha: existing.sha };
  }
  return { source, state: STATE.IN_SYNC, expectedSha, liveSha: existing.sha };
}

function normalizeDocPath(value) {
  return String(value || '').replace(/^\.\//, '').trim();
}

/**
 * Registry ids use underscores (`clawdx_coder`) while OpenClaw workspace
 * directories use hyphens (`workspace-clawdx-coder`). Normalizing here keeps
 * that mismatch from silently targeting a non-existent path.
 */
function toOpenclawId(registryId) {
  return String(registryId || '').replace(/_/g, '-');
}

/**
 * Resolve the OpenClaw agents that have canonical role docs worth syncing.
 * `canonical_persona_doc` (ADR 0002) is authoritative and therefore listed
 * first; remaining role_docs follow, de-duplicated.
 */
function resolveOpenclawAgents(registry, { only = [], openclawHome = DEFAULT_OPENCLAW_HOME, promptFile = DEFAULT_PROMPT_FILE } = {}) {
  const agents = (registry && registry.agents) || {};
  const filter = Array.isArray(only) ? only.filter(Boolean) : [];
  const resolved = [];

  for (const [registryId, cfg] of Object.entries(agents)) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (cfg.runtime !== 'openclaw') continue;

    const openclawId = toOpenclawId(registryId);
    if (filter.length && !filter.includes(registryId) && !filter.includes(openclawId)) continue;

    const docs = [];
    const canonical = normalizeDocPath(cfg.canonical_persona_doc);
    if (canonical) docs.push(canonical);
    for (const entry of Array.isArray(cfg.role_docs) ? cfg.role_docs : []) {
      const normalized = normalizeDocPath(entry);
      if (normalized && !docs.includes(normalized)) docs.push(normalized);
    }
    if (!docs.length) continue;

    resolved.push({
      registryId,
      openclawId,
      persona: cfg.persona || null,
      roleDocs: docs,
      targetPath: `${String(openclawHome).replace(/\/+$/, '')}/workspace-${openclawId}/${promptFile}`
    });
  }

  return resolved.sort((a, b) => a.openclawId.localeCompare(b.openclawId));
}

/** Roll per-doc diagnoses into an exit-code-worthy summary. */
function summarize(results) {
  const counts = { [STATE.IN_SYNC]: 0, [STATE.DRIFTED]: 0, [STATE.NOT_INSTALLED]: 0, [STATE.MISSING_TARGET]: 0 };
  for (const agent of results) {
    for (const doc of agent.docs || []) {
      if (counts[doc.state] !== undefined) counts[doc.state] += 1;
    }
  }
  const outOfSync = counts[STATE.DRIFTED] + counts[STATE.NOT_INSTALLED] + counts[STATE.MISSING_TARGET];
  return { counts, outOfSync, clean: outOfSync === 0 };
}

module.exports = {
  STATE,
  DEFAULT_PROMPT_FILE,
  DEFAULT_OPENCLAW_HOME,
  fingerprint,
  beginMarker,
  endMarker,
  buildManagedBlock,
  findManagedBlock,
  upsertManagedBlock,
  diagnose,
  resolveOpenclawAgents,
  toOpenclawId,
  summarize
};
