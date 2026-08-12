const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

function writeFile(root, rel, text) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return full;
}

function writeFixtureRepo(root) {
  writeFile(root, 'docs/runtime.md', '# Runtime\n\nCurrent runtime notes.\n');
  writeFile(root, 'docs/support.md', '# Support\n');
  writeFile(root, 'docs/_archive/old.md', '# Old\nHistorical checkout: /home/agentx/codes/agentx-platform.\n');
  writeFile(root, 'config/runtime.yml', 'enabled: true\n');
  writeFile(root, 'config/docs-map.yml', `
schema_version: 1
updated: 2026-06-19
topics:
  - id: runtime
    title: Runtime
    canonical: ./docs/runtime.md
    verify_against:
      - ./config/runtime.yml
    supporting:
      - ./docs/support.md
    historical_allowed:
      - ./docs/_archive/old.md
`);
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/docs-steward', require('../../routes/docs-steward'));
  return app;
}

describe('Docs Steward API routes', () => {
  let repoDir;
  let previousRepoRoot;
  let previousAuditRoot;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-steward-api-'));
    writeFixtureRepo(repoDir);
    previousRepoRoot = process.env.DOCS_STEWARD_REPO_ROOT;
    previousAuditRoot = process.env.DOCS_STEWARD_AUDIT_ROOT;
    process.env.DOCS_STEWARD_REPO_ROOT = repoDir;
    process.env.DOCS_STEWARD_AUDIT_ROOT = path.join(repoDir, 'docs/audits');
  });

  afterEach(() => {
    if (previousRepoRoot === undefined) {
      delete process.env.DOCS_STEWARD_REPO_ROOT;
    } else {
      process.env.DOCS_STEWARD_REPO_ROOT = previousRepoRoot;
    }

    if (previousAuditRoot === undefined) {
      delete process.env.DOCS_STEWARD_AUDIT_ROOT;
    } else {
      process.env.DOCS_STEWARD_AUDIT_ROOT = previousAuditRoot;
    }

    if (repoDir) {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
    jest.clearAllMocks();
  });

  test('POST /audit writes an audit bundle and returns run metadata', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/api/docs-steward/audit')
      .send({})
      .expect(200);

    expect(response.body.status).toBe('success');
    expect(response.body.data.audit_status).toBe('ok');
    expect(response.body.data.total_findings).toBe(0);
    expect(response.body.data.paths.output_dir).toMatch(/^docs\/audits\/docs-steward-\d{4}-\d{2}-\d{2}$/);

    const findingsPath = path.resolve(repoDir, response.body.data.paths.findings);
    const summaryPath = path.resolve(repoDir, response.body.data.paths.summary);
    const docMapCheckPath = path.resolve(repoDir, response.body.data.paths.doc_map_check);

    expect(fs.existsSync(findingsPath)).toBe(true);
    expect(fs.existsSync(summaryPath)).toBe(true);
    expect(fs.existsSync(docMapCheckPath)).toBe(true);
  });

  test('GET /latest and /runs expose generated audits', async () => {
    const app = createApp();

    await request(app)
      .post('/api/docs-steward/audit')
      .send({})
      .expect(200);

    const latest = await request(app)
      .get('/api/docs-steward/latest')
      .expect(200);

    expect(latest.body.status).toBe('success');
    expect(latest.body.data.status).toBe('ok');
    expect(latest.body.data.findings.scan_metadata.total_findings).toBe(0);
    expect(latest.body.data.summary).toMatch(/Docs Steward Audit/);

    const runs = await request(app)
      .get('/api/docs-steward/runs?limit=1')
      .expect(200);

    expect(runs.body.status).toBe('success');
    expect(runs.body.data.limit).toBe(1);
    expect(runs.body.data.runs).toHaveLength(1);
    expect(runs.body.data.runs[0].status).toBe('ok');
  });

  test('GET /latest returns 404 when no audits exist', async () => {
    const app = createApp();

    const response = await request(app)
      .get('/api/docs-steward/latest')
      .expect(404);

    expect(response.body).toMatchObject({
      status: 'error',
      code: 'DOCS_STEWARD_NO_RUNS',
    });
  });
});
