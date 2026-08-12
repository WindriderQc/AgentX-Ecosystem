const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadDocsMap,
  validateDocsMap,
  scanStaleCheckoutPaths,
  runAudit
} = require('../../../scripts/docs-steward/run-audit');

function writeFile(root, rel, text) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return full;
}

function writeDocsMap(root, body) {
  return writeFile(root, 'config/docs-map.yml', body);
}

describe('Docs Steward audit runner', () => {
  let repoDir;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-steward-'));
  });

  afterEach(() => {
    if (repoDir) {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('validateDocsMap reports missing local paths', () => {
    writeFile(repoDir, 'docs/canonical.md', '# Canonical\n');
    const mapPath = writeDocsMap(repoDir, `
schema_version: 1
updated: 2026-06-19
topics:
  - id: demo
    title: Demo
    canonical: ./docs/canonical.md
    verify_against:
      - ./missing/runtime.yml
    supporting: []
    historical_allowed: []
`);

    const map = loadDocsMap(mapPath);
    const check = validateDocsMap(map, repoDir, mapPath);

    expect(check.status).toBe('fail');
    expect(check.errors.join('\n')).toMatch(/missing.*runtime/);
  });

  test('scanStaleCheckoutPaths flags active stale checkout paths but skips historical mentions', () => {
    writeFile(repoDir, 'docs/active.md', 'Run commands in /home/agentx/codes/agentx-platform now.\n');
    writeFile(repoDir, 'docs/history.md', 'Historical note: /home/agentx/codes/agentx-platform was old.\n');
    const mapPath = writeDocsMap(repoDir, `
schema_version: 1
updated: 2026-06-19
topics:
  - id: demo
    title: Demo
    canonical: ./docs/active.md
    verify_against: []
    supporting:
      - ./docs/history.md
    historical_allowed: []
`);

    const map = loadDocsMap(mapPath);
    const findings = scanStaleCheckoutPaths(map, repoDir);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      type: 'stale_instruction',
      severity: 'high',
      topic: 'demo'
    });
    expect(findings[0].evidence[0].path).toBe('docs/active.md');
  });

  test('runAudit writes output files and detects newer verification sources', () => {
    const canonical = writeFile(repoDir, 'docs/canonical.md', '# Canonical\n');
    const runtime = writeFile(repoDir, 'config/runtime.yml', 'value: newer\n');
    writeDocsMap(repoDir, `
schema_version: 1
updated: 2026-06-19
topics:
  - id: runtime
    title: Runtime
    canonical: ./docs/canonical.md
    verify_against:
      - ./config/runtime.yml
    supporting: []
    historical_allowed: []
`);

    fs.utimesSync(canonical, new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));
    fs.utimesSync(runtime, new Date('2026-06-10T00:00:00Z'), new Date('2026-06-10T00:00:00Z'));

    const outDir = path.join(repoDir, 'out');
    const result = runAudit({
      repoRoot: repoDir,
      outputDir: outDir,
      now: new Date('2026-06-19T12:00:00Z')
    });

    expect(fs.existsSync(result.findingsPath)).toBe(true);
    expect(fs.existsSync(result.summaryPath)).toBe(true);
    expect(fs.existsSync(result.docMapCheckPath)).toBe(true);
    expect(result.audit.schema_version).toBe(1);
    expect(result.audit.findings.some(f => f.type === 'missing_doc_update')).toBe(true);
    expect(result.audit.scan_metadata.status).toBe('warn');
  });
});
