#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const SCHEMA_VERSION = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FRESHNESS_GRACE_DAYS = 7;
const MEDIUM_FRESHNESS_DAYS = 14;
const FRESHNESS_GRACE_MS = FRESHNESS_GRACE_DAYS * MS_PER_DAY;
const FINDING_TYPES = [
  'runtime_mismatch',
  'authority_conflict',
  'stale_instruction',
  'missing_doc_update',
  'duplicate_source_of_truth',
  'historical_doc_leak',
  'unclear_ownership',
  'solution_drift'
];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'coverage', 'dist', 'build', 'logs',
  'test-results', '.worktrees', '.claude'
]);
const STALE_CHECKOUT_PATTERNS = [
  { id: 'old-linux-checkout', pattern: /\/home\/yb\/codes\/agentx-platform/i },
  { id: 'old-windows-new-project', pattern: /C:\\Users\\Example User\\OneDrive\\Documents\\New project/i },
  { id: 'old-tilde-checkout', pattern: /~\/codes\/agentx-platform/i }
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo-root') out.repoRoot = argv[++i];
    else if (arg === '--docs-map') out.docsMap = argv[++i];
    else if (arg === '--output-dir') out.outputDir = argv[++i];
    else if (arg === '--refresh-docjanitor') out.refreshDocJanitor = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function usage() {
  return [
    'usage: node scripts/docs-steward/run-audit.js [options]',
    '',
    'Options:',
    '  --repo-root <path>          AgentX project root (default: ../.. from core)',
    '  --docs-map <path>           docs-map YAML path (default: <root>/config/docs-map.yml)',
    '  --output-dir <path>         audit output dir (default: docs/audits/docs-steward-YYYY-MM-DD)',
    '  --refresh-docjanitor        run DocJanitor before reading latest output'
  ].join('\n');
}

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

function dateStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function isExternalRef(ref) {
  return typeof ref === 'string' && ref.startsWith('external:');
}

function displayRef(ref) {
  return isExternalRef(ref) ? ref.slice('external:'.length) : String(ref);
}

function resolveLocalRef(repoRoot, ref) {
  const value = String(ref);
  if (path.isAbsolute(value)) return value;
  return path.resolve(repoRoot, value.replace(/^\.\//, ''));
}

function loadDocsMap(mapPath) {
  const text = fs.readFileSync(mapPath, 'utf8');
  const parsed = yaml.load(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`docs map did not parse to an object: ${mapPath}`);
  }
  return parsed;
}

function topicEntries(topic) {
  const rows = [];
  for (const ref of normalizeList(topic.canonical)) {
    rows.push({ kind: 'canonical', ref });
  }
  for (const ref of normalizeList(topic.verify_against)) {
    rows.push({ kind: 'verify_against', ref });
  }
  for (const ref of normalizeList(topic.supporting)) {
    rows.push({ kind: 'supporting', ref });
  }
  return rows;
}

function validateDocsMap(map, repoRoot, mapPath) {
  const errors = [];
  const warnings = [];
  const entries = [];

  if (map.schema_version !== SCHEMA_VERSION) {
    errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(map.topics) || map.topics.length === 0) {
    errors.push('topics must be a non-empty array');
  }

  const seenIds = new Set();
  for (const topic of map.topics || []) {
    if (!topic || typeof topic !== 'object') {
      errors.push('topic entry must be an object');
      continue;
    }
    if (!topic.id) errors.push('topic missing id');
    if (topic.id && seenIds.has(topic.id)) errors.push(`duplicate topic id: ${topic.id}`);
    if (topic.id) seenIds.add(topic.id);
    if (!topic.title) warnings.push(`topic ${topic.id || '(unknown)'} missing title`);
    if (!topic.canonical) errors.push(`topic ${topic.id || '(unknown)'} missing canonical`);
    if (!Array.isArray(topic.historical_allowed)) {
      errors.push(`topic ${topic.id || '(unknown)'} historical_allowed must be an array`);
    }

    for (const entry of topicEntries(topic)) {
      if (typeof entry.ref !== 'string') {
        errors.push(`topic ${topic.id || '(unknown)'} ${entry.kind} entry must be a string`);
        continue;
      }
      if (isExternalRef(entry.ref)) {
        entries.push({
          topic: topic.id,
          kind: entry.kind,
          path: displayRef(entry.ref),
          status: 'external',
          reason: 'external runtime path'
        });
        continue;
      }

      const fullPath = resolveLocalRef(repoRoot, entry.ref);
      const exists = fs.existsSync(fullPath);
      const status = exists ? 'ok' : 'missing';
      entries.push({
        topic: topic.id,
        kind: entry.kind,
        path: relPath(repoRoot, fullPath),
        status,
        reason: exists ? 'exists' : 'path not found'
      });
      if (!exists) {
        errors.push(`missing ${entry.kind} path for ${topic.id}: ${entry.ref}`);
      }
    }
  }

  return {
    schema_version: SCHEMA_VERSION,
    checked_at: new Date().toISOString(),
    docs_map: relPath(repoRoot, mapPath),
    status: errors.length ? 'fail' : warnings.length ? 'warn' : 'ok',
    topics_checked: (map.topics || []).length,
    entries,
    errors,
    warnings
  };
}

function localTopicRefs(map, kinds) {
  const allowedKinds = new Set(kinds);
  const rows = [];
  for (const topic of map.topics || []) {
    for (const entry of topicEntries(topic)) {
      if (!allowedKinds.has(entry.kind) || isExternalRef(entry.ref)) continue;
      rows.push({ topic, kind: entry.kind, ref: entry.ref });
    }
  }
  return rows;
}

function firstLineEvidence(repoRoot, fullPath) {
  const relative = relPath(repoRoot, fullPath);
  if (!fs.existsSync(fullPath)) {
    return { path: relative, lines: '1', snippet: '(missing)' };
  }
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    return {
      path: relative,
      lines: '1',
      snippet: `(directory, mtime ${stat.mtime.toISOString()})`
    };
  }
  const text = fs.readFileSync(fullPath, 'utf8');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed) {
      return {
        path: relative,
        lines: String(i + 1),
        snippet: trimmed.slice(0, 300)
      };
    }
  }
  return { path: relative, lines: '1', snippet: '(empty file)' };
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'item';
}

function makeFinding(input) {
  if (!FINDING_TYPES.includes(input.type)) {
    throw new Error(`invalid finding type: ${input.type}`);
  }
  if (!SEVERITIES.includes(input.severity)) {
    throw new Error(`invalid finding severity: ${input.severity}`);
  }
  return input;
}

function lineAllowsHistoricalUse(line, topic) {
  const lower = line.toLowerCase();
  if (lower.includes('historical') || lower.includes('stale') || lower.includes('old ')) {
    return true;
  }
  for (const allowed of topic.historical_allowed || []) {
    if (allowed && line.includes(String(allowed))) return true;
  }
  return false;
}

function scanStaleCheckoutPaths(map, repoRoot) {
  const findings = [];
  let count = 0;
  for (const row of localTopicRefs(map, ['canonical', 'supporting'])) {
    const fullPath = resolveLocalRef(repoRoot, row.ref);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) continue;
    const text = fs.readFileSync(fullPath, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const stale of STALE_CHECKOUT_PATTERNS) {
        if (!stale.pattern.test(line)) continue;
        if (lineAllowsHistoricalUse(line, row.topic)) continue;
        const relative = relPath(repoRoot, fullPath);
        count += 1;
        findings.push(makeFinding({
          id: `stale-path-${slug(row.topic.id)}-${count}`,
          type: 'stale_instruction',
          severity: 'high',
          confidence: 'high',
          topic: row.topic.id,
          title: 'Active doc references stale checkout path',
          evidence: [{
            path: relative,
            lines: String(i + 1),
            snippet: line.trim().slice(0, 300)
          }],
          observation: `${relative}:${i + 1} references ${stale.id} outside allowed historical context.`,
          why_it_matters: 'Agents may run commands against the wrong checkout or copy obsolete host assumptions into active work.',
          suggested_action: 'Rewrite the instruction to use a project-root-relative path, or explicitly mark the path as historical if it is only context.'
        }));
      }
    }
  }
  return findings;
}

function maxMtime(repoRoot, fullPath) {
  if (!fs.existsSync(fullPath)) return null;
  const stat = fs.statSync(fullPath);
  if (!stat.isDirectory()) {
    return { fullPath, mtimeMs: stat.mtimeMs, mtime: stat.mtime };
  }

  let best = { fullPath, mtimeMs: stat.mtimeMs, mtime: stat.mtime };
  for (const entry of fs.readdirSync(fullPath, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = path.join(fullPath, entry.name);
    const childBest = maxMtime(repoRoot, child);
    if (childBest && childBest.mtimeMs > best.mtimeMs) best = childBest;
  }
  return best;
}

function compareFreshness(map, repoRoot) {
  const findings = [];
  let count = 0;

  for (const topic of map.topics || []) {
    const canonicalRef = normalizeList(topic.canonical).find(ref => !isExternalRef(ref));
    if (!canonicalRef) continue;
    const canonicalPath = resolveLocalRef(repoRoot, canonicalRef);
    const canonicalMtime = maxMtime(repoRoot, canonicalPath);
    if (!canonicalMtime) continue;

    let newestVerify = null;
    for (const verifyRef of normalizeList(topic.verify_against)) {
      if (isExternalRef(verifyRef)) continue;
      const verifyPath = resolveLocalRef(repoRoot, verifyRef);
      const verifyMtime = maxMtime(repoRoot, verifyPath);
      if (!verifyMtime) continue;
      if (!newestVerify || verifyMtime.mtimeMs > newestVerify.mtimeMs) {
        newestVerify = { ...verifyMtime, ref: verifyRef };
      }
    }

    if (!newestVerify) continue;
    const driftMs = newestVerify.mtimeMs - canonicalMtime.mtimeMs;
    if (driftMs <= FRESHNESS_GRACE_MS) continue;

    count += 1;
    const driftDays = Math.round(driftMs / MS_PER_DAY);
    findings.push(makeFinding({
      id: `freshness-${slug(topic.id)}-${count}`,
      type: 'missing_doc_update',
      severity: driftDays >= MEDIUM_FRESHNESS_DAYS ? 'medium' : 'low',
      confidence: 'medium',
      topic: topic.id,
      title: 'Verification source is newer than canonical doc',
      evidence: [
        firstLineEvidence(repoRoot, canonicalMtime.fullPath),
        firstLineEvidence(repoRoot, newestVerify.fullPath)
      ],
      observation: `${relPath(repoRoot, newestVerify.fullPath)} is about ${driftDays} day(s) newer than canonical ${relPath(repoRoot, canonicalMtime.fullPath)}.`,
      why_it_matters: 'The canonical doc may still be correct, but the mapped implementation or registry source moved ahead and needs a documentation review.',
      suggested_action: 'Review the newer source against the canonical doc; update the doc or add a no-change note if the doc remains accurate.'
    }));
  }

  return findings;
}

function findingsFromMapErrors(docMapCheck, repoRoot, mapPath) {
  return docMapCheck.errors.map((err, index) => makeFinding({
    id: `docs-map-error-${index + 1}`,
    type: 'unclear_ownership',
    severity: 'high',
    confidence: 'high',
    topic: 'docs-map',
    title: 'Docs map contains an invalid entry',
    evidence: [firstLineEvidence(repoRoot, mapPath)],
    observation: err,
    why_it_matters: 'Docs Steward cannot reliably determine canonical ownership when the authority map is invalid.',
    suggested_action: 'Fix config/docs-map.yml so every local mapped path exists and every topic has required fields.'
  }));
}

function latestDocJanitorAudit(repoRoot) {
  const auditsRoot = path.join(repoRoot, 'docs/audits');
  if (!fs.existsSync(auditsRoot)) return null;
  const dirs = fs.readdirSync(auditsRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('docjanitor-'))
    .map(d => d.name)
    .sort();
  if (!dirs.length) return null;
  const name = dirs[dirs.length - 1];
  const findingsPath = path.join(auditsRoot, name, 'findings.json');
  if (!fs.existsSync(findingsPath)) return null;
  try {
    const findings = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
    return {
      status: 'ok',
      source: 'latest',
      name,
      path: relPath(repoRoot, findingsPath),
      scanned_at: findings.scanned_at || null,
      summary: findings.summary || null
    };
  } catch (err) {
    return {
      status: 'warn',
      source: 'latest',
      name,
      path: relPath(repoRoot, findingsPath),
      error: err.message
    };
  }
}

function collectDocJanitor(repoRoot, stamp, refreshDocJanitor) {
  if (refreshDocJanitor) {
    try {
      const docJanitor = require(path.join(repoRoot, 'data/services/devtools/docJanitor'));
      const outputDir = path.join(repoRoot, 'docs/audits', `docjanitor-${stamp}`);
      const findings = docJanitor.scan({ targetRepo: repoRoot, outputDir });
      return {
        status: findings.status || 'ok',
        source: 'fresh-scan',
        name: path.basename(outputDir),
        path: relPath(repoRoot, path.join(outputDir, 'findings.json')),
        scanned_at: findings.scanned_at || null,
        summary: findings.summary || null
      };
    } catch (err) {
      const latest = latestDocJanitorAudit(repoRoot);
      return {
        status: 'warn',
        source: latest ? 'fresh-scan-failed-latest-fallback' : 'fresh-scan-failed',
        error: err.message,
        latest
      };
    }
  }

  const latest = latestDocJanitorAudit(repoRoot);
  return latest || {
    status: 'warn',
    source: 'none',
    error: 'no docjanitor audit found'
  };
}

function countBy(rows, key) {
  return rows.reduce((acc, row) => {
    const value = row[key] || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function overallStatus(findings, docMapCheck) {
  if (docMapCheck.status === 'fail') return 'fail';
  if (findings.some(f => f.severity === 'critical')) return 'fail';
  if (findings.length) return 'warn';
  return 'ok';
}

function buildSummary(audit, docMapCheck) {
  const lines = [];
  lines.push(`# Docs Steward Audit - ${dateStamp(new Date(audit.scan_metadata.timestamp_utc))}`);
  lines.push('');
  lines.push(`**Scanned:** ${audit.scan_metadata.timestamp_utc}`);
  lines.push(`**Status:** ${audit.scan_metadata.status}`);
  lines.push(`**Target:** ${audit.scan_metadata.target_repo}`);
  lines.push(`**Docs map:** ${audit.scan_metadata.docs_map}`);
  lines.push(`**DocJanitor:** ${audit.scan_metadata.docjanitor.status} (${audit.scan_metadata.docjanitor.source})`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- Findings: ${audit.scan_metadata.total_findings}`);
  lines.push(`- Map check: ${docMapCheck.status} (${docMapCheck.entries.length} entries)`);
  lines.push(`- By severity: ${JSON.stringify(audit.scan_metadata.findings_by_severity)}`);
  lines.push(`- By type: ${JSON.stringify(audit.scan_metadata.findings_by_type)}`);
  lines.push('');
  lines.push('## Findings');
  if (!audit.findings.length) {
    lines.push('_(none)_');
  } else {
    for (const finding of audit.findings) {
      const ev = finding.evidence && finding.evidence[0]
        ? `${finding.evidence[0].path}:${finding.evidence[0].lines}`
        : 'no evidence';
      lines.push(`- **${finding.severity}/${finding.type}** ${finding.title} (${finding.topic}) - ${ev}`);
    }
  }
  lines.push('');
  lines.push('## Next Actions');
  if (!audit.findings.length) {
    lines.push('- No action needed.');
  } else {
    lines.push('- Review high and critical findings first.');
    lines.push('- Apply doc edits through Lead/Worker flow or create reviewed Mongo pipeline tasks for protected work.');
    lines.push('- Re-run `cd core && npm run docs-steward:audit` after fixes.');
  }
  lines.push('');
  return lines.join('\n');
}

function runAudit(options = {}) {
  const now = options.now || new Date();
  const stamp = dateStamp(now);
  const repoRoot = path.resolve(options.repoRoot || path.resolve(__dirname, '../../..'));
  const mapPath = path.resolve(options.docsMap || path.join(repoRoot, 'config/docs-map.yml'));
  const outputDir = path.resolve(
    options.outputDir || path.join(repoRoot, 'docs/audits', `docs-steward-${stamp}`)
  );

  const map = loadDocsMap(mapPath);
  const docMapCheck = validateDocsMap(map, repoRoot, mapPath);
  const docJanitor = collectDocJanitor(repoRoot, stamp, Boolean(options.refreshDocJanitor));
  const findings = [
    ...findingsFromMapErrors(docMapCheck, repoRoot, mapPath),
    ...scanStaleCheckoutPaths(map, repoRoot),
    ...compareFreshness(map, repoRoot)
  ];
  const timestamp = now.toISOString();

  const audit = {
    schema_version: SCHEMA_VERSION,
    scan_metadata: {
      target_repo: repoRoot,
      timestamp_utc: timestamp,
      status: overallStatus(findings, docMapCheck),
      docs_map: relPath(repoRoot, mapPath),
      docjanitor: docJanitor,
      total_findings: findings.length,
      findings_by_type: countBy(findings, 'type'),
      findings_by_severity: countBy(findings, 'severity')
    },
    findings
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const findingsPath = path.join(outputDir, 'findings.json');
  const summaryPath = path.join(outputDir, 'summary.md');
  const docMapCheckPath = path.join(outputDir, 'doc-map-check.json');
  fs.writeFileSync(findingsPath, JSON.stringify(audit, null, 2) + '\n');
  fs.writeFileSync(docMapCheckPath, JSON.stringify(docMapCheck, null, 2) + '\n');
  fs.writeFileSync(summaryPath, buildSummary(audit, docMapCheck));

  return {
    audit,
    docMapCheck,
    outputDir,
    findingsPath,
    summaryPath,
    docMapCheckPath
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  const result = runAudit({
    repoRoot: args.repoRoot,
    docsMap: args.docsMap,
    outputDir: args.outputDir,
    refreshDocJanitor: args.refreshDocJanitor
  });
  process.stdout.write([
    `findings:      ${result.findingsPath}`,
    `summary:       ${result.summaryPath}`,
    `doc_map_check: ${result.docMapCheckPath}`,
    `status:        ${result.audit.scan_metadata.status}`,
    `findings_n:    ${result.audit.scan_metadata.total_findings}`
  ].join('\n') + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`docs-steward audit failed: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  FINDING_TYPES,
  SEVERITIES,
  loadDocsMap,
  validateDocsMap,
  scanStaleCheckoutPaths,
  compareFreshness,
  collectDocJanitor,
  runAudit
};
