'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readInventory,
  validateInventory,
  verifyMutationRoutePolicy,
} = require('./verify-mutation-route-policy');

function fixtureInventory(routes = {
  'core/routes/example.js': {
    'POST /probe': 'action-observation',
    'DELETE /records/:id': 'destructive-mutation',
  },
}) {
  return {
    schemaVersion: 1,
    classifications: {
      'action-observation': 'probe',
      'user-mutation': 'durable user mutation',
      'destructive-mutation': 'destructive mutation',
      'scoped-machine-call': 'credential-scoped machine call',
    },
    routeRoots: { core: 'core/routes' },
    routeEntrypoints: { core: [] },
    routes,
  };
}

function withFixture(source, run) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-route-policy-'));
  const routeDirectory = path.join(rootDir, 'core', 'routes');
  fs.mkdirSync(routeDirectory, { recursive: true });
  fs.writeFileSync(path.join(routeDirectory, 'example.js'), source);
  try {
    return run(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

test('the checked-in mutation policy covers every Core, Benchmark, and RAG mutation declaration', () => {
  const receipt = verifyMutationRoutePolicy();
  assert.deepEqual(Object.keys(receipt.byService).sort(), ['benchmark', 'core', 'rag']);
  assert.equal(receipt.total, Object.values(receipt.byService).reduce((sum, count) => sum + count, 0));
  assert(receipt.total > 0);
  assert(Object.values(receipt.byClassification).every((count) => count > 0));
});

test('fails closed when a declared mutation has no exact policy', () => withFixture(`
  const apiRouter = express.Router();
  apiRouter.post('/probe', handler);
  apiRouter.delete('/records/:id', handler);
  apiRouter.patch('/new-route', handler);
`, (rootDir) => {
  assert.throws(
    () => verifyMutationRoutePolicy({ rootDir, inventory: fixtureInventory() }),
    /Unclassified mutation route:\ncore\/routes\/example\.js#PATCH \/new-route/
  );
}));

test('fails closed when a policy no longer has a matching declaration', () => withFixture(`
  const router = require('express').Router();
  router.post('/probe', handler);
`, (rootDir) => {
  assert.throws(
    () => verifyMutationRoutePolicy({ rootDir, inventory: fixtureInventory() }),
    /Stale mutation route policy:\ncore\/routes\/example\.js#DELETE \/records\/:id/
  );
}));

test('also fails closed on mutations declared directly in a service entrypoint', () => withFixture(`
  const router = require('express').Router();
  router.post('/probe', handler);
  router.delete('/records/:id', handler);
`, (rootDir) => {
  const appSource = path.join(rootDir, 'core', 'app.js');
  fs.writeFileSync(appSource, "app.put('/direct-mutation', handler);\n");
  const inventory = fixtureInventory();
  inventory.routeEntrypoints.core = ['core/app.js'];
  assert.throws(
    () => verifyMutationRoutePolicy({ rootDir, inventory }),
    /Unclassified mutation route:\ncore\/app\.js#PUT \/direct-mutation/
  );
}));

test('rejects dynamic mutation paths instead of silently skipping them', () => withFixture(`
  const router = require('express').Router();
  router.post(routeFromConfig, handler);
`, (rootDir) => {
  const inventory = fixtureInventory({
    'core/routes/example.js': { 'POST /probe': 'action-observation' },
  });
  assert.throws(
    () => verifyMutationRoutePolicy({ rootDir, inventory }),
    /Unsupported dynamic mutation route declaration/
  );
}));

test('rejects chained route declarations instead of silently skipping them', () => withFixture(`
  const router = require('express').Router();
  router.route('/probe').post(handler);
`, (rootDir) => {
  const inventory = fixtureInventory({
    'core/routes/example.js': { 'POST /probe': 'action-observation' },
  });
  assert.throws(
    () => verifyMutationRoutePolicy({ rootDir, inventory }),
    /Unsupported chained mutation route declaration/
  );
}));

test('inventory validation rejects broad roots and unknown classifications', () => {
  const broadRoot = fixtureInventory();
  broadRoot.routeRoots.core = 'core';
  assert.throws(() => validateInventory(broadRoot), /must be core\/routes/);

  const unknownClassification = fixtureInventory();
  unknownClassification.routes['core/routes/example.js']['POST /probe'] = 'authenticated-sometimes';
  assert.throws(() => validateInventory(unknownClassification), /Invalid classification/);
});

test('safe methods and non-route collection deletes do not enter the mutation inventory', () => withFixture(`
  const router = require('express').Router();
  const cache = new Map();
  router.get('/probe', handler);
  router.route('/another-probe').get(handler);
  cache.delete('/records/:id');
  router.post('/probe', handler);
  router.delete('/records/:id', handler);
`, (rootDir) => {
  const receipt = verifyMutationRoutePolicy({ rootDir, inventory: fixtureInventory() });
  assert.equal(receipt.total, 2);
}));

test('checked-in policy JSON is structurally valid before source discovery', () => {
  const validated = validateInventory(readInventory());
  assert(validated.policies.size > 0);
});
