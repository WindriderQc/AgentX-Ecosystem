'use strict';

jest.mock('../../src/services/runtimeCoordinationService', () => ({
  acquireMaintenance: jest.fn(),
  heartbeat: jest.fn(),
  release: jest.fn(),
  markMaintenanceUnknown: jest.fn()
}));

const runtime = require('../../src/services/runtimeCoordinationService');
const {
  beginRuntimeMutation,
  runRuntimeMutation
} = require('../../src/services/runtimeMutationLeaseService');

describe('runtime mutation maintenance lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    runtime.acquireMaintenance.mockResolvedValue({
      acquired: true,
      leaseId: 'lease-a',
      generation: 'generation-a',
      principal: 'operator-token',
      requestId: 'request-a',
      scope: 'ollama-pull:host:model'
    });
    runtime.heartbeat.mockResolvedValue({ heartbeat: true });
    runtime.release.mockResolvedValue({ released: true });
    runtime.markMaintenanceUnknown.mockResolvedValue({
      contract: 'agentx.maintenance-quarantine/v1', quarantined: true
    });
  });

  test('releases only after the caller attests terminal completion', async () => {
    const lifecycle = await beginRuntimeMutation({
      principal: 'operator-token', requestId: 'request-a', scope: 'ollama-pull:host:model'
    });
    lifecycle.markDispatched();
    await expect(lifecycle.complete()).resolves.toMatchObject({ released: true });
    expect(runtime.release).toHaveBeenCalledWith('maintenance', {
      id: 'lease-a', generation: 'generation-a', principal: 'operator-token'
    });
    expect(runtime.markMaintenanceUnknown).not.toHaveBeenCalled();
  });

  test('post-dispatch ambiguity quarantines while pre-dispatch cancellation releases', async () => {
    const dispatched = await beginRuntimeMutation({
      principal: 'operator-token', requestId: 'request-a', scope: 'ollama-pull:host:model'
    });
    dispatched.markDispatched();
    await dispatched.abandon(new Error('socket outcome unknown'));
    expect(runtime.markMaintenanceUnknown).toHaveBeenCalledWith(expect.objectContaining({
      id: 'lease-a', generation: 'generation-a', principal: 'operator-token',
      reason: 'socket outcome unknown'
    }));

    runtime.acquireMaintenance.mockResolvedValueOnce({
      acquired: true, leaseId: 'lease-b', generation: 'generation-b',
      principal: 'operator-token', requestId: 'request-b', scope: 'ollama-delete:host:model'
    });
    const beforeDispatch = await beginRuntimeMutation({
      principal: 'operator-token', requestId: 'request-b', scope: 'ollama-delete:host:model'
    });
    await beforeDispatch.abandon(new Error('validation failed'));
    expect(runtime.release).toHaveBeenCalledWith('maintenance', {
      id: 'lease-b', generation: 'generation-b', principal: 'operator-token'
    });
  });

  test('heartbeat loss aborts transport and leaves a durable quarantine', async () => {
    runtime.heartbeat.mockResolvedValueOnce({ heartbeat: false, reason: 'generation replaced' });
    const lifecycle = await beginRuntimeMutation({
      principal: 'operator-token', requestId: 'request-a', scope: 'ollama-pull:host:model'
    });
    lifecycle.markDispatched();
    await lifecycle._heartbeatOnce();
    expect(lifecycle.signal.aborted).toBe(true);
    expect(runtime.markMaintenanceUnknown).toHaveBeenCalledTimes(1);
    expect(() => lifecycle.assertActive()).toThrow('generation replaced');
  });

  test('coordinates an acknowledged application mutation through one exact maintenance generation', async () => {
    const operation = jest.fn(async proof => ({ updated: true, proof }));

    await expect(runRuntimeMutation({
      principal: 'operator-token',
      requestId: 'request-a',
      scope: 'router-task-config:quick_chat'
    }, operation)).resolves.toMatchObject({
      updated: true,
      proof: {
        leaseId: 'lease-a',
        generation: 'generation-a',
        principal: 'operator-token'
      }
    });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(runtime.release).toHaveBeenCalledWith('maintenance', {
      id: 'lease-a', generation: 'generation-a', principal: 'operator-token'
    });
    expect(runtime.markMaintenanceUnknown).not.toHaveBeenCalled();
  });

  test('quarantines a failed application mutation and an unverified terminal release', async () => {
    const writeError = new Error('validation rejected');
    await expect(runRuntimeMutation({
      principal: 'operator-token', requestId: 'request-a', scope: 'host-preference:update'
    }, async () => { throw writeError; })).rejects.toBe(writeError);
    expect(runtime.release).not.toHaveBeenCalled();
    expect(runtime.markMaintenanceUnknown).toHaveBeenCalledWith(expect.objectContaining({
      id: 'lease-a', generation: 'generation-a', principal: 'operator-token',
      reason: 'validation rejected'
    }));

    jest.clearAllMocks();
    runtime.acquireMaintenance.mockResolvedValue({
      acquired: true, leaseId: 'lease-a', generation: 'generation-a',
      principal: 'operator-token', requestId: 'request-a', scope: 'host-preference:update'
    });
    runtime.release.mockResolvedValue({ released: false, reason: 'release receipt missing' });
    runtime.markMaintenanceUnknown.mockResolvedValue({ quarantined: true });

    await expect(runRuntimeMutation({
      principal: 'operator-token', requestId: 'request-a', scope: 'host-preference:update'
    }, async () => ({ updated: true }))).rejects.toMatchObject({
      code: 'RUNTIME_MUTATION_RELEASE_UNVERIFIED'
    });
    expect(runtime.markMaintenanceUnknown).toHaveBeenCalledWith(expect.objectContaining({
      id: 'lease-a', generation: 'generation-a', principal: 'operator-token',
      reason: 'release receipt missing'
    }));
  });

  test('does not dispatch a configuration writer while workload or inference authority is active', async () => {
    runtime.acquireMaintenance.mockResolvedValueOnce({
      acquired: false,
      reason: 'active workload, inference admission, or maintenance lease blocks maintenance'
    });
    const operation = jest.fn();

    await expect(runRuntimeMutation({
      principal: 'same-origin-ui', scope: 'router-task-config:voice_persona_chat'
    }, operation)).rejects.toMatchObject({
      code: 'RUNTIME_MUTATION_LEASE_DENIED',
      statusCode: 409
    });
    expect(operation).not.toHaveBeenCalled();
  });
});
