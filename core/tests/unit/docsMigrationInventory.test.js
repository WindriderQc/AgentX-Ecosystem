'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SKIP_DIRS,
  ROOT_GOVERNANCE_FILES,
  parseFrontmatter,
  extractTitle,
  buildDocsMapCanonicalIndex,
  buildDocsMapTopicIndex,
  discoverDocs,
  classifyArtifact,
  extractLinks,
  linkExists,
  buildInventory,
  renderYaml,
  parseArgs
} = require('../../scripts/docs-steward/build-migration-inventory');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTempRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-test-'));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return dir;
}

function cleanupTempRepo(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_e) {
    // ignore
  }
}

// Minimal docs-map for tests
const TEST_DOCS_MAP = {
  schema_version: 1,
  topics: [
    {
      id: 'governance',
      title: 'Governance',
      canonical: './GOVERNANCE.md',
      verify_against: [],
      supporting: [],
      historical_allowed: []
    },
    {
      id: 'docker',
      title: 'Docker runtime',
      canonical: './DOCKER.md',
      verify_against: [],
      supporting: [],
      historical_allowed: []
    }
  ]
};

// ---------------------------------------------------------------------------
// Discovery tests
// ---------------------------------------------------------------------------

describe('discoverDocs — exclusions', () => {
  let repoDir;

  beforeAll(() => {
    repoDir = makeTempRepo({
      'docs/README.md': '# Docs',
      'docs/sub/guide.md': '# Guide',
      'node_modules/pkg/README.md': '# Node Module',
      'coverage/report.md': '# Coverage',
      'dist/bundle.md': '# Dist',
      'build/output.md': '# Build',
      '.git/HEAD.md': '# Git',
      '.worktrees/wt/doc.md': '# Worktree',
      'worktrees/wt/doc.md': '# Worktree',
      'backups/snapshot/doc.md': '# Backup',
      '.agentx/scratch/plan.md': '# Scratch',
      'vendor/pkg/README.md': '# Vendored Dependency',
      '.claude/notes.md': '# Claude',
      'logs/run.md': '# Logs',
      'test-results/result.md': '# Test Results',
      'docs/audit.json': '{"key":"value"}',
      'docs/config.yml': 'key: value'
    });
  });

  afterAll(() => cleanupTempRepo(repoDir));

  test('discovers Markdown files outside excluded directories', () => {
    const found = discoverDocs(repoDir).map(d => d.path);
    expect(found).toContain('docs/README.md');
    expect(found).toContain('docs/sub/guide.md');
  });

  test('excludes dependencies, build output, backups, worktrees, and agent scratch state', () => {
    const found = discoverDocs(repoDir).map(d => d.path);
    expect(found).not.toContain('node_modules/pkg/README.md');
    expect(found).not.toContain('coverage/report.md');
    expect(found).not.toContain('dist/bundle.md');
    expect(found).not.toContain('build/output.md');
    expect(found).not.toContain('.git/HEAD.md');
    expect(found).not.toContain('.worktrees/wt/doc.md');
    expect(found).not.toContain('worktrees/wt/doc.md');
    expect(found).not.toContain('backups/snapshot/doc.md');
    expect(found).not.toContain('.agentx/scratch/plan.md');
    expect(found).not.toContain('vendor/pkg/README.md');
    expect(found).not.toContain('.claude/notes.md');
    expect(found).not.toContain('logs/run.md');
    expect(found).not.toContain('test-results/result.md');
  });

  test('discovers JSON and YAML artifacts under docs/', () => {
    const found = discoverDocs(repoDir).map(d => d.path);
    expect(found).toContain('docs/audit.json');
    expect(found).toContain('docs/config.yml');
  });

  test('does not discover JSON/YAML outside docs/', () => {
    const found = discoverDocs(repoDir).map(d => d.path);
    expect(found).not.toContain('package.json');
  });
});

// ---------------------------------------------------------------------------
// Frontmatter parsing tests
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  test('parses valid frontmatter with doc_type', () => {
    const text = '---\ndoc_type: permanent\nauthority: canonical\nstatus: active\n---\n\n# Title';
    const fm = parseFrontmatter(text);
    expect(fm.doc_type).toBe('permanent');
    expect(fm.authority).toBe('canonical');
    expect(fm.status).toBe('active');
  });

  test('returns null when no frontmatter block', () => {
    const text = '# No Frontmatter\n\nJust content.';
    const fm = parseFrontmatter(text);
    expect(fm).toBeNull();
  });

  test('handles null values', () => {
    const text = '---\nsupersedes: null\nsuperseded_by: null\n---\n\n# Title';
    const fm = parseFrontmatter(text);
    expect(fm.supersedes).toBeNull();
    expect(fm.superseded_by).toBeNull();
  });

  test('handles quoted values', () => {
    const text = '---\nowner: "docs-steward"\nnotes: \'single quoted\'\n---\n\n# Title';
    const fm = parseFrontmatter(text);
    expect(fm.owner).toBe('docs-steward');
    expect(fm.notes).toBe('single quoted');
  });
});

// ---------------------------------------------------------------------------
// Classification tests
// ---------------------------------------------------------------------------

describe('classifyArtifact — frontmatter precedence', () => {
  test('valid frontmatter doc_type takes precedence over location', () => {
    const canonicalIndex = new Map();
    const result = classifyArtifact('docs/random/doc.md', '---\ndoc_type: permanent\nauthority: canonical\n---\n\n# Doc', canonicalIndex);
    expect(result.class).toBe('permanent');
    expect(result.reason).toBe('frontmatter doc_type');
  });

  test('invalid frontmatter doc_type is ignored and falls through', () => {
    const canonicalIndex = new Map();
    const result = classifyArtifact('docs/random/doc.md', '---\ndoc_type: unknown\n---\n\n# Doc', canonicalIndex);
    expect(result.class).not.toBe('unknown');
  });
});

describe('classifyArtifact — all four classes', () => {
  test('historical: docs/_archive', () => {
    const canonicalIndex = new Map();
    const result = classifyArtifact('docs/_archive/2026-04/old.md', '# Old', canonicalIndex);
    expect(result.class).toBe('historical');
    expect(result.authority).toBe('snapshot');
  });

  test('historical: service-local docs/_archive', () => {
    const canonicalIndex = new Map();
    const result = classifyArtifact('benchmark/docs/_archive/plans/old.md', '# Old', canonicalIndex);
    expect(result.class).toBe('historical');
    expect(result.migration_state).toBe('archived');
  });

  test('generated: docs/audits', () => {
    const canonicalIndex = new Map();
    const result = classifyArtifact('docs/audits/scan-2026-07-17.md', '# Scan', canonicalIndex);
    expect(result.class).toBe('generated');
    expect(result.authority).toBe('evidence');
  });

  test('generated: reports/', () => {
    const canonicalIndex = new Map();
    const result = classifyArtifact('reports/sub/report.md', '# Report', canonicalIndex);
    expect(result.class).toBe('generated');
    expect(result.authority).toBe('evidence');
  });

  test('generated: service-local reports/', () => {
    const canonicalIndex = new Map();
    const result = classifyArtifact('benchmark/reports/benchmarks/audit.md', '# Audit', canonicalIndex);
    expect(result.class).toBe('generated');
    expect(result.migration_state).toBe('generated');
  });

  test('progression: docs/progress', () => {
    const canonicalIndex = new Map();
    const result = classifyArtifact('docs/progress/plan.md', '# Plan', canonicalIndex);
    expect(result.class).toBe('progression');
    expect(result.authority).toBe('supporting');
  });

  test('permanent: root governance file', () => {
    const canonicalIndex = new Map();
    const result = classifyArtifact('GOVERNANCE.md', '# Governance', canonicalIndex);
    expect(result.class).toBe('permanent');
    expect(result.authority).toBe('canonical');
    expect(result.reason).toBe('permanent root governance file');
  });

  test('permanent: service-local instruction authority', () => {
    const canonicalIndex = new Map();
    const result = classifyArtifact('core/AGENTS.md', '# Core Agent', canonicalIndex);
    expect(result.class).toBe('permanent');
    expect(result.authority).toBe('canonical');
    expect(result.reason).toBe('service-local instruction authority');
  });

  test('permanent: ecosystem role definition authority', () => {
    const canonicalIndex = new Map();
    const result = classifyArtifact('roles/Worker.md', '# Worker', canonicalIndex);
    expect(result.class).toBe('permanent');
    expect(result.authority).toBe('supporting');
    expect(result.reason).toBe('ecosystem role definition authority');
  });

  test('permanent: accepted decision location', () => {
    const canonicalIndex = new Map();
    const result = classifyArtifact('docs/decisions/0001-shape.md', '# ADR 0001', canonicalIndex);
    expect(result.class).toBe('permanent');
    expect(result.reason).toBe('accepted decision location');
  });

  test('permanent: docs/ai-ops/decisions location', () => {
    const canonicalIndex = new Map();
    const result = classifyArtifact('docs/ai-ops/decisions/0001-test.md', '# ADR', canonicalIndex);
    expect(result.class).toBe('permanent');
    expect(result.reason).toBe('accepted decision location');
  });
});

describe('classifyArtifact — docs-map canonical precedence', () => {
  test('docs-map canonical entry is classified permanent', () => {
    const canonicalIndex = new Map([['DOCKER.md', ['docker']]]);
    const result = classifyArtifact('DOCKER.md', '# Docker', canonicalIndex);
    expect(result.class).toBe('permanent');
    expect(result.reason).toBe('docs-map canonical entry');
  });

  test('docs-map canonical entry outside special dirs is permanent', () => {
    // A file NOT in audits/_archive/progress that is a docs-map canonical entry
    const canonicalIndex = new Map([['docs/custom/canonical.md', ['custom-topic']]])
    const result = classifyArtifact('docs/custom/canonical.md', '# Custom', canonicalIndex);
    expect(result.class).toBe('permanent');
    expect(result.reason).toBe('docs-map canonical entry');
  });
});

describe('classifyArtifact — conservative needs_review behavior', () => {
  test('ambiguous file with no signals gets needs_review', () => {
    const canonicalIndex = new Map();
    const result = classifyArtifact('docs/random-notes.md', '# Random Notes\n\nSome content.', canonicalIndex);
    expect(result.migration_state).toBe('needs_review');
  });

  test('dated filename without frontmatter gets needs_review', () => {
    const canonicalIndex = new Map();
    const result = classifyArtifact('docs/notes/plan-2026-06-15.md', '# Plan', canonicalIndex);
    expect(result.migration_state).toBe('needs_review');
    expect(result.class).toBe('progression');
  });

  test('content hint with "archived" gets needs_review', () => {
    const canonicalIndex = new Map();
    const result = classifyArtifact('docs/notes/old.md', '# Old Doc\n\nThis is archived content.', canonicalIndex);
    expect(result.migration_state).toBe('needs_review');
  });

  test('archive-like sibling path does not inherit archive authority', () => {
    const canonicalIndex = new Map();
    const result = classifyArtifact('docs/_archive-notes/old.md', '# Notes', canonicalIndex);
    expect(result.reason).not.toBe('located in docs/_archive');
    expect(result.migration_state).toBe('needs_review');
  });
});

// ---------------------------------------------------------------------------
// Link extraction tests
// ---------------------------------------------------------------------------

describe('extractLinks', () => {
  test('extracts repo-relative links', () => {
    const text = '[Link](../other.md) and [Another](./sub/page.md)';
    const links = extractLinks(text);
    expect(links).toEqual(['../other.md', 'sub/page.md']);
  });

  test('ignores anchors', () => {
    const text = '[Section](page.md#section)';
    const links = extractLinks(text);
    expect(links).toEqual(['page.md']);
  });

  test('ignores mailto links', () => {
    const text = '[Email](mailto:user@example.com)';
    const links = extractLinks(text);
    expect(links).toEqual([]);
  });

  test('ignores HTTP links', () => {
    const text = '[External](https://example.com/page)';
    const links = extractLinks(text);
    expect(links).toEqual([]);
  });

  test('ignores any URI scheme and protocol-relative links', () => {
    const text = '[Telephone](tel:+15551212) [Data](data:text/plain,x) [CDN](//example.com/a)';
    expect(extractLinks(text)).toEqual([]);
  });

  test('extracts angle-bracket paths and removes optional link titles', () => {
    const text = '[Spaced](<folder/a file.md>) [Titled](page.md "Page title")';
    expect(extractLinks(text)).toEqual(['folder/a file.md', 'page.md']);
  });

  test('returns sorted unique links', () => {
    const text = '[B](b.md) [A](a.md) [A again](a.md)';
    const links = extractLinks(text);
    expect(links).toEqual(['a.md', 'b.md']);
  });
});

describe('linkExists', () => {
  let repoDir;

  beforeAll(() => {
    repoDir = makeTempRepo({
      'docs/page.md': '# Page',
      'docs/guide.md': '# Guide'
    });
  });

  afterAll(() => cleanupTempRepo(repoDir));

  test('returns true for existing file', () => {
    expect(linkExists(repoDir, 'docs/page.md')).toBe(true);
  });

  test('returns true when .md extension is added', () => {
    expect(linkExists(repoDir, 'docs/page')).toBe(true);
  });

  test('returns false for missing file', () => {
    expect(linkExists(repoDir, 'docs/missing.md')).toBe(false);
  });

  test('does not resolve links outside the repository', () => {
    const outside = path.join(repoDir, '..', `${path.basename(repoDir)}-outside.md`);
    fs.writeFileSync(outside, '# Outside');
    try {
      expect(linkExists(repoDir, `../${path.basename(outside)}`)).toBe(false);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Inventory construction tests
// ---------------------------------------------------------------------------

describe('buildInventory — link topology', () => {
  let repoDir;

  beforeAll(() => {
    repoDir = makeTempRepo({
      'docs/page-a.md': '# Page A\n\nLink to [Page B](page-b.md).',
      'docs/page-b.md': '# Page B\n\nLink to [Page A](page-a.md) and [Missing](missing.md).',
      'docs/sub/other.md': '# Other\n\nNo links here.'
    });
  });

  afterAll(() => cleanupTempRepo(repoDir));

  test('records outgoing links', () => {
    const inv = buildInventory({ repoRoot: repoDir });
    const pageA = inv.artifacts.find(a => a.path === 'docs/page-a.md');
    expect(pageA.outgoing_links).toEqual(['docs/page-b.md']);
  });

  test('records broken links', () => {
    const inv = buildInventory({ repoRoot: repoDir });
    const pageB = inv.artifacts.find(a => a.path === 'docs/page-b.md');
    expect(pageB.broken_links).toEqual(['docs/missing.md']);
  });

  test('records inbound link counts', () => {
    const inv = buildInventory({ repoRoot: repoDir });
    const pageA = inv.artifacts.find(a => a.path === 'docs/page-a.md');
    const pageB = inv.artifacts.find(a => a.path === 'docs/page-b.md');
    expect(pageA.inbound_link_count).toBe(1);
    expect(pageB.inbound_link_count).toBe(1);
  });
});

describe('buildInventory — deterministic ordering', () => {
  let repoDir;

  beforeAll(() => {
    repoDir = makeTempRepo({
      'docs/zebra.md': '# Zebra',
      'docs/apple.md': '# Apple',
      'docs/mango.md': '# Mango'
    });
  });

  afterAll(() => cleanupTempRepo(repoDir));

  test('artifacts are sorted by path', () => {
    const inv = buildInventory({ repoRoot: repoDir });
    const paths = inv.artifacts.map(a => a.path);
    expect(paths).toEqual(paths.slice().sort());
  });

  test('same input produces same output', () => {
    const inv1 = buildInventory({ repoRoot: repoDir });
    const inv2 = buildInventory({ repoRoot: repoDir });
    expect(renderYaml(inv1)).toBe(renderYaml(inv2));
  });

  test('YAML has no volatile timestamp', () => {
    const inv = buildInventory({ repoRoot: repoDir });
    const yaml = renderYaml(inv);
    expect(yaml).not.toMatch(/timestamp|created_at|generated_at|scanned_at/i);
  });
});

describe('buildInventory — source metadata', () => {
  let repoDir;

  beforeAll(() => {
    repoDir = makeTempRepo({
      'docs/progress/plan.md': [
        '---',
        'doc_type: progression',
        'owner: platform-governance',
        'last_verified: 2026-07-17',
        'supersedes: null',
        'superseded_by: docs/operations/current.md',
        'generator: docs-migration',
        '---',
        '# Plan'
      ].join('\n')
    });
  });

  afterAll(() => cleanupTempRepo(repoDir));

  test('records preservation metadata without inventing missing values', () => {
    const inv = buildInventory({ repoRoot: repoDir });
    const plan = inv.artifacts.find(a => a.path === 'docs/progress/plan.md');
    expect(plan).toMatchObject({
      owner: 'platform-governance',
      last_verified: '2026-07-17',
      supersedes: null,
      superseded_by: 'docs/operations/current.md',
      generator: 'docs-migration'
    });
  });
});

// ---------------------------------------------------------------------------
// YAML rendering tests
// ---------------------------------------------------------------------------

describe('renderYaml', () => {
  test('renders valid YAML with all required fields', () => {
    const inv = {
      schema_version: 1,
      repo_root: '.',
      total_artifacts: 1,
      by_class: { permanent: 1 },
      artifacts: [{
        path: 'GOVERNANCE.md',
        format: 'md',
        title: 'Governance',
        owner: 'platform-governance',
        last_verified: '2026-07-17',
        supersedes: null,
        superseded_by: null,
        generator: null,
        class: 'permanent',
        authority: 'canonical',
        classification_reason: 'permanent root governance file',
        migration_state: 'current',
        proposed_target: null,
        docs_map_topics: ['governance'],
        outgoing_links: [],
        inbound_link_count: 0,
        broken_links: []
      }]
    };
    const yaml = renderYaml(inv);
    expect(yaml).toContain('path: GOVERNANCE.md');
    expect(yaml).toContain('class: permanent');
    expect(yaml).toContain('authority: canonical');
    expect(yaml).toContain('classification_reason:');
    expect(yaml).toContain('owner: platform-governance');
    expect(yaml).toContain('last_verified: "2026-07-17"');
    expect(yaml).toContain('generator: null');
    expect(yaml).toContain('migration_state: current');
    expect(yaml).toContain('proposed_target: null');
    expect(yaml).toContain('docs_map_topics:');
    expect(yaml).toContain('outgoing_links: []');
    expect(yaml).toContain('inbound_link_count: 0');
    expect(yaml).toContain('broken_links: []');
  });
});

// ---------------------------------------------------------------------------
// CLI tests
// ---------------------------------------------------------------------------

describe('CLI — parseArgs', () => {
  test('parses --repo-root', () => {
    const args = parseArgs(['--repo-root', '/tmp/repo']);
    expect(args.repoRoot).toBe('/tmp/repo');
  });

  test('parses --output', () => {
    const args = parseArgs(['--output', '/tmp/inv.yml']);
    expect(args.output).toBe('/tmp/inv.yml');
  });

  test('parses --write flag', () => {
    const args = parseArgs(['--write']);
    expect(args.write).toBe(true);
  });

  test('parses --check flag', () => {
    const args = parseArgs(['--check']);
    expect(args.check).toBe(true);
  });
});

describe('CLI — write and check behavior', () => {
  let repoDir;
  let outputPath;

  beforeAll(() => {
    repoDir = makeTempRepo({
      'docs/README.md': '# Docs',
      'GOVERNANCE.md': '# Governance'
    });
    outputPath = path.join(repoDir, 'docs/progress/documentation-migration/inventory.yml');
  });

  afterAll(() => cleanupTempRepo(repoDir));

  test('default (no flags) prints YAML without writing', () => {
    const { execSync } = require('child_process');
    const scriptPath = path.resolve(__dirname, '../../scripts/docs-steward/build-migration-inventory.js');
    const output = execSync(`node ${scriptPath} --repo-root ${repoDir}`, { encoding: 'utf8' });
    expect(output).toContain('schema_version: 1');
    expect(output).toContain('artifacts:');
    // File should not exist
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  test('--write creates the output file', () => {
    const { execSync } = require('child_process');
    const scriptPath = path.resolve(__dirname, '../../scripts/docs-steward/build-migration-inventory.js');
    execSync(`node ${scriptPath} --repo-root ${repoDir} --output ${outputPath} --write`, { encoding: 'utf8' });
    expect(fs.existsSync(outputPath)).toBe(true);
    const content = fs.readFileSync(outputPath, 'utf8');
    expect(content).toContain('schema_version: 1');
  });

  test('--check passes when inventory is up to date', () => {
    const { execSync } = require('child_process');
    const scriptPath = path.resolve(__dirname, '../../scripts/docs-steward/build-migration-inventory.js');
    // Should exit 0
    execSync(`node ${scriptPath} --repo-root ${repoDir} --output ${outputPath} --check`, { encoding: 'utf8' });
  });

  test('--check fails when inventory is missing', () => {
    const { execSync } = require('child_process');
    const scriptPath = path.resolve(__dirname, '../../scripts/docs-steward/build-migration-inventory.js');
    const missingPath = path.join(repoDir, 'missing-inventory.yml');
    let exitCode = 0;
    try {
      execSync(`node ${scriptPath} --repo-root ${repoDir} --output ${missingPath} --check`, { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      exitCode = err.status;
    }
    expect(exitCode).not.toBe(0);
  });

  test('--check fails when inventory differs', () => {
    const { execSync } = require('child_process');
    const scriptPath = path.resolve(__dirname, '../../scripts/docs-steward/build-migration-inventory.js');
    // Write a different content to the output
    fs.writeFileSync(outputPath, 'schema_version: 0\nstale: true\n');
    let exitCode = 0;
    try {
      execSync(`node ${scriptPath} --repo-root ${repoDir} --output ${outputPath} --check`, { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      exitCode = err.status;
    }
    expect(exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// docs-map canonical index tests
// ---------------------------------------------------------------------------

describe('buildDocsMapCanonicalIndex', () => {
  test('maps canonical paths to topic IDs', () => {
    const index = buildDocsMapCanonicalIndex(TEST_DOCS_MAP);
    expect(index.get('GOVERNANCE.md')).toEqual(['governance']);
    expect(index.get('DOCKER.md')).toEqual(['docker']);
  });

  test('skips external refs', () => {
    const mapWithExternal = {
      topics: [{
        id: 'ext',
        canonical: 'external:~/.openclaw/openclaw.json',
        verify_against: [],
        supporting: [],
        historical_allowed: []
      }]
    };
    const index = buildDocsMapCanonicalIndex(mapWithExternal);
    expect(index.size).toBe(0);
  });

  test('handles empty or missing topics', () => {
    expect(buildDocsMapCanonicalIndex({}).size).toBe(0);
    expect(buildDocsMapCanonicalIndex(null).size).toBe(0);
  });
});

describe('buildDocsMapTopicIndex', () => {
  test('maps canonical, supporting, and verification docs to their topics', () => {
    const docsMap = {
      topics: [{
        id: 'runtime',
        canonical: './DOCKER.md',
        supporting: ['./docs/operations/DEPLOYMENT.md'],
        verify_against: ['./WORKFLOW.md', './core/routes/pipeline.js', 'external:~/.openclaw/openclaw.json']
      }]
    };
    const index = buildDocsMapTopicIndex(docsMap);
    expect(index.get('DOCKER.md')).toEqual(['runtime']);
    expect(index.get('docs/operations/DEPLOYMENT.md')).toEqual(['runtime']);
    expect(index.get('WORKFLOW.md')).toEqual(['runtime']);
    expect(index.has('external:~/.openclaw/openclaw.json')).toBe(false);
  });
});
