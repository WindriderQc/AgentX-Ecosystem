'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { readInventory: readMutationPolicy } = require('./verify-mutation-route-policy');
const {
  readMatrix,
  validateMatrix,
  verifyActionAuthorizationMatrix,
} = require('./verify-action-authorization-matrix');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('the checked-in matrix audits every non-safe route and preserves a zero-gap receipt', () => {
  const receipt = verifyActionAuthorizationMatrix();
  assert.equal(receipt.total, 238);
  assert.deepEqual(receipt.byService, { core: 143, benchmark: 80, rag: 15 });
  assert.deepEqual(receipt.byClassification, {
    'user-mutation': 122,
    'scoped-machine-call': 28,
    'action-observation': 34,
    'destructive-mutation': 54,
  });
  assert.deepEqual(receipt.byEnforcementStatus, { enforced: 237, disabled: 1 });
  assert.equal(receipt.gapRoutes.length, 0);
});

test('distinguishes consequence tiers and requires exact phrases only for irreversible, bulk, delete, and restore actions', () => {
  const receipt = verifyActionAuthorizationMatrix();
  assert.deepEqual(receipt.byDestructiveConsequence, {
    'irreversible-delete-bulk-or-restore': 40,
    'reversible-runtime-control': 13,
    'ephemeral-maintenance': 1,
  });
  assert.deepEqual(receipt.byTypedConfirmation, {
    'not-required': 198,
    enforced: 40,
  });
});

test('reports no scoped-machine gaps after every machine lane gains route-local identity', () => {
  const receipt = verifyActionAuthorizationMatrix();
  const validated = validateMatrix(readMatrix(), readMutationPolicy());
  assert.equal(receipt.scopedMachineGaps.missingScopedCredential.length, 0);
  assert.equal(receipt.scopedMachineGaps.missingCredentialAndValidator.length, 0);
  assert.equal(receipt.scopedMachineGaps.operatorValidatorOnly.length, 0);
  assert.equal(receipt.scopedMachineGaps.boundaryOnly.length, 0);
  assert.deepEqual(receipt.scopedMachineGaps.conditional, []);
  assert.equal(
    validated.routes.get('core/routes/inference.js#POST /inference/contract/resolve').enforcementStatus,
    'enforced'
  );
  assert.equal(
    validated.routes.get('core/routes/mcp.js#POST /').enforcementStatus,
    'enforced'
  );
});

test('fails closed when a newly classified mutation has not been explicitly audited', () => {
  const mutationPolicy = clone(readMutationPolicy());
  mutationPolicy.routes['core/routes/alerts.js']['PATCH /synthetic-policy-test'] = 'user-mutation';
  assert.throws(
    () => validateMatrix(readMatrix(), mutationPolicy),
    /Unclassified action authorization route:\ncore\/routes\/alerts\.js#PATCH \/synthetic-policy-test/
  );
});

test('fails closed when an audited route is stale', () => {
  const mutationPolicy = clone(readMutationPolicy());
  delete mutationPolicy.routes['core/routes/alerts.js']['POST /evaluate'];
  assert.throws(
    () => validateMatrix(readMatrix(), mutationPolicy),
    /Stale action authorization route:\ncore\/routes\/alerts\.js#POST \/evaluate/
  );
});

test('requires every destructive route to have one exact consequence tier', () => {
  const matrix = clone(readMatrix());
  const tier = matrix.destructiveConsequenceTiers['irreversible-delete-bulk-or-restore'];
  tier.routes = tier.routes.filter((key) => key !== 'core/routes/alerts-ops.js#DELETE /rules/:ruleId');
  assert.throws(
    () => validateMatrix(matrix, readMutationPolicy()),
    /Destructive route consequence tier is unclassified:\ncore\/routes\/alerts-ops\.js#DELETE \/rules\/:ruleId/
  );
});

test('does not allow a scoped-machine gap to be relabeled as enforced', () => {
  const matrix = clone(readMatrix());
  const key = 'core/routes/alerts-ops.js#POST /:id/delivery-status';
  matrix.overrides[key] = {
    enforcementStatus: 'enforced',
    note: 'Synthetic false claim for the verifier test.',
    evidence: [],
  };
  assert.throws(
    () => validateMatrix(matrix, readMutationPolicy()),
    new RegExp(`enforcementStatus for ${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} must be gap`)
  );
});

test('rejects stale static evidence instead of preserving an unsupported enforcement claim', () => {
  const matrix = clone(readMatrix());
  matrix.evidence['core-codex-usage-validator'].contains = 'this marker is deliberately absent';
  assert.throws(
    () => validateMatrix(matrix, readMutationPolicy()),
    /Authorization evidence marker is stale: core-codex-usage-validator/
  );
});
