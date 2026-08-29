'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  PERFORMANCE_ATTACHMENT_NAME,
  PERFORMANCE_RECORD_KIND,
  PERFORMANCE_RECORD_SCHEMA_VERSION,
  budgetViolations,
} = require('./tests/support/performance-budget');

const RECEIPT_KIND = 'agentx.browser-performance';
const RECEIPT_SCHEMA_VERSION = 1;

function normalizedProfile(value) {
  const profile = String(value || 'demo').trim().toLowerCase();
  return /^[a-z0-9-]+$/.test(profile) ? profile : 'unknown';
}

function attachmentBody(attachment) {
  if (attachment.body) return Buffer.from(attachment.body).toString('utf8');
  if (attachment.path) return fs.readFileSync(attachment.path, 'utf8');
  throw new Error('performance attachment has no body');
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (record.schemaVersion !== PERFORMANCE_RECORD_SCHEMA_VERSION) return false;
  if (record.kind !== PERFORMANCE_RECORD_KIND) return false;
  if (!record.surface || typeof record.surface.id !== 'string' || typeof record.surface.service !== 'string') return false;
  if (typeof record.profile !== 'string' || typeof record.project !== 'string') return false;
  if (!record.budget || typeof record.budget.id !== 'string' || !record.budget.limits) return false;
  if (!record.observed || typeof record.observed !== 'object') return false;
  return ['decodedBytes', 'javaScriptBytes', 'assetRequests', 'domNodes']
    .every((field) => Number.isInteger(record.observed[field]) && record.observed[field] >= 0);
}

function parsePerformanceAttachment(attachment) {
  const record = JSON.parse(attachmentBody(attachment));
  if (!validateRecord(record)) throw new Error('performance attachment does not match the observation schema');
  return record;
}

function compareRecords(left, right) {
  return [left.profile, left.project, left.surface.id]
    .join(':')
    .localeCompare([right.profile, right.project, right.surface.id].join(':'));
}

function createReceipt(records, runStatus, {
  now = () => new Date(),
  errors = [],
  expectedObservations,
} = {}) {
  const observations = [...records]
    .sort(compareRecords)
    .map((record) => {
      const violations = budgetViolations(record.observed, record.budget.limits);
      return Object.freeze({
        ...record,
        outcome: violations.length === 0 ? 'pass' : 'fail',
        violations: Object.freeze(violations),
      });
    });
  const profiles = [...new Set(observations.map((record) => record.profile))];
  const failed = observations.filter((record) => record.outcome === 'fail').length;
  const expected = Number.isInteger(expectedObservations) && expectedObservations > 0
    ? expectedObservations
    : Math.max(observations.length, 1);
  const missing = Math.max(0, expected - observations.length);
  const cleanRun = runStatus === 'passed'
    && observations.length === expected
    && errors.length === 0
    && failed === 0;

  return Object.freeze({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: RECEIPT_KIND,
    generatedAt: now().toISOString(),
    profile: profiles.length === 1 ? profiles[0] : (profiles.length === 0 ? normalizedProfile(process.env.AGENTX_E2E_PROFILE) : 'mixed'),
    status: cleanRun ? 'pass' : 'fail',
    runStatus,
    summary: Object.freeze({
      observations: observations.length,
      expected,
      missing,
      passed: observations.length - failed,
      failed,
      malformedAttachments: errors.length,
    }),
    observations: Object.freeze(observations),
  });
}

class AgentXPerformanceReporter {
  constructor(options = {}) {
    this.outputDir = path.resolve(options.outputDir || 'test-results');
    this.outputFile = options.outputFile ? path.resolve(options.outputFile) : '';
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.records = [];
    this.errors = [];
    this.expectedObservations = null;
  }

  onBegin(_config, suite) {
    this.records = [];
    this.errors = [];
    this.expectedObservations = suite?.allTests?.().filter((testCase) => (
      path.basename(testCase.location?.file || '') === 'critical-surfaces.spec.js'
    )).length || null;
  }

  onTestEnd(_test, result) {
    for (const attachment of result.attachments || []) {
      if (attachment.name !== PERFORMANCE_ATTACHMENT_NAME) continue;
      try {
        this.records.push(parsePerformanceAttachment(attachment));
      } catch {
        this.errors.push('malformed-performance-attachment');
      }
    }
  }

  onEnd(result) {
    const receipt = createReceipt(this.records, result.status, {
      now: this.now,
      errors: this.errors,
      expectedObservations: this.expectedObservations,
    });
    const outputFile = this.outputFile || path.join(
      this.outputDir,
      `agentx-browser-performance-${normalizedProfile(receipt.profile)}.json`
    );
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    return receipt.status === 'pass' ? undefined : { status: 'failed' };
  }

  printsToStdio() {
    return false;
  }
}

module.exports = AgentXPerformanceReporter;
module.exports.RECEIPT_KIND = RECEIPT_KIND;
module.exports.RECEIPT_SCHEMA_VERSION = RECEIPT_SCHEMA_VERSION;
module.exports.createReceipt = createReceipt;
module.exports.parsePerformanceAttachment = parsePerformanceAttachment;
module.exports.validateRecord = validateRecord;
