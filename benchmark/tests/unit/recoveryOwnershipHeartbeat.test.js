'use strict';

const {
  startRecoveryOwnershipHeartbeat
} = require('../../src/services/recoveryOwnershipHeartbeat');

describe('recovery ownership heartbeat', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('refreshes the local owner CAS and Core owner while work remains active', async () => {
    const refreshOwner = jest.fn(async () => ({ matchedCount: 1 }));
    const coreHeartbeat = jest.fn(async () => ({ heartbeat: true }));
    const heartbeat = startRecoveryOwnershipHeartbeat({ refreshOwner, intervalMs: 25 });
    await heartbeat.ready;
    heartbeat.setCoreHeartbeat(coreHeartbeat);

    await jest.advanceTimersByTimeAsync(26);

    expect(refreshOwner).toHaveBeenCalledTimes(2);
    expect(coreHeartbeat).toHaveBeenCalledTimes(1);
    heartbeat.assertActive();
    await heartbeat.stop();
  });

  test('aborts the shared signal and fences later writes when the local owner CAS is lost', async () => {
    const lost = Object.assign(new Error('owner epoch changed'), { code: 'RECOVERY_OWNERSHIP_LOST' });
    const refreshOwner = jest.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockRejectedValueOnce(lost);
    const heartbeat = startRecoveryOwnershipHeartbeat({ refreshOwner, intervalMs: 25 });
    await heartbeat.ready;

    await jest.advanceTimersByTimeAsync(26);

    expect(heartbeat.signal.aborted).toBe(true);
    expect(() => heartbeat.assertActive()).toThrow(lost);
    await heartbeat.stop();
  });

  test('treats a rejected Core owner heartbeat as terminal ownership loss', async () => {
    const heartbeat = startRecoveryOwnershipHeartbeat({
      refreshOwner: jest.fn(async () => ({ matchedCount: 1 })),
      intervalMs: 25
    });
    await heartbeat.ready;
    heartbeat.setCoreHeartbeat(jest.fn(async () => ({ heartbeat: false, reason: 'generation changed' })));

    await expect(heartbeat.heartbeatOnce()).rejects.toMatchObject({
      code: 'WORKLOAD_RECOVERY_OWNERSHIP_LOST'
    });
    expect(heartbeat.signal.aborted).toBe(true);
    expect(() => heartbeat.assertActive()).toThrow('generation changed');
    await heartbeat.stop();
  });

  test('does not retry a failed initial owner CAS after the caller starts cleanup', async () => {
    const lost = Object.assign(new Error('initial owner epoch changed'), {
      code: 'RECOVERY_OWNERSHIP_LOST'
    });
    const refreshOwner = jest.fn().mockRejectedValue(lost);
    const heartbeat = startRecoveryOwnershipHeartbeat({ refreshOwner, intervalMs: 25 });

    await expect(heartbeat.ready).rejects.toBe(lost);
    await jest.advanceTimersByTimeAsync(100);

    expect(refreshOwner).toHaveBeenCalledTimes(1);
    expect(() => heartbeat.assertActive()).toThrow(lost);
    await heartbeat.stop();
  });
});
