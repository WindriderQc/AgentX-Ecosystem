#!/usr/bin/env node
'use strict';

/**
 * Deterministic migration inventory generator for the AgentX documentation migration.
 *
 * Exports focused functions for discovery, classification, link extraction,
 * inventory construction, and deterministic YAML rendering.
 *
 * CLI:
 *   node build-migration-inventory.js --repo-root <path> [--output <path>] [--write] [--check]
 *
 * Default: prints YAML to stdout without writing.
 * --write: writes YAML to --output path (creates/updates only that file).
 * --check: exits non-zero when the requested inventory is missing or differs.
 */

const fs = require('fs');
const path = require('path');
const { loadDocsMap, renderYaml } = require('./migration-inventory-yaml');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'coverage', 'dist', 'build', 'logs',
  'test-results', '.worktree', '.worktrees', 'worktree', 'worktrees',
  'backup', 'backups', '.backup', '.backups', '.claude', '.agentx',
  '.next', '.nuxt', '.venv', 'venv', 'vendor'
]);

const DOC_EXTENSIONS = new Set(['.md']);
const DATA_DOC_EXTENSIONS = new Set(['.json', '.yml', '.yaml']);
const DOCS_DATA_DIRS = ['docs'];

/** Root governance files treated as permanent canonical. */
const ROOT_GOVERNANCE_FILES = new Set([
  'GOVERNANCE.md',
  'WORKFLOW.md',
  'LEAD.md',
  'SCHEDULED.md',
  'DOCKER.md',
  'CLAUDE.md',
  'AGENTS.md',
  'LLM.md',
  'README.md',
  'QUICKSTART.md',
  'TODO_TASK_TEMPLATE.md'
]);

/** Directories whose Markdown contents are historical. */
const HISTORICAL_DIR_PREFIX = 'docs/_archive';

/** Directories whose contents are generated. */
const GENERATED_DIRS = new Set(['docs/audits', 'reports']);

/** Directories whose contents are progression. */
const PROGRESSION_DIRS = new Set(['docs/progress']);

/** Accepted decision locations treated as permanent. */
const DECISION_DIRS = new Set(['docs/decisions', 'docs/ai-ops/decisions']);

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

function relPath(repoRoot, fullPath) {
  return toPosix(path.relative(repoRoot, fullPath)) || '.';
}

function normalizeList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function sortStrings(arr) {
  return arr.slice().sort((a, b) => a.localeCompare(b));
}

function isWithinRepoDirectory(repoRelative, directory) {
  return repoRelative === directory ||
    repoRelative.startsWith(directory + '/') ||
    repoRelative.endsWith('/' + directory) ||
    repoRelative.includes('/' + directory + '/');
}

/**
 * Parse YAML-like frontmatter from the beginning of a Markdown file.
 * Supports the standard `---` delimited block with simple `key: value` lines.
 * Does not depend on js-yaml; only parses what is needed for classification.
 */
function parseFrontmatter(text) {
  if (!text || text.length < 4) return null;
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const block = match[1];
  const fm = {};
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value === 'null' || value === '~') value = null;
    fm[key] = value;
  }
  return fm;
}

/**
 * Extract the first Markdown H1 heading as a title.
 */
function extractTitle(text) {
  if (!text) return null;
  const match = text.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover every Markdown file in the repository outside dependency/build/backup/worktree
 * directories, plus JSON/YAML documentation artifacts under docs/.
 * Includes untracked files present in the working tree.
 *
 * @param {string} repoRoot - absolute path to repository root
 * @returns {Array<{path: string, format: string}>} sorted list of repo-relative paths
 */
function discoverDocs(repoRoot) {
  const results = new Set();

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_e) {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const relative = relPath(repoRoot, fullPath);

        if (DOC_EXTENSIONS.has(ext)) {
          results.add(relative);
        } else if (DATA_DOC_EXTENSIONS.has(ext)) {
          // Only include JSON/YAML under docs/
          if (relative.startsWith('docs/') || relative === 'docs') {
            results.add(relative);
          }
        }
      }
    }
  }

  walk(repoRoot);

  return sortStrings(Array.from(results)).map(p => ({
    path: p,
    format: path.extname(p).slice(1).toLowerCase()
  }));
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Build a lookup from docs-map canonical entries to topic IDs.
 */
function buildDocsMapCanonicalIndex(docsMap) {
  const index = new Map(); // repo-relative path -> array of topic IDs
  if (!docsMap || !Array.isArray(docsMap.topics)) return index;

  for (const topic of docsMap.topics) {
    if (!topic || !topic.id) continue;
    const refs = normalizeList(topic.canonical);
    for (const ref of refs) {
      if (typeof ref !== 'string') continue;
      if (ref.startsWith('external:')) continue;
      const normalized = ref.replace(/^\.\//, '');
      if (!index.has(normalized)) index.set(normalized, []);
      index.get(normalized).push(topic.id);
    }
  }
  return index;
}

/**
 * Build a lookup from every in-repository docs-map reference to topic IDs.
 * Canonical membership drives classification; broader membership is recorded
 * so a migration reviewer can see which permanent topics a supporting doc or
 * Markdown verification source participates in.
 */
function buildDocsMapTopicIndex(docsMap) {
  const index = new Map();
  if (!docsMap || !Array.isArray(docsMap.topics)) return index;

  for (const topic of docsMap.topics) {
    if (!topic || !topic.id) continue;
    for (const key of ['canonical', 'supporting', 'verify_against']) {
      for (const ref of normalizeList(topic[key])) {
        if (typeof ref !== 'string' || ref.startsWith('external:')) continue;
        const normalized = toPosix(ref.replace(/^\.\//, ''));
        if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) continue;
        if (!index.has(normalized)) index.set(normalized, []);
        if (!index.get(normalized).includes(topic.id)) index.get(normalized).push(topic.id);
      }
    }
  }

  for (const topics of index.values()) topics.sort((a, b) => a.localeCompare(b));
  return index;
}

/**
 * Classify a single documentation artifact.
 *
 * Precedence order:
 * 1. Valid frontmatter doc_type
 * 2. docs/_archive as historical
 * 3. docs/audits and reports as generated
 * 4. docs/progress as progression
 * 5. docs-map canonical entries and permanent root governance as permanent
 * 6. Accepted decision locations as permanent
 * 7. Conservative filename/content hints, marking ambiguity needs_review
 *
 * @param {string} repoRelative - repo-relative path
 * @param {string} text - file content (null for non-text)
 * @param {Map} canonicalIndex - docs-map canonical path -> topic IDs
 * @returns {{class: string, authority: string, reason: string, migration_state: string, proposed_target: string|null}}
 */
function classifyArtifact(repoRelative, text, canonicalIndex) {
  const posixPath = toPosix(repoRelative);

  // 1. Valid frontmatter doc_type
  const fm = parseFrontmatter(text);
  if (fm && fm.doc_type) {
    const dt = fm.doc_type;
    if (['permanent', 'progression', 'generated', 'historical'].includes(dt)) {
      const authority = fm.authority || inferAuthorityFromClass(dt);
      return {
        class: dt,
        authority: authority,
        reason: 'frontmatter doc_type',
        migration_state: fm.status || 'active',
        proposed_target: proposeTarget(dt, posixPath)
      };
    }
  }

  // 2. docs/_archive as historical
  if (isWithinRepoDirectory(posixPath, HISTORICAL_DIR_PREFIX)) {
    return {
      class: 'historical',
      authority: 'snapshot',
      reason: 'located in docs/_archive',
      migration_state: 'archived',
      proposed_target: null
    };
  }

  // 3. docs/audits and reports as generated
  if (isWithinRepoDirectory(posixPath, 'docs/audits') || isWithinRepoDirectory(posixPath, 'reports')) {
    return {
      class: 'generated',
      authority: 'evidence',
      reason: 'located in audits/reports directory',
      migration_state: 'generated',
      proposed_target: null
    };
  }

  // 4. docs/progress as progression
  if (isWithinRepoDirectory(posixPath, 'docs/progress')) {
    return {
      class: 'progression',
      authority: 'supporting',
      reason: 'located in docs/progress',
      migration_state: 'active',
      proposed_target: null
    };
  }

  // 5. docs-map canonical entries and permanent root governance as permanent
  if (canonicalIndex.has(posixPath)) {
    return {
      class: 'permanent',
      authority: 'canonical',
      reason: 'docs-map canonical entry',
      migration_state: 'current',
      proposed_target: null
    };
  }

  // Root governance files
  const basename = path.basename(posixPath);
  const topDir = posixPath.split('/')[0];
  if (topDir === basename && ROOT_GOVERNANCE_FILES.has(basename)) {
    return {
      class: 'permanent',
      authority: 'canonical',
      reason: 'permanent root governance file',
      migration_state: 'current',
      proposed_target: null
    };
  }


  // Service-local instruction files are durable authority for their subtree.
  if (basename === 'AGENTS.md' || basename === 'CLAUDE.md') {
    return {
      class: 'permanent',
      authority: 'canonical',
      reason: 'service-local instruction authority',
      migration_state: 'current',
      proposed_target: null
    };
  }

  // Ecosystem role definitions are durable operating authority. They live in a
  // protected directory, so classification must not depend on editing each file.
  if (topDir === 'roles' && posixPath.endsWith('.md')) {
    return {
      class: 'permanent',
      authority: 'supporting',
      reason: 'ecosystem role definition authority',
      migration_state: 'current',
      proposed_target: null
    };
  }

  // 6. Accepted decision locations as permanent
  for (const decDir of DECISION_DIRS) {
    if (isWithinRepoDirectory(posixPath, decDir)) {
      return {
        class: 'permanent',
        authority: 'canonical',
        reason: 'accepted decision location',
        migration_state: 'current',
        proposed_target: null
      };
    }
  }

  // 7. Conservative filename/content hints
  // (basename already extracted above)
  const lowerName = basename.toLowerCase();

  // Content hints from frontmatter tags
  if (fm && fm.tags) {
    const tags = Array.isArray(fm.tags) ? fm.tags : [fm.tags];
    const tagStr = tags.join(' ').toLowerCase();
    if (tagStr.includes('archive') || tagStr.includes('kind/archive')) {
      return {
        class: 'historical',
        authority: 'snapshot',
        reason: 'frontmatter tag hint (archive)',
        migration_state: 'needs_review',
        proposed_target: null
      };
    }
  }

  // Filename date pattern suggests generated/historical
  if (/\d{4}-\d{2}-\d{2}/.test(lowerName) || /\d{4}-\d{2}/.test(lowerName)) {
    // Dated file — could be generated or historical, conservative: needs_review
    return {
      class: 'progression',
      authority: 'supporting',
      reason: 'dated filename without frontmatter classification',
      migration_state: 'needs_review',
      proposed_target: null
    };
  }

  // Content hints
  if (text) {
    const lowerText = text.slice(0, 2000).toLowerCase();
    if (lowerText.includes('archived') || lowerText.includes('superseded') || lowerText.includes('frozen snapshot')) {
      return {
        class: 'historical',
        authority: 'snapshot',
        reason: 'content hint (archived/superseded)',
        migration_state: 'needs_review',
        proposed_target: null
      };
    }
    if (lowerText.includes('audit') || lowerText.includes('scan results') || lowerText.includes('findings')) {
      return {
        class: 'generated',
        authority: 'evidence',
        reason: 'content hint (audit/scan/findings)',
        migration_state: 'needs_review',
        proposed_target: null
      };
    }
    if (lowerText.includes('roadmap') || lowerText.includes('plan') || lowerText.includes('proposal')) {
      return {
        class: 'progression',
        authority: 'supporting',
        reason: 'content hint (roadmap/plan/proposal)',
        migration_state: 'needs_review',
        proposed_target: null
      };
    }
  }

  // Default: ambiguous
  return {
    class: 'progression',
    authority: 'supporting',
    reason: 'no authoritative classification signal',
    migration_state: 'needs_review',
    proposed_target: null
  };
}

function inferAuthorityFromClass(docClass) {
  switch (docClass) {
    case 'permanent': return 'canonical';
    case 'progression': return 'supporting';
    case 'generated': return 'evidence';
    case 'historical': return 'snapshot';
    default: return 'supporting';
  }
}

function proposeTarget(docClass, posixPath) {
  if (docClass === 'permanent') return null;
  if (docClass === 'progression') {
    // Suggest docs/progress/ if not already there
    if (!posixPath.startsWith('docs/progress/')) {
      return 'docs/progress/';
    }
    return null;
  }
  if (docClass === 'generated') {
    if (!posixPath.startsWith('docs/audits/') && !posixPath.startsWith('reports/')) {
      return 'docs/audits/';
    }
    return null;
  }
  if (docClass === 'historical') {
    if (!posixPath.startsWith('docs/_archive/')) {
      return 'docs/_archive/';
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------

/**
 * Extract repository-relative outgoing links from Markdown text.
 * Ignores anchors, mailto, and HTTP(S) links for filesystem existence checks.
 *
 * @param {string} text - Markdown content
 * @returns {string[]} sorted unique repo-relative link targets
 */
function extractLinks(text) {
  if (!text) return [];
  const links = new Set();

  // Match [text](target) — capture target
  const linkRegex = /\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = linkRegex.exec(text)) !== null) {
    let target = match[1].trim();
    if (target.startsWith('<')) {
      const angleTarget = target.match(/^<([^>]+)>/);
      if (angleTarget) target = angleTarget[1].trim();
    } else {
      target = target.replace(/\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/, '').trim();
    }
    // Strip anchor
    const hashIdx = target.indexOf('#');
    if (hashIdx >= 0) target = target.slice(0, hashIdx);
    target = target.trim();
    if (!target) continue;
    // Skip external protocols
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('//')) continue;
    // Normalize: remove leading ./
    if (target.startsWith('./')) target = target.slice(2);
    links.add(toPosix(target));
  }

  return sortStrings(Array.from(links));
}

/**
 * Resolve a link target relative to the source file's directory.
 * Returns a repo-relative path.
 *
 * @param {string} sourcePath - repo-relative path of the source file
 * @param {string} linkTarget - link target from Markdown
 * @returns {string} repo-relative resolved path
 */
function resolveLink(sourcePath, linkTarget) {
  if (linkTarget.startsWith('/')) return path.posix.normalize(linkTarget.slice(1));
  const sourceDir = path.posix.dirname(sourcePath);
  const resolved = path.posix.normalize(path.posix.join(sourceDir, linkTarget));
  return resolved;
}

/**
 * Check whether a repo-relative link target exists on the filesystem.
 *
 * @param {string} repoRoot - absolute repo root
 * @param {string} linkTarget - repo-relative path
 * @returns {boolean}
 */
function linkExists(repoRoot, linkTarget) {
  // Try as-is and with .md extension
  const candidates = [linkTarget];
  if (!path.extname(linkTarget)) {
    candidates.push(linkTarget + '.md');
  }
  for (const candidate of candidates) {
    const fullPath = path.resolve(repoRoot, candidate);
    const relative = path.relative(path.resolve(repoRoot), fullPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      continue;
    }
    try {
      fs.accessSync(fullPath);
      return true;
    } catch (_e) {
      // continue
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Inventory construction
// ---------------------------------------------------------------------------

/**
 * Build a complete inventory of documentation artifacts.
 *
 * @param {Object} options
 * @param {string} options.repoRoot - absolute path to repository root
 * @param {string} [options.docsMapPath] - path to docs-map YAML
 * @returns {Object} inventory object
 */
function buildInventory(options) {
  const repoRoot = path.resolve(options.repoRoot);
  const docsMapPath = options.docsMapPath || path.join(repoRoot, 'config/docs-map.yml');

  let docsMap = null;
  let canonicalIndex = new Map();
  let topicIndex = new Map();
  try {
    docsMap = loadDocsMap(docsMapPath);
    canonicalIndex = buildDocsMapCanonicalIndex(docsMap);
    topicIndex = buildDocsMapTopicIndex(docsMap);
  } catch (_e) {
    // No docs-map — proceed without it
  }

  const discovered = discoverDocs(repoRoot);

  // Build per-file records
  const records = [];
  const allPaths = new Set();

  for (const item of discovered) {
    const fullPath = path.resolve(repoRoot, item.path);
    let text = null;
    try {
      text = fs.readFileSync(fullPath, 'utf8');
    } catch (_e) {
      // Binary or unreadable
    }

    const classification = classifyArtifact(item.path, text, canonicalIndex);
    const title = extractTitle(text);
    const frontmatter = parseFrontmatter(text) || {};

    // docs-map topics
    let topics = [];
    if (topicIndex.has(item.path)) {
      topics = sortStrings(topicIndex.get(item.path));
    }

    // Outgoing links (Markdown only)
    let outgoingLinks = [];
    let brokenLinks = [];
    if (item.format === 'md' && text) {
      const rawLinks = extractLinks(text);
      // Resolve each link relative to the source file's directory
      outgoingLinks = rawLinks.map(link => resolveLink(item.path, link));
      outgoingLinks = sortStrings(Array.from(new Set(outgoingLinks)));
      for (const link of outgoingLinks) {
        if (!linkExists(repoRoot, link)) {
          brokenLinks.push(link);
        }
      }
      brokenLinks = sortStrings(brokenLinks);
    }

    records.push({
      path: item.path,
      format: item.format,
      title: title,
      owner: frontmatter.owner || null,
      last_verified: frontmatter.last_verified || null,
      supersedes: frontmatter.supersedes || null,
      superseded_by: frontmatter.superseded_by || null,
      generator: frontmatter.generator || null,
      class: classification.class,
      authority: classification.authority,
      classification_reason: classification.reason,
      migration_state: classification.migration_state,
      proposed_target: classification.proposed_target,
      docs_map_topics: topics,
      outgoing_links: outgoingLinks,
      inbound_link_count: 0, // filled in below
      broken_links: brokenLinks
    });

    allPaths.add(item.path);
  }

  // Compute inbound link counts
  // Build a map: target path -> count
  const inboundCounts = new Map();
  for (const record of records) {
    for (const link of record.outgoing_links) {
      // Links are already resolved to repo-relative paths
      const candidates = [link];
      if (!path.extname(link)) {
        candidates.push(link + '.md');
      }
      for (const candidate of candidates) {
        if (allPaths.has(candidate)) {
          inboundCounts.set(candidate, (inboundCounts.get(candidate) || 0) + 1);
        }
      }
    }
  }

  for (const record of records) {
    record.inbound_link_count = inboundCounts.get(record.path) || 0;
  }

  // Sort records by path for deterministic output
  records.sort((a, b) => a.path.localeCompare(b.path));

  // Build summary
  const classCounts = {};
  for (const r of records) {
    classCounts[r.class] = (classCounts[r.class] || 0) + 1;
  }

  return {
    schema_version: 1,
    repo_root: toPosix(relPath(repoRoot, repoRoot)) || '.',
    total_artifacts: records.length,
    by_class: classCounts,
    artifacts: records
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo-root') out.repoRoot = argv[++i];
    else if (arg === '--output') out.output = argv[++i];
    else if (arg === '--write') out.write = true;
    else if (arg === '--check') out.check = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function usage() {
  return [
    'usage: node build-migration-inventory.js [options]',
    '',
    'Options:',
    '  --repo-root <path>   AgentX project root (default: ../.. from core)',
    '  --output <path>      output inventory YAML path (default: docs/progress/documentation-migration/inventory.yml)',
    '  --write              write inventory to --output path',
    '  --check              fail when inventory is missing or differs'
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return;
  }

  const repoRoot = path.resolve(args.repoRoot || path.resolve(__dirname, '../../..'));
  const defaultOutput = path.join(repoRoot, 'docs/progress/documentation-migration/inventory.yml');
  const outputPath = args.output ? path.resolve(args.output) : defaultOutput;

  const inventory = buildInventory({ repoRoot });
  const yaml = renderYaml(inventory);

  if (args.check) {
    // Fail when the requested inventory is missing or differs
    let existing = null;
    try {
      existing = fs.readFileSync(outputPath, 'utf8');
    } catch (_e) {
      process.stderr.write(`inventory missing: ${outputPath}\n`);
      process.exit(1);
    }
    if (existing !== yaml) {
      process.stderr.write(`inventory differs from ${outputPath}\n`);
      process.exit(1);
    }
    process.stdout.write(`inventory up to date: ${outputPath}\n`);
    return;
  }

  if (args.write) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, yaml);
    // A YAML inventory under docs/ is itself part of the required corpus.
    // Rebuild once after the initial write so a new output converges and an
    // immediate --check observes the exact same artifact set.
    const convergedYaml = renderYaml(buildInventory({ repoRoot }));
    if (convergedYaml !== yaml) fs.writeFileSync(outputPath, convergedYaml);
    process.stdout.write(`inventory written: ${outputPath}\n`);
    return;
  }

  // Default: print YAML to stdout
  process.stdout.write(yaml);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`build-migration-inventory failed: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  SKIP_DIRS,
  DOC_EXTENSIONS,
  DATA_DOC_EXTENSIONS,
  ROOT_GOVERNANCE_FILES,
  parseFrontmatter,
  extractTitle,
  loadDocsMap,
  buildDocsMapCanonicalIndex,
  buildDocsMapTopicIndex,
  discoverDocs,
  classifyArtifact,
  extractLinks,
  resolveLink,
  linkExists,
  buildInventory,
  renderYaml,
  parseArgs,
  usage
};
