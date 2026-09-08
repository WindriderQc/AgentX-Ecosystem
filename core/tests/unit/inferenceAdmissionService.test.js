'use strict';

jest.mock('../../src/services/runtimeCoordinationService', () => ({
  acquireInference: jest.fn(),
  heartbeatInference: jest.fn(),
  releaseInference: jest.fn(),
  markInferenceUnknown: jest.fn()
}));

const runtime = require('../../src/services/runtimeCoordinationService');
const { drainRuntimeOperations } = require('../../src/services/pendingRuntimeOperations');
const { beginInferenceAdmission } = require('../../src/services/inferenceAdmissionService');

describe('distributed inference admission lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    runtime.acquireInference.mockResolvedValue({
      acquired: true,
      admissionId: 'inference-a',
      generation: 'generation-a',
      principal: 'core-service'
    });
    runtime.heartbeatInference.mockResolvedValue({ heartbeat: true });
    runtime.releaseInference.mockResolvedValue({ released: true });
    runtime.markInferenceUnknown.mockResolvedValue({ quarantined: true });
  });

  test('passes exact workload proof and releases only after terminal completion', async () => {
    const lifecycle = await beginInferenceAdmission({
      host: 'http://host:11434',
      model: 'model-a',
      principal: 'benchmark-service',
      workloadAdmissionId: 'workload-a',
      workloadGeneration: 'workload-generation-a'
    });
    expect(runtime.acquireInference).toHaveBeenCalledWith(expect.objectContaining({
      principal: 'benchmark-service',
      workloadAdmissionId: 'workload-a',
      workloadGeneration: 'workload-generation-a'
    }));
    lifecycle.markDispatched();
    await expect(lifecycle.complete()).resolves.toMatchObject({ released: true });
    expect(runtime.markInferenceUnknown).not.toHaveBeenCalled();
  });

  test('abort after dispatch quarantines instead of claiming upstream termination', async () => {
    const lifecycle = await beginInferenceAdmission({ host: 'http://host:11434', model: 'model-a' });
    lifecycle.markDispatched();
    await lifecycle.abandon(new Error('caller disconnected'));
    expect(runtime.markInferenceUnknown).toHaveBeenCalledWith(expect.objectContaining({
      id: 'inference-a', generation: 'generation-a', principal: 'core-service'
    }));
    expect(runtime.releaseInference).not.toHaveBeenCalled();
  });

  test('heartbeat loss aborts the request and quarantines the admission', async () => {
    runtime.heartbeatInference.mockResolvedValueOnce({ heartbeat: false, reason: 'lost' });
    const lifecycle = await beginInferenceAdmission({ host: 'http://host:11434', model: 'model-a' });
    lifecycle.markDispatched();
    await lifecycle._heartbeatOnce();
    expect(lifecycle.signal.aborted).toBe(true);
    expect(runtime.markInferenceUnknown).toHaveBeenCalledTimes(1);
    expect(() => lifecycle.assertActive()).toThrow('lost');
  });

  test('cancellation before dispatch releases without quarantine', async () => {
    const lifecycle = await beginInferenceAdmission({ host: 'http://host:11434', model: 'model-a' });
    await lifecycle.abandon(new Error('routing cancelled'));
    expect(runtime.releaseInference).toHaveBeenCalledTimes(1);
    expect(runtime.markInferenceUnknown).not.toHaveBeenCalled();
  });

  test('shutdown waits for admission acquisition and the final database receipt', async () => {
    let acquire;
    let release;
    runtime.acquireInference.mockReturnValueOnce(new Promise(resolve => { acquire = resolve; }));
    runtime.releaseInference.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const pending = beginInferenceAdmission({ host: 'http://host:11434', model: 'model-a' });
    let drained = false;
    const drain = drainRuntimeOperations().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    acquire({ acquired: true, admissionId: 'pending', generation: 'one', principal: 'core-service' });
    const admission = await pending;
    admission.markDispatched();
    const completion = admission.complete();
    await Promise.resolve();
    expect(drained).toBe(false);
    release({ released: true });
    await completion;
    await drain;
    expect(drained).toBe(true);
  });

  test('a denied acquisition does not hold shutdown open', async () => {
    runtime.acquireInference.mockResolvedValueOnce({ acquired: false, reason: 'busy' });
    await expect(beginInferenceAdmission({})).rejects.toThrow('busy');
    await drainRuntimeOperations();
  });
});
