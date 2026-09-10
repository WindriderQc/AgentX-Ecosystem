'use strict';
const RuntimeCoordination = require('../../models/RuntimeCoordination');
const runtime = require('../../src/services/runtimeCoordinationService');
const { runHostModelOperation } = require('../../src/services/inferenceAdmissionService');
const hostGate = require('../../src/services/hostGate');
const operation = host => ({ host: `http://${host}:11434`, model: 'pinned-model', principal: 'core-pin-reconciler', kind: 'pin-restore' });

beforeEach(async () => {
  hostGate._resetForTests();
  await RuntimeCoordination.deleteMany({});
  await RuntimeCoordination.create({ _id: 'runtime', maintenance: null, workloads: [], inferences: [] });
});
afterEach(async () => { await RuntimeCoordination.deleteMany({}); });

test('a quarantined host cannot block restoration on another host', async () => {
  const admission = await runtime.acquireInference({ ...operation('host-a'), requestId: 'unknown-a' });
  await runtime.markInferenceUnknown({ id: admission.admissionId, generation: admission.generation, principal: admission.principal, reason: 'connection lost' });
  const warm = jest.fn(async ({ signal, assertActive }) => { assertActive(); expect(signal.aborted).toBe(false); return 'restored'; });
  await expect(runHostModelOperation(operation('host-b'), warm)).resolves.toBe('restored');
  await expect(runHostModelOperation(operation('host-a'), warm)).rejects.toMatchObject({ code: 'RUNTIME_INFERENCE_RECOVERY_REQUIRED' });
  expect(warm).toHaveBeenCalledTimes(1);
  const stored = await RuntimeCoordination.findById('runtime').lean();
  expect(stored.inferences).toHaveLength(1);
  expect(stored.inferences[0].host).toBe('http://host-a:11434');
});

test('restoration still respects global maintenance and an exclusive operation on the same host', async () => {
  await runtime.acquireMaintenance({ principal: 'operator-token', requestId: 'maintenance', scope: 'test' });
  const warm = jest.fn();
  await expect(runHostModelOperation(operation('host-b'), warm)).rejects.toMatchObject({ code: 'RUNTIME_INFERENCE_ADMISSION_DENIED' });
  expect(warm).not.toHaveBeenCalled();
});

test('an interrupted restore quarantines only its own host and releases the local gate', async () => {
  await expect(runHostModelOperation(operation('host-a'), async () => { throw new Error('socket lost'); })).rejects.toThrow('socket lost');
  expect(hostGate.hostHasInflight('http://host-a:11434')).toBe(false);
  const warm = jest.fn(async () => 'ok');
  await expect(runHostModelOperation(operation('host-b'), warm)).resolves.toBe('ok');
  await expect(runHostModelOperation(operation('host-a'), warm)).rejects.toMatchObject({ code: 'RUNTIME_INFERENCE_RECOVERY_REQUIRED' });
});

test('simultaneous restores on the same host admit only one model operation', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  let entered;
  const entry = new Promise(resolve => { entered = resolve; });
  const first = runHostModelOperation(operation('host-a'), async () => { entered(); await pending; });
  await entry;
  try {
    await expect(runHostModelOperation(operation('host-a'), jest.fn())).rejects.toMatchObject({ code: 'RUNTIME_INFERENCE_ADMISSION_DENIED' });
  } finally { finish(); await first; }
});
