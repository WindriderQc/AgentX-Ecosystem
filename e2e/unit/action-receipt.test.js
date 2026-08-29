'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXPECTED_PHASES,
  EXPECTED_PROJECTS,
  JOURNEY_IDENTITIES,
  JOURNEY_PHASES,
  validateActionReceipt,
} = require('../action-receipt');

function validReceipt() {
  return {
    schemaVersion: 1,
    kind: 'agentx.browser-action-observation',
    status: 'pass',
    profile: 'demo',
    journeyId: 'benchmark.stop-failure-recovery',
    buildRevision: 'a'.repeat(40),
    subjectHash: 'b'.repeat(12),
    evidenceMode: 'deterministic-contract',
    serviceIdentity: { service: 'benchmark', surface: 'benchmark-home' },
    observations: EXPECTED_PROJECTS.map((project) => ({
      project: project.name,
      viewport: project.viewport,
      phases: EXPECTED_PHASES.map((id) => ({
        id,
        request: { pathTemplate: '/api/example/:id' },
        outcome: 'pass',
      })),
    })),
    summary: { expectedSteps: 8, passed: 8, failed: 0, missing: 0 },
    privacy: {
      addressesIncluded: false,
      rawResponsesIncluded: false,
      subjectIdentifiersIncluded: false,
      secretsIncluded: false,
    },
  };
}

test('accepts a complete address-free action receipt', () => {
  assert.deepEqual(validateActionReceipt(validReceipt()), []);
});

test('fails closed when an expected action phase is missing', () => {
  const receipt = validReceipt();
  receipt.observations[0].phases.pop();
  receipt.summary.expectedSteps = 7;
  receipt.summary.passed = 7;

  assert.match(validateActionReceipt(receipt).join('\n'), /incomplete or unordered phases/);
});

test('fails closed when the mobile project observation is missing', () => {
  const receipt = validReceipt();
  receipt.observations.pop();
  receipt.summary.expectedSteps = 4;
  receipt.summary.passed = 4;

  assert.match(validateActionReceipt(receipt).join('\n'), /desktop and mobile project observations are both required/);
});

test('rejects origins and URLs from retained receipts', () => {
  const receipt = validReceipt();
  receipt.observations[0].phases[0].request.pathTemplate = 'http://127.0.0.1/api/example';

  assert.match(validateActionReceipt(receipt).join('\n'), /origin or URL/);
});

test('validates the exact phase contract for every registered action journey', () => {
  for (const [journeyId, phases] of Object.entries(JOURNEY_PHASES)) {
    const receipt = validReceipt();
    receipt.journeyId = journeyId;
    receipt.serviceIdentity = { ...JOURNEY_IDENTITIES[journeyId] };
    receipt.observations.forEach((observation) => {
      observation.phases = phases.map((id) => ({
        id,
        request: { pathTemplate: '/api/example/:id' },
        outcome: 'pass',
      }));
    });
    receipt.summary.expectedSteps = receipt.observations.length * phases.length;
    receipt.summary.passed = receipt.summary.expectedSteps;

    assert.deepEqual(validateActionReceipt(receipt), [], journeyId);
  }
});

test('fails closed for an unregistered journey id', () => {
  const receipt = validReceipt();
  receipt.journeyId = 'unknown.journey';

  assert.match(validateActionReceipt(receipt).join('\n'), /journeyId is unknown/);
});

test('binds each receipt to the service and surface owned by its journey', () => {
  const receipt = validReceipt();
  receipt.serviceIdentity = { service: 'agentx-core', surface: 'core-prompts' };

  assert.match(validateActionReceipt(receipt).join('\n'), /serviceIdentity does not match journeyId/);
});

test('registers the exact Playground turn-action proof as a Core-owned surface', () => {
  assert.deepEqual(JOURNEY_PHASES['playground.exact-turn-actions'], [
    'duplicate_history_loaded',
    'ask_again_provenance_submitted',
    'retry_exposed',
    'retry_acknowledged',
  ]);
  assert.deepEqual(JOURNEY_IDENTITIES['playground.exact-turn-actions'], {
    service: 'agentx-core',
    surface: 'core-playground',
  });
});
