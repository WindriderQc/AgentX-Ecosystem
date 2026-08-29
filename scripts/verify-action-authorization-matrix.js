#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_INVENTORY_PATH: DEFAULT_MUTATION_POLICY_PATH,
  readInventory: readMutationPolicy,
  routeKey,
  validateInventory: validateMutationPolicy,
} = require('./verify-mutation-route-policy');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MATRIX_PATH = path.join(REPOSITORY_ROOT, 'config', 'action-authorization-matrix.json');

const BROWSER_AUTHORITY_STATES = Object.freeze(['admitted-local-only']);
const OPERATOR_CREDENTIAL_STATES = Object.freeze(['admitted']);
const LOCAL_MACHINE_STATES = Object.freeze(['admitted-local-or-configured-internal']);
const SCOPED_CREDENTIAL_STATES = Object.freeze([
  'not-applicable',
  'validated-at-route',
  'validated-at-boundary-only',
  'conditional-at-route',
  'gap',
  'disabled',
]);
const CONFIRMATION_STATES = Object.freeze(['not-required', 'enforced', 'gap']);
const ROUTE_VALIDATOR_STATES = Object.freeze([
  'not-required',
  'enforced',
  'conditional',
  'gap',
  'disabled',
]);
const ENFORCEMENT_STATES = Object.freeze(['enforced', 'gap', 'disabled']);

const ROUTE_POLICY_FIELDS = Object.freeze([
  'scopedMachineCredential',
  'typedConfirmation',
  'routeLocalValidator',
  'enforcementStatus',
  'note',
  'evidence',
]);

function required(condition, message) {
  if (!condition) throw new Error(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSource(value) {
  return String(value || '').replaceAll('\\', '/');
}

function readMatrix(filePath = DEFAULT_MATRIX_PATH) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function policyRoutes(mutationPolicy) {
  const validated = validateMutationPolicy(mutationPolicy);
  return new Map([...validated.policies.values()].map((policy) => [
    routeKey(policy.source, policy.method, policy.declaredPath),
    policy,
  ]));
}

function validateEvidenceRegistry(registry, rootDir) {
  required(isPlainObject(registry), 'Authorization evidence registry is missing');
  const validated = new Map();
  for (const [id, value] of Object.entries(registry)) {
    required(/^[a-z][a-z0-9-]*$/.test(id), `Invalid authorization evidence id: ${id}`);
    required(isPlainObject(value), `Authorization evidence must be an object: ${id}`);
    required(Object.keys(value).every((key) => ['file', 'contains'].includes(key)), `Unknown authorization evidence field: ${id}`);
    const source = normalizeSource(value.file);
    required(source === value.file, `Authorization evidence path must use forward slashes: ${id}`);
    required(source && !path.isAbsolute(source) && !source.split('/').includes('..'), `Unsafe authorization evidence path: ${id}`);
    const markers = Array.isArray(value.contains) ? value.contains : [value.contains];
    required(markers.length > 0 && markers.every((marker) => typeof marker === 'string' && marker.length > 0), `Authorization evidence markers are missing: ${id}`);
    const absoluteSource = path.resolve(rootDir, source);
    required(fs.existsSync(absoluteSource), `Authorization evidence file is missing: ${id} (${source})`);
    const text = fs.readFileSync(absoluteSource, 'utf8');
    for (const marker of markers) {
      required(text.includes(marker), `Authorization evidence marker is stale: ${id} (${source}: ${JSON.stringify(marker)})`);
    }
    validated.set(id, Object.freeze({ source, markers: Object.freeze(markers) }));
  }
  return validated;
}

function validateEvidenceIds(ids, evidence, label, { required: isRequired = false } = {}) {
  required(Array.isArray(ids), `${label} evidence must be an array`);
  if (isRequired) required(ids.length > 0, `${label} must cite authorization evidence`);
  const seen = new Set();
  for (const id of ids) {
    required(typeof id === 'string' && evidence.has(id), `${label} cites unknown authorization evidence: ${id}`);
    required(!seen.has(id), `${label} cites duplicate authorization evidence: ${id}`);
    seen.add(id);
  }
  return Object.freeze([...ids]);
}

function validateServiceBoundaries(boundaries, services, evidence) {
  required(isPlainObject(boundaries), 'Authorization service boundaries are missing');
  required(
    Object.keys(boundaries).length === services.length && services.every((service) => Object.hasOwn(boundaries, service)),
    `Authorization service boundaries must define exactly: ${services.join(', ')}`
  );
  const validated = {};
  for (const service of services) {
    const boundary = boundaries[service];
    required(isPlainObject(boundary), `Authorization service boundary must be an object: ${service}`);
    required(
      Object.keys(boundary).every((key) => [
        'sameOriginBrowser',
        'operatorCredential',
        'uncredentialedLocalMachine',
        'evidence',
        'limitation',
      ].includes(key)),
      `Unknown authorization service-boundary field: ${service}`
    );
    required(BROWSER_AUTHORITY_STATES.includes(boundary.sameOriginBrowser), `Invalid same-origin browser authority state: ${service}`);
    required(OPERATOR_CREDENTIAL_STATES.includes(boundary.operatorCredential), `Invalid operator credential state: ${service}`);
    required(LOCAL_MACHINE_STATES.includes(boundary.uncredentialedLocalMachine), `Invalid local machine admission state: ${service}`);
    required(typeof boundary.limitation === 'string' && boundary.limitation.trim(), `Authorization boundary limitation is missing: ${service}`);
    validated[service] = Object.freeze({
      ...boundary,
      evidence: validateEvidenceIds(boundary.evidence, evidence, `Authorization service boundary ${service}`, { required: true }),
    });
  }
  return Object.freeze(validated);
}

function validateRouteShape(value, label, { partial = false } = {}) {
  required(isPlainObject(value), `${label} must be an object`);
  required(Object.keys(value).every((key) => ROUTE_POLICY_FIELDS.includes(key)), `Unknown ${label} field`);
  const fields = partial ? Object.keys(value) : ROUTE_POLICY_FIELDS;
  if (!partial) {
    required(ROUTE_POLICY_FIELDS.every((field) => Object.hasOwn(value, field)), `${label} is incomplete`);
  }
  if (fields.includes('scopedMachineCredential')) {
    required(SCOPED_CREDENTIAL_STATES.includes(value.scopedMachineCredential), `Invalid scoped machine credential state: ${label}`);
  }
  if (fields.includes('typedConfirmation')) {
    required(CONFIRMATION_STATES.includes(value.typedConfirmation), `Invalid typed confirmation state: ${label}`);
  }
  if (fields.includes('routeLocalValidator')) {
    required(ROUTE_VALIDATOR_STATES.includes(value.routeLocalValidator), `Invalid route-local validator state: ${label}`);
  }
  if (fields.includes('enforcementStatus')) {
    required(ENFORCEMENT_STATES.includes(value.enforcementStatus), `Invalid enforcement status: ${label}`);
  }
  if (fields.includes('note')) {
    required(typeof value.note === 'string' && value.note.trim(), `${label} note must be non-empty`);
  }
  if (fields.includes('evidence')) required(Array.isArray(value.evidence), `${label} evidence must be an array`);
}

function expectedEnforcementStatus(classification, policy) {
  if (policy.scopedMachineCredential === 'disabled' || policy.routeLocalValidator === 'disabled') return 'disabled';
  const hasExplicitGap = policy.scopedMachineCredential === 'gap'
    || policy.scopedMachineCredential === 'conditional-at-route'
    || policy.typedConfirmation === 'gap'
    || policy.routeLocalValidator === 'gap'
    || policy.routeLocalValidator === 'conditional';
  if (hasExplicitGap) return 'gap';
  if (classification === 'scoped-machine-call'
    && policy.scopedMachineCredential !== 'validated-at-route') return 'gap';
  return 'enforced';
}

function validateResolvedRoute(key, classification, policy, evidence, consequence) {
  validateRouteShape(policy, `authorization policy for ${key}`);
  policy.evidence = validateEvidenceIds(policy.evidence, evidence, `Authorization route ${key}`);

  if (classification === 'destructive-mutation') {
    required(consequence, `Destructive route consequence tier is missing: ${key}`);
    if (consequence.typedConfirmationRequired) {
      required(policy.typedConfirmation !== 'not-required', `High-consequence destructive route must declare typed confirmation enforcement or a gap: ${key}`);
    } else {
      required(policy.typedConfirmation === 'not-required', `Reversible or ephemeral destructive control must not be reported as requiring typed confirmation: ${key}`);
    }
  } else {
    required(!consequence, `Non-destructive route cannot have a destructive consequence tier: ${key}`);
    required(policy.typedConfirmation === 'not-required', `Typed confirmation is only an authorization requirement for destructive routes: ${key}`);
  }

  if (classification === 'scoped-machine-call') {
    required(policy.scopedMachineCredential !== 'not-applicable', `Scoped machine route must declare its credential state: ${key}`);
    required(policy.routeLocalValidator !== 'not-required', `Scoped machine route must declare its route-local validator state: ${key}`);
  }

  const evidenceRequired = policy.scopedMachineCredential === 'validated-at-route'
    || policy.scopedMachineCredential === 'validated-at-boundary-only'
    || policy.scopedMachineCredential === 'conditional-at-route'
    || policy.typedConfirmation === 'enforced'
    || policy.routeLocalValidator === 'enforced'
    || policy.routeLocalValidator === 'conditional'
    || policy.routeLocalValidator === 'disabled';
  if (evidenceRequired) required(policy.evidence.length > 0, `Enforced or conditional route policy must cite evidence: ${key}`);

  const expectedStatus = expectedEnforcementStatus(classification, policy);
  required(
    policy.enforcementStatus === expectedStatus,
    `Authorization enforcementStatus for ${key} must be ${expectedStatus}, received ${policy.enforcementStatus}`
  );
  return Object.freeze({ ...policy, evidence: Object.freeze([...policy.evidence]) });
}

function validateDestructiveConsequenceTiers(tiers, mutations) {
  required(isPlainObject(tiers), 'Destructive consequence tiers are missing');
  required(Object.keys(tiers).length > 0, 'At least one destructive consequence tier is required');
  const destructive = new Set([...mutations.entries()]
    .filter(([, policy]) => policy.classification === 'destructive-mutation')
    .map(([key]) => key));
  const assigned = new Map();
  for (const [tier, value] of Object.entries(tiers)) {
    required(/^[a-z][a-z0-9-]*$/.test(tier), `Invalid destructive consequence tier: ${tier}`);
    required(isPlainObject(value), `Destructive consequence tier must be an object: ${tier}`);
    required(Object.keys(value).every((key) => ['description', 'typedConfirmationRequired', 'routes'].includes(key)), `Unknown destructive consequence tier field: ${tier}`);
    required(typeof value.description === 'string' && value.description.trim(), `Destructive consequence tier description is missing: ${tier}`);
    required(typeof value.typedConfirmationRequired === 'boolean', `Destructive consequence tier confirmation policy is missing: ${tier}`);
    required(Array.isArray(value.routes) && value.routes.length > 0, `Destructive consequence tier routes are missing: ${tier}`);
    for (const key of value.routes) {
      required(destructive.has(key), `Destructive consequence tier contains a non-destructive or stale route: ${key}`);
      required(!assigned.has(key), `Destructive route appears in multiple consequence tiers: ${key}`);
      assigned.set(key, Object.freeze({
        tier,
        description: value.description,
        typedConfirmationRequired: value.typedConfirmationRequired,
      }));
    }
  }
  const unassigned = [...destructive].filter((key) => !assigned.has(key)).sort();
  required(unassigned.length === 0, `Destructive route consequence tier is unclassified:\n${unassigned.join('\n')}`);
  return assigned;
}

function validateMatrix(matrix, mutationPolicy, options = {}) {
  const rootDir = path.resolve(options.rootDir || REPOSITORY_ROOT);
  required(isPlainObject(matrix), 'Action authorization matrix must be an object');
  required(matrix.schemaVersion === 1, 'Action authorization matrix schemaVersion must be 1');
  required(matrix.mutationPolicy === 'config/mutation-route-policy.json', 'Action authorization matrix must reference config/mutation-route-policy.json');
  required(isPlainObject(matrix.mechanisms), 'Action authorization mechanism definitions are missing');
  for (const name of [
    'sameOriginBrowser',
    'operatorCredential',
    'scopedMachineCredential',
    'typedConfirmation',
    'routeLocalValidator',
  ]) {
    required(typeof matrix.mechanisms[name] === 'string' && matrix.mechanisms[name].trim(), `Authorization mechanism definition is missing: ${name}`);
  }
  required(Array.isArray(matrix.limitations) && matrix.limitations.length > 0, 'Authorization matrix limitations are missing');
  required(matrix.limitations.every((item) => typeof item === 'string' && item.trim()), 'Authorization matrix limitations must be non-empty strings');

  const mutations = policyRoutes(mutationPolicy);
  const evidence = validateEvidenceRegistry(matrix.evidence, rootDir);
  const services = [...new Set([...mutations.values()].map((policy) => policy.service))].sort();
  const serviceBoundaries = validateServiceBoundaries(matrix.serviceBoundaries, services, evidence);

  required(Array.isArray(matrix.auditedRoutes), 'Action authorization auditedRoutes must be an array');
  const audited = new Set();
  for (const key of matrix.auditedRoutes) {
    required(typeof key === 'string' && key.length > 0, 'Action authorization audited route key must be non-empty');
    required(!audited.has(key), `Duplicate audited authorization route: ${key}`);
    audited.add(key);
  }
  const unclassified = [...mutations.keys()].filter((key) => !audited.has(key)).sort();
  const stale = [...audited].filter((key) => !mutations.has(key)).sort();
  required(unclassified.length === 0, `Unclassified action authorization route${unclassified.length === 1 ? '' : 's'}:\n${unclassified.join('\n')}`);
  required(stale.length === 0, `Stale action authorization route${stale.length === 1 ? '' : 's'}:\n${stale.join('\n')}`);

  const destructiveConsequences = validateDestructiveConsequenceTiers(
    matrix.destructiveConsequenceTiers,
    mutations
  );

  required(isPlainObject(matrix.classificationDefaults), 'Authorization classification defaults are missing');
  const classifications = [...new Set([...mutations.values()].map((policy) => policy.classification))].sort();
  required(
    Object.keys(matrix.classificationDefaults).length === classifications.length
      && classifications.every((classification) => Object.hasOwn(matrix.classificationDefaults, classification)),
    `Authorization classification defaults must define exactly: ${classifications.join(', ')}`
  );
  for (const classification of classifications) {
    validateRouteShape(matrix.classificationDefaults[classification], `authorization default ${classification}`);
  }

  required(isPlainObject(matrix.overrides), 'Authorization route overrides are missing');
  for (const [key, override] of Object.entries(matrix.overrides)) {
    required(mutations.has(key), `Stale action authorization override: ${key}`);
    validateRouteShape(override, `authorization override ${key}`, { partial: true });
    required(Object.keys(override).length > 0, `Authorization override is empty: ${key}`);
  }

  const routes = new Map();
  for (const [key, mutation] of mutations) {
    const defaults = matrix.classificationDefaults[mutation.classification];
    const override = matrix.overrides[key] || {};
    const consequence = destructiveConsequences.get(key) || null;
    const consequenceDefaults = consequence && !consequence.typedConfirmationRequired
      ? {
          typedConfirmation: 'not-required',
          enforcementStatus: 'enforced',
          note: `Typed confirmation is not required for the ${consequence.tier} consequence tier; the action remains globally authorized and must retain an observable recovery/acknowledgement path.`,
        }
      : {};
    const merged = {
      ...defaults,
      ...consequenceDefaults,
      ...override,
      evidence: [
        ...(defaults.evidence || []),
        ...(override.evidence || []),
      ],
    };
    const policy = validateResolvedRoute(key, mutation.classification, merged, evidence, consequence);
    routes.set(key, Object.freeze({
      key,
      service: mutation.service,
      source: mutation.source,
      method: mutation.method,
      declaredPath: mutation.declaredPath,
      classification: mutation.classification,
      destructiveConsequence: consequence,
      boundary: serviceBoundaries[mutation.service],
      ...policy,
    }));
  }

  return Object.freeze({
    schemaVersion: 1,
    routes,
    evidence,
    serviceBoundaries,
    limitations: Object.freeze([...matrix.limitations]),
  });
}

function increment(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function verifyActionAuthorizationMatrix(options = {}) {
  const mutationPolicy = options.mutationPolicy || readMutationPolicy(options.mutationPolicyPath || DEFAULT_MUTATION_POLICY_PATH);
  const matrix = options.matrix || readMatrix(options.matrixPath);
  const validated = validateMatrix(matrix, mutationPolicy, options);
  const byService = {};
  const byClassification = {};
  const byEnforcementStatus = {};
  const byScopedMachineCredential = {};
  const byTypedConfirmation = {};
  const byRouteLocalValidator = {};
  const byDestructiveConsequence = {};
  const gapRoutes = [];
  const scopedMachineGaps = {
    missingScopedCredential: [],
    missingCredentialAndValidator: [],
    operatorValidatorOnly: [],
    boundaryOnly: [],
    conditional: [],
  };

  for (const route of validated.routes.values()) {
    increment(byService, route.service);
    increment(byClassification, route.classification);
    increment(byEnforcementStatus, route.enforcementStatus);
    increment(byScopedMachineCredential, route.scopedMachineCredential);
    increment(byTypedConfirmation, route.typedConfirmation);
    increment(byRouteLocalValidator, route.routeLocalValidator);
    if (route.destructiveConsequence) increment(byDestructiveConsequence, route.destructiveConsequence.tier);
    if (route.enforcementStatus === 'gap') gapRoutes.push(route.key);
    if (route.classification === 'scoped-machine-call' && route.enforcementStatus === 'gap') {
      if (route.scopedMachineCredential === 'validated-at-boundary-only') {
        scopedMachineGaps.boundaryOnly.push(route.key);
      } else if (route.scopedMachineCredential === 'conditional-at-route') {
        scopedMachineGaps.conditional.push(route.key);
      } else if (route.scopedMachineCredential === 'gap') {
        scopedMachineGaps.missingScopedCredential.push(route.key);
        if (route.routeLocalValidator === 'gap') {
          scopedMachineGaps.missingCredentialAndValidator.push(route.key);
        } else if (route.routeLocalValidator === 'enforced') {
          scopedMachineGaps.operatorValidatorOnly.push(route.key);
        }
      }
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    total: validated.routes.size,
    byService: Object.freeze(byService),
    byClassification: Object.freeze(byClassification),
    byEnforcementStatus: Object.freeze(byEnforcementStatus),
    byScopedMachineCredential: Object.freeze(byScopedMachineCredential),
    byTypedConfirmation: Object.freeze(byTypedConfirmation),
    byRouteLocalValidator: Object.freeze(byRouteLocalValidator),
    byDestructiveConsequence: Object.freeze(byDestructiveConsequence),
    gapRoutes: Object.freeze(gapRoutes.sort()),
    scopedMachineGaps: Object.freeze({
      missingScopedCredential: Object.freeze(scopedMachineGaps.missingScopedCredential.sort()),
      missingCredentialAndValidator: Object.freeze(scopedMachineGaps.missingCredentialAndValidator.sort()),
      operatorValidatorOnly: Object.freeze(scopedMachineGaps.operatorValidatorOnly.sort()),
      boundaryOnly: Object.freeze(scopedMachineGaps.boundaryOnly.sort()),
      conditional: Object.freeze(scopedMachineGaps.conditional.sort()),
    }),
    limitations: validated.limitations,
  });
}

function main() {
  try {
    const receipt = verifyActionAuthorizationMatrix();
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Action authorization matrix verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  DEFAULT_MATRIX_PATH,
  CONFIRMATION_STATES,
  ENFORCEMENT_STATES,
  ROUTE_VALIDATOR_STATES,
  SCOPED_CREDENTIAL_STATES,
  expectedEnforcementStatus,
  readMatrix,
  validateDestructiveConsequenceTiers,
  validateMatrix,
  verifyActionAuthorizationMatrix,
};
