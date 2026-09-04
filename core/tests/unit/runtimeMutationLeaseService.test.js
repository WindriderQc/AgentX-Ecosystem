'use strict';

jest.mock('../../src/services/runtimeCoordinationService', () => ({
  acquireMaintenance: jest.fn(),
  heartbeat: jest.fn(),
  release: jest.fn(),
  markMaintenanceUnknown: jest.fn()
}));

const runtime = require('../../src/services/runtimeCoordinationService');
const { beginRuntimeMutation } = require('../../src/services/runtimeMutationLeaseService');

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
});
