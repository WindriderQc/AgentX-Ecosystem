const express = require('express');
const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');
const { runAudit } = require('../scripts/docs-steward/run-audit');

const router = express.Router();

function hasDocsMap(candidate) {
  return fs.existsSync(path.join(candidate, 'config/docs-map.yml'));
}

function getRepoRoot() {
  if (process.env.DOCS_STEWARD_REPO_ROOT) {
    return path.resolve(process.env.DOCS_STEWARD_REPO_ROOT);
  }

  const candidates = [
    path.resolve(__dirname, '../..'),
    path.resolve(process.cwd(), '..'),
    path.resolve('/workspace/agentx'),
    path.resolve(process.cwd())
  ];

  const found = candidates.find(hasDocsMap);
  return found || candidates[0];
}

function assertAuditableRepoRoot(repoRoot) {
  if (!hasDocsMap(repoRoot)) {
    throw new Error(
      `Docs Steward repo root is unavailable at ${repoRoot}; expected config/docs-map.yml. ` +
      'Set DOCS_STEWARD_REPO_ROOT or mount the AgentX ecosystem root into Core.'
    );
  }
}

function getAuditRoot(repoRoot) {
  return path.resolve(process.env.DOCS_STEWARD_AUDIT_ROOT || path.join(repoRoot, 'docs/audits'));
}

function docsStewardDirName(name) {
  return /^docs-steward-\d{4}-\d{2}-\d{2}$/.test(name);
}

function readJsonIfPresent(filepath) {
  if (!fs.existsSync(filepath)) return null;
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

function readTextIfPresent(filepath) {
  if (!fs.existsSync(filepath)) return null;
  return fs.readFileSync(filepath, 'utf8');
}

function toRelative(repoRoot, targetPath) {
  const relative = path.relative(repoRoot, targetPath).replace(/\\/g, '/');
  return relative || '.';
}

function listRuns(repoRoot, limit = 20) {
  const auditRoot = getAuditRoot(repoRoot);
  if (!fs.existsSync(auditRoot)) return [];
  return fs.readdirSync(auditRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && docsStewardDirName(entry.name))
    .map(entry => {
      const dir = path.join(auditRoot, entry.name);
      const findingsPath = path.join(dir, 'findings.json');
      const summaryPath = path.join(dir, 'summary.md');
      const docMapCheckPath = path.join(dir, 'doc-map-check.json');
      let metadata = null;
      let error = null;
      try {
        const findings = readJsonIfPresent(findingsPath);
        metadata = findings ? findings.scan_metadata : null;
      } catch (err) {
        error = err.message;
      }
      return {
        name: entry.name,
        dir: toRelative(repoRoot, dir),
        status: metadata ? metadata.status : 'unknown',
        generated: metadata ? metadata.timestamp_utc : null,
        total_findings: metadata ? metadata.total_findings : null,
        findings_by_severity: metadata ? metadata.findings_by_severity : null,
        paths: {
          findings: toRelative(repoRoot, findingsPath),
          summary: toRelative(repoRoot, summaryPath),
          doc_map_check: toRelative(repoRoot, docMapCheckPath)
        },
        ...(error ? { error } : {})
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, limit);
}

function getLatestRun(repoRoot) {
  const runs = listRuns(repoRoot, 1);
  if (!runs.length) return null;
  const run = runs[0];
  const dir = path.resolve(repoRoot, run.dir);
  return {
    ...run,
    findings: readJsonIfPresent(path.join(dir, 'findings.json')),
    summary: readTextIfPresent(path.join(dir, 'summary.md')),
    doc_map_check: readJsonIfPresent(path.join(dir, 'doc-map-check.json'))
  };
}

function auditResponse(repoRoot, result) {
  return {
    report: 'docs-steward-audit',
    generated: result.audit.scan_metadata.timestamp_utc,
    audit_status: result.audit.scan_metadata.status,
    total_findings: result.audit.scan_metadata.total_findings,
    findings_by_type: result.audit.scan_metadata.findings_by_type,
    findings_by_severity: result.audit.scan_metadata.findings_by_severity,
    paths: {
      output_dir: toRelative(repoRoot, result.outputDir),
      findings: toRelative(repoRoot, result.findingsPath),
      summary: toRelative(repoRoot, result.summaryPath),
      doc_map_check: toRelative(repoRoot, result.docMapCheckPath)
    },
    findings: result.audit.findings,
    doc_map_status: result.docMapCheck.status,
    doc_map_errors: result.docMapCheck.errors
  };
}

router.post('/audit', (req, res) => {
  const repoRoot = getRepoRoot();
  const stamp = new Date().toISOString().slice(0, 10);
  const auditRoot = getAuditRoot(repoRoot);
  const outputDir = path.join(auditRoot, `docs-steward-${stamp}`);
  const refreshDocJanitor = req.body && req.body.refreshDocJanitor === true;

  try {
    assertAuditableRepoRoot(repoRoot);
    const result = runAudit({ repoRoot, outputDir, refreshDocJanitor });
    logger.info('[docs-steward] audit generated', {
      status: result.audit.scan_metadata.status,
      findings: result.audit.scan_metadata.total_findings
    });
    res.json({
      status: 'success',
      data: auditResponse(repoRoot, result)
    });
  } catch (err) {
    logger.error('[docs-steward] audit failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message,
      code: 'DOCS_STEWARD_AUDIT_FAILED'
    });
  }
});

router.get('/latest', (req, res) => {
  const repoRoot = getRepoRoot();
  try {
    const latest = getLatestRun(repoRoot);
    if (!latest) {
      return res.status(404).json({
        status: 'error',
        message: 'No Docs Steward audit runs found',
        code: 'DOCS_STEWARD_NO_RUNS'
      });
    }
    res.json({ status: 'success', data: latest });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: err.message,
      code: 'DOCS_STEWARD_LATEST_FAILED'
    });
  }
});

router.get('/runs', (req, res) => {
  const repoRoot = getRepoRoot();
  const rawLimit = Number(req.query.limit || 20);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 20;
  try {
    res.json({
      status: 'success',
      data: {
        runs: listRuns(repoRoot, limit),
        limit
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: err.message,
      code: 'DOCS_STEWARD_RUNS_FAILED'
    });
  }
});

module.exports = router;
