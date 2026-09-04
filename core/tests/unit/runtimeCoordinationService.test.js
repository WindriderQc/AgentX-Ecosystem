'use strict';

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const service = require('../../src/services/runtimeCoordinationService');

describe('runtime maintenance and benchmark workload coordination', () => {
  beforeEach(async () => {
    await RuntimeCoordination.deleteMany({});
    await RuntimeCoordination.create({ _id: 'runtime', maintenance: null, workloads: [], inferences: [] });
  });

  afterEach(async () => {
    await RuntimeCoordination.deleteMany({});
  });

  test('workload admission linearizes before maintenance and blocks it until exact release', async () => {
    const workload = await service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'batch-a-request',
      workloadId: 'batch-a',
      kind: 'benchmark',
      ttl: 60_000
    });
    expect(workload).toMatchObject({ acquired: true, workloadId: 'batch-a' });
    expect(workload.admissionId).toEqual(expect.any(String));
    expect(workload.generation).toEqual(expect.any(String));

    await expect(service.acquireMaintenance({
      principal: 'operator-token',
      requestId: 'deploy-a',
      scope: 'force-recreate'
    })).resolves.toMatchObject({ acquired: false });

    await expect(service.release('workload', {
      id: workload.admissionId,
      generation: 'forged-generation',
      principal: 'benchmark-service'
    })).resolves.toMatchObject({ released: false });

    await expect(service.release('workload', {
      id: workload.admissionId,
      generation: workload.generation,
      principal: 'benchmark-service'
    })).resolves.toMatchObject({
      released: true,
      admissionId: workload.admissionId,
      generation: workload.generation,
      principal: 'benchmark-service',
      requestId: 'batch-a-request',
      workloadId: 'batch-a',
      releasedAt: expect.any(Date)
    });

    await expect(service.acquireMaintenance({
      principal: 'operator-token',
      requestId: 'deploy-a',
      scope: 'force-recreate'
    })).resolves.toMatchObject({ acquired: true, principal: 'operator-token' });
  });

  test('maintenance linearizes before workload admission and principal is part of proof', async () => {
    const maintenance = await service.acquireMaintenance({
      principal: 'operator-token',
      requestId: 'deploy-first',
      scope: 'deploy'
    });
    expect(maintenance).toMatchObject({ acquired: true, scope: 'deploy' });

    await expect(service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'batch-after-maintenance',
      workloadId: 'batch-b'
    })).resolves.toMatchObject({ acquired: false });

    await expect(service.heartbeat('maintenance', {
      id: maintenance.leaseId,
      generation: maintenance.generation,
      principal: 'same-origin-ui'
    })).resolves.toMatchObject({ heartbeat: false });
    await expect(service.release('maintenance', {
      id: maintenance.leaseId,
      generation: maintenance.generation,
      principal: 'same-origin-ui'
    })).resolves.toMatchObject({ released: false });

    await expect(service.heartbeat('maintenance', {
      id: maintenance.leaseId,
      generation: maintenance.generation,
      principal: 'operator-token'
    })).resolves.toMatchObject({
      heartbeat: true,
      leaseId: maintenance.leaseId,
      generation: maintenance.generation,
      principal: 'operator-token',
      requestId: 'deploy-first',
      scope: 'deploy',
      heartbeatAt: expect.any(Date),
      expiresAt: expect.any(Date)
    });

    await expect(service.release('maintenance', {
      id: maintenance.leaseId,
      generation: maintenance.generation,
      principal: 'operator-token'
    })).resolves.toMatchObject({
      released: true,
      leaseId: maintenance.leaseId,
      generation: maintenance.generation,
      principal: 'operator-token',
      requestId: 'deploy-first',
      scope: 'deploy',
      releasedAt: expect.any(Date)
    });
  });

  test('concurrent maintenance and workload acquisition has exactly one winner', async () => {
    const [maintenance, workload] = await Promise.all([
      service.acquireMaintenance({
        principal: 'operator-token',
        requestId: 'race-maintenance',
        scope: 'deploy'
      }),
      service.acquireWorkload({
        principal: 'benchmark-service',
        requestId: 'race-workload',
        workloadId: 'race-batch'
      })
    ]);
    expect([maintenance.acquired, workload.acquired].filter(Boolean)).toHaveLength(1);

    const stored = await RuntimeCoordination.findById('runtime').lean();
    expect(Boolean(stored.maintenance) + Number(stored.workloads.length > 0)).toBe(1);
  });

  test('concurrent idempotent retries return the same Core-minted proof', async () => {
    const attempts = await Promise.all(Array.from({ length: 4 }, () => service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'same-request',
      workloadId: 'same-workload'
    })));
    expect(new Set(attempts.map(item => item.admissionId)).size).toBe(1);
    expect(new Set(attempts.map(item => item.generation)).size).toBe(1);

    const stored = await RuntimeCoordination.findById('runtime').lean();
    expect(stored.workloads).toHaveLength(1);
  });

  test('an idempotency key cannot be rebound to a different workload or maintenance intent', async () => {
    await expect(service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'bound-workload-request',
      workloadId: 'batch-original',
      kind: 'benchmark',
      batchId: 'batch-original',
      hosts: ['http://host-a:11434']
    })).resolves.toMatchObject({ acquired: true });
    await expect(service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'bound-workload-request',
      workloadId: 'batch-forged',
      kind: 'benchmark-cloud',
      batchId: 'batch-forged',
      hosts: ['http://host-a:11434']
    })).resolves.toMatchObject({
      acquired: false,
      reason: expect.stringContaining('different workload intent')
    });
    await expect(service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'bound-workload-request',
      workloadId: 'batch-original',
      kind: 'benchmark',
      batchId: 'batch-original',
      hosts: ['http://host-b:11434']
    })).resolves.toMatchObject({
      acquired: false,
      reason: expect.stringContaining('different workload intent')
    });

    await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $set: { workloads: [] } });
    await expect(service.acquireMaintenance({
      principal: 'operator-token',
      requestId: 'bound-maintenance-request',
      scope: 'deploy'
    })).resolves.toMatchObject({ acquired: true });
    await expect(service.acquireMaintenance({
      principal: 'operator-token',
      requestId: 'bound-maintenance-request',
      scope: 'force-recreate'
    })).resolves.toMatchObject({
      acquired: false,
      reason: expect.stringContaining('different maintenance intent')
    });
  });

  test('heartbeat never resurrects expired proof and reaper quarantines it', async () => {
    const admission = await service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'expiry-request',
      workloadId: 'expiry-batch'
    });
    await RuntimeCoordination.updateOne(
      { _id: 'runtime', 'workloads.admissionId': admission.admissionId },
      { $set: { 'workloads.$.expiresAt': new Date(Date.now() - 1_000) } }
    );

    const renewed = await service.heartbeat('workload', {
      id: admission.admissionId,
      generation: admission.generation,
      principal: 'benchmark-service',
      ttl: 60_000
    });
    expect(renewed).toMatchObject({ heartbeat: false });
    await service.reapExpired(new Date());
    expect((await RuntimeCoordination.findById('runtime').lean()).workloads).toEqual([
      expect.objectContaining({
        admissionId: admission.admissionId,
        recoveryRequired: true,
        recoveryState: 'UNKNOWN',
        recoveryReceipt: expect.objectContaining({ event: 'workload-heartbeat-expired' })
      })
    ]);
  });

  test('maintenance heartbeat cannot revive an expired lease and expiry stays quarantined', async () => {
    const lease = await service.acquireMaintenance({
      principal: 'operator-token',
      requestId: 'expired-maintenance',
      scope: 'deploy'
    });
    await RuntimeCoordination.updateOne(
      { _id: 'runtime', 'maintenance.leaseId': lease.leaseId },
      { $set: { 'maintenance.expiresAt': new Date(Date.now() - 1_000) } }
    );

    await expect(service.heartbeat('maintenance', {
      id: lease.leaseId,
      generation: lease.generation,
      principal: lease.principal,
      ttl: 60_000
    })).resolves.toMatchObject({ heartbeat: false });
    await service.reapExpired(new Date());
    const stored = await RuntimeCoordination.findById('runtime').lean();
    expect(stored.maintenance).toMatchObject({
      leaseId: lease.leaseId,
      generation: lease.generation,
      state: 'UNKNOWN'
    });
    await expect(service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'blocked-by-maintenance-quarantine',
      workloadId: 'blocked-workload',
      hosts: ['http://host-a:11434']
    })).resolves.toMatchObject({ acquired: false });
    await expect(service.release('maintenance', {
      id: lease.leaseId,
      generation: lease.generation,
      principal: lease.principal
    })).resolves.toMatchObject({ released: false, recoveryRequired: true });
    await expect(service.recoverMaintenanceAfterOperatorReconciliation({
      id: lease.leaseId,
      generation: lease.generation,
      principal: lease.principal,
      receipt: {
        contract: 'agentx.maintenance-recovery/v1',
        maintenanceReconciled: true,
        confirmation: 'MAINTENANCE_SIDE_EFFECTS_VERIFIED_OR_ROLLED_BACK',
        reconciledAt: new Date().toISOString()
      }
    })).resolves.toMatchObject({ recovered: true, released: true });
    await expect(service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'after-maintenance-recovery',
      workloadId: 'allowed-workload',
      hosts: ['http://host-a:11434']
    })).resolves.toMatchObject({ acquired: true });
  });

  test('maintenance owner can durably quarantine an uncertain terminal state and only exact recovery clears it', async () => {
    const lease = await service.acquireMaintenance({
      principal: 'operator-token', requestId: 'uncertain-maintenance', scope: 'household-deploy'
    });
    await expect(service.markMaintenanceUnknown({
      id: lease.leaseId, generation: 'stale-generation', principal: lease.principal,
      reason: 'child process outcome unknown'
    })).resolves.toMatchObject({ quarantined: false });

    const quarantined = await service.markMaintenanceUnknown({
      id: lease.leaseId, generation: lease.generation, principal: lease.principal,
      reason: 'child process outcome unknown'
    });
    expect(quarantined).toMatchObject({
      contract: 'agentx.maintenance-quarantine/v1',
      coordinationKind: 'maintenance',
      quarantined: true,
      leaseId: lease.leaseId,
      generation: lease.generation,
      principal: lease.principal,
      requestId: lease.requestId,
      scope: lease.scope,
      state: 'UNKNOWN',
      reason: 'child process outcome unknown',
      unknownAt: expect.any(Date)
    });
    await expect(service.markMaintenanceUnknown({
      id: lease.leaseId, generation: lease.generation, principal: lease.principal,
      reason: 'different retry reason'
    })).resolves.toMatchObject({
      quarantined: true, idempotent: true, reason: 'child process outcome unknown'
    });
    await expect(service.release('maintenance', {
      id: lease.leaseId, generation: lease.generation, principal: lease.principal
    })).resolves.toMatchObject({ released: false, recoveryRequired: true });
    await expect(service.acquireInference({
      principal: 'core-service', requestId: 'blocked-by-unknown-maintenance',
      host: 'http://host-a:11434', model: 'model-a'
    })).resolves.toMatchObject({ acquired: false });
  });

  test('expired owners cannot manufacture terminal release receipts before a scheduled reaper runs', async () => {
    const inference = await service.acquireInference({
      principal: 'core-service', requestId: 'expired-release-inference',
      host: 'http://host-a:11434', model: 'model-a'
    });
    await RuntimeCoordination.updateOne(
      { _id: 'runtime', 'inferences.admissionId': inference.admissionId },
      { $set: { 'inferences.$.expiresAt': new Date(Date.now() - 1_000) } }
    );
    await expect(service.releaseInference({
      id: inference.admissionId, generation: inference.generation, principal: inference.principal
    })).resolves.toMatchObject({ released: false });
    expect((await RuntimeCoordination.findById('runtime').lean()).inferences[0])
      .toMatchObject({ admissionId: inference.admissionId, state: 'UNKNOWN' });

    await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $set: { inferences: [] } });
    const maintenance = await service.acquireMaintenance({
      principal: 'operator-token', requestId: 'expired-release-maintenance', scope: 'deploy'
    });
    await RuntimeCoordination.updateOne(
      { _id: 'runtime', 'maintenance.leaseId': maintenance.leaseId },
      { $set: { 'maintenance.expiresAt': new Date(Date.now() - 1_000) } }
    );
    await expect(service.release('maintenance', {
      id: maintenance.leaseId, generation: maintenance.generation, principal: maintenance.principal
    })).resolves.toMatchObject({ released: false, recoveryRequired: true });
    const stored = await RuntimeCoordination.findById('runtime').select('+releaseReceipts').lean();
    expect(stored.maintenance).toMatchObject({ leaseId: maintenance.leaseId, state: 'UNKNOWN' });
    expect(stored.releaseReceipts || []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ generation: maintenance.generation, released: true })
    ]));
  });

  test('atomically persists identity-bound release receipts for lost maintenance and workload responses', async () => {
    const maintenance = await service.acquireMaintenance({
      principal: 'operator-token',
      requestId: 'lost-maintenance-release',
      scope: 'force-recreate'
    });
    const maintenanceReleased = await service.release('maintenance', {
      id: maintenance.leaseId,
      generation: maintenance.generation,
      principal: maintenance.principal
    });
    await expect(service.recoverRelease('maintenance', {
      id: maintenance.leaseId,
      generation: maintenance.generation,
      principal: maintenance.principal
    })).resolves.toMatchObject({
      recovered: true,
      ...maintenanceReleased
    });

    const workload = await service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'lost-workload-release',
      workloadId: 'batch-lost-release',
      kind: 'benchmark-cloud',
      batchId: 'batch-lost-release',
      hosts: ['http://host-b:11434', 'http://host-a:11434']
    });
    const workloadReleased = await service.release('workload', {
      id: workload.admissionId,
      generation: workload.generation,
      principal: workload.principal
    });
    await expect(service.recoverRelease('workload', {
      id: workload.admissionId,
      generation: workload.generation,
      principal: workload.principal
    })).resolves.toMatchObject({
      recovered: true,
      ...workloadReleased,
      hosts: ['http://host-a:11434', 'http://host-b:11434']
    });
    await expect(service.recoverRelease('workload', {
      id: workload.admissionId,
      generation: workload.generation,
      principal: 'forged-principal'
    })).resolves.toMatchObject({ recovered: false, released: false, retryable: false });
  });

  test('release recovery reattests an exact active proof before allowing a bounded retry', async () => {
    const workload = await service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'retry-workload-release',
      workloadId: 'batch-retry-release',
      hosts: ['http://host-a:11434']
    });
    await expect(service.recoverRelease('workload', {
      id: workload.admissionId,
      generation: workload.generation,
      principal: workload.principal
    })).resolves.toMatchObject({
      recovered: true,
      released: false,
      retryable: true,
      admissionId: workload.admissionId,
      generation: workload.generation,
      principal: workload.principal,
      requestId: workload.requestId,
      workloadId: workload.workloadId,
      kind: workload.kind,
      hosts: ['http://host-a:11434']
    });
  });

  test('assertion fails closed after expiry and outside the admission host intent', async () => {
    const admission = await service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'host-bound-request',
      workloadId: 'host-bound-workload',
      hosts: ['http://host-a:11434']
    });

    await expect(service.assertWorkloadAdmission({
      id: admission.admissionId,
      generation: admission.generation,
      principal: admission.principal,
      workloadId: admission.workloadId,
      host: 'http://host-b:11434'
    })).resolves.toMatchObject({ admitted: false });

    await RuntimeCoordination.updateOne(
      { _id: 'runtime', 'workloads.admissionId': admission.admissionId },
      { $set: { 'workloads.$.expiresAt': new Date(Date.now() - 1_000) } }
    );
    await expect(service.assertWorkloadAdmission({
      id: admission.admissionId,
      generation: admission.generation,
      principal: admission.principal,
      workloadId: admission.workloadId,
      host: 'http://host-a:11434'
    })).resolves.toMatchObject({ admitted: false });
  });

  test('operator status is redacted and never exposes generations or request ids', async () => {
    await service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'secret-request',
      workloadId: 'visible-workload',
      hosts: ['http://host:11434']
    });
    const active = await service.listActive();
    expect(active.workloads).toHaveLength(1);
    expect(active.workloads[0]).not.toHaveProperty('generation');
    expect(active.workloads[0]).not.toHaveProperty('requestId');
  });

  test('recovery quarantine survives TTL/reaper, blocks maintenance, and releases only after verified restore', async () => {
    const admission = await service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'quarantine-request',
      workloadId: 'quarantine-workload',
      hosts: ['http://host:11434']
    });
    const armed = await service.armWorkloadRecovery({
      id: admission.admissionId,
      generation: admission.generation,
      principal: admission.principal,
      recoveryRequestId: 'recovery:quarantine-request'
    });
    expect(armed).toMatchObject({
      armed: true,
      recoveryRequired: true,
      recoveryState: 'PREPARED',
      recoveryVersion: 0
    });
    await RuntimeCoordination.updateOne(
      { _id: 'runtime', 'workloads.admissionId': admission.admissionId },
      { $set: { 'workloads.$.expiresAt': new Date(Date.now() - 1_000) } }
    );
    await service.reapExpired(new Date());
    expect((await RuntimeCoordination.findById('runtime').lean()).workloads).toHaveLength(1);
    await expect(service.acquireMaintenance({
      principal: 'operator-token', requestId: 'blocked-deploy', scope: 'deploy'
    })).resolves.toMatchObject({ acquired: false });
    await expect(service.release('workload', {
      id: admission.admissionId, generation: admission.generation, principal: admission.principal
    })).resolves.toMatchObject({ released: false, reason: expect.stringContaining('quarantine') });
    await expect(service.resolveWorkloadRecovery({
      recoveryId: armed.recoveryId,
      recoveryGeneration: armed.recoveryGeneration,
      principal: admission.principal
    })).resolves.toMatchObject({ released: false, reason: expect.stringContaining('no longer owns') });
  });

  test('recovery adoption is single-writer and old generations cannot write after restart', async () => {
    const admission = await service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'crash-request',
      workloadId: 'crash-workload'
    });
    const armed = await service.armWorkloadRecovery({
      id: admission.admissionId,
      generation: admission.generation,
      principal: admission.principal,
      recoveryRequestId: 'recovery:crash-request'
    });
    const mutating = await service.transitionWorkloadRecovery({
      recoveryId: armed.recoveryId,
      recoveryGeneration: armed.recoveryGeneration,
      principal: admission.principal,
      expectedVersion: 0,
      state: 'MUTATING',
      receipt: { event: 'started' }
    });
    await RuntimeCoordination.updateOne(
      { _id: 'runtime', 'workloads.admissionId': admission.admissionId },
      { $set: { 'workloads.$.expiresAt': new Date(Date.now() - 1_000) } }
    );
    const [first, second] = await Promise.all([
      service.adoptWorkloadRecovery({
        recoveryId: armed.recoveryId,
        principal: admission.principal,
        recoveryRequestId: 'recovery:crash-request',
        ownerId: 'worker-a'
      }),
      service.adoptWorkloadRecovery({
        recoveryId: armed.recoveryId,
        principal: admission.principal,
        recoveryRequestId: 'recovery:crash-request',
        ownerId: 'worker-b'
      })
    ]);
    const winner = [first, second].find(item => item.adopted);
    const loser = [first, second].find(item => !item.adopted);
    expect(winner).toMatchObject({ adopted: true, recoveryState: 'MUTATING', recoveryVersion: 1 });
    expect(loser).toMatchObject({ adopted: false });
    await expect(service.adoptWorkloadRecovery({
      recoveryId: armed.recoveryId,
      principal: admission.principal,
      recoveryRequestId: 'recovery:crash-request',
      ownerId: loser === first ? 'worker-a' : 'worker-b'
    })).resolves.toMatchObject({
      adopted: false,
      reason: expect.stringContaining('lease remains live')
    });
    await expect(service.heartbeatWorkloadRecovery({
      recoveryId: winner.recoveryId,
      recoveryGeneration: winner.recoveryGeneration,
      principal: admission.principal,
      ownerId: winner.recoveryOwnerId,
      ttl: 60_000
    })).resolves.toMatchObject({
      heartbeat: true,
      recoveryGeneration: winner.recoveryGeneration,
      recoveryOwnerId: winner.recoveryOwnerId
    });
    await expect(service.transitionWorkloadRecovery({
      recoveryId: armed.recoveryId,
      recoveryGeneration: mutating.recoveryGeneration,
      principal: admission.principal,
      expectedVersion: 1,
      state: 'VERIFIED'
    })).resolves.toMatchObject({ transitioned: false });

    const verified = await service.transitionWorkloadRecovery({
      recoveryId: winner.recoveryId,
      recoveryGeneration: winner.recoveryGeneration,
      principal: admission.principal,
      ownerId: winner.recoveryOwnerId,
      expectedVersion: winner.recoveryVersion,
      state: 'VERIFIED',
      receipt: { event: 'compensated' }
    });
    const restored = await service.transitionWorkloadRecovery({
      recoveryId: winner.recoveryId,
      recoveryGeneration: winner.recoveryGeneration,
      principal: admission.principal,
      ownerId: winner.recoveryOwnerId,
      expectedVersion: verified.recoveryVersion,
      state: 'RESTORED',
      receipt: { contract: 'agentx.workload-recovery/v1', event: 'authority-restored' }
    });
    await expect(service.resolveWorkloadRecovery({
      recoveryId: winner.recoveryId,
      recoveryGeneration: winner.recoveryGeneration,
      principal: admission.principal,
      ownerId: winner.recoveryOwnerId
    })).resolves.toMatchObject({
      released: true,
      recoveryState: 'RESTORED',
      recoveryVersion: restored.recoveryVersion,
      recoveryReceipt: { contract: 'agentx.workload-recovery/v1' }
    });
  });

  test('ordinary inference and exclusive workload acquisition linearize by host', async () => {
    const inference = await service.acquireInference({
      principal: 'core-service',
      requestId: 'chat-request',
      host: 'http://host-a:11434',
      model: 'model-a',
      kind: 'chat'
    });
    expect(inference).toMatchObject({ acquired: true, state: 'ACTIVE' });

    const workload = await service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'benchmark-request',
      workloadId: 'benchmark-a',
      hosts: ['http://host-a:11434']
    });
    expect(workload).toMatchObject({
      acquired: false,
      reason: expect.stringContaining('inference admission')
    });

    await expect(service.releaseInference({
      id: inference.admissionId,
      generation: inference.generation,
      principal: inference.principal
    })).resolves.toMatchObject({
      contract: 'agentx.runtime-inference-completion/v1',
      released: true
    });
    await expect(service.releaseInference({
      id: inference.admissionId,
      generation: inference.generation,
      principal: inference.principal
    })).resolves.toMatchObject({ released: true, idempotent: true });

    const admittedWorkload = await service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'benchmark-request-after-drain',
      workloadId: 'benchmark-a',
      hosts: ['http://host-a:11434']
    });
    expect(admittedWorkload).toMatchObject({ acquired: true });

    await expect(service.acquireInference({
      principal: 'core-service',
      requestId: 'chat-after-workload-fence',
      host: 'http://host-a:11434',
      model: 'model-b',
      kind: 'chat'
    })).resolves.toMatchObject({ acquired: false });
    await expect(service.acquireInference({
      principal: 'core-service',
      requestId: 'chat-other-host',
      host: 'http://host-b:11434',
      model: 'model-b',
      kind: 'chat'
    })).resolves.toMatchObject({ acquired: true });

    expect(await service.hostHasActiveInferences('http://host-a:11434')).toBe(false);
  });

  test('shared inference coexistence requires the same canonical host and residency key', async () => {
    const first = await service.acquireInference({
      principal: 'core-service', requestId: 'shared-a', host: 'HTTP://HOST-A:11434/',
      model: 'model-a', runtimeOptions: { num_ctx: 8192, temperature: 0.1 }, keepAlive: '5m'
    });
    expect(first).toMatchObject({
      acquired: true,
      host: 'http://host-a:11434',
      residencyKey: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      residencySpec: {
        version: 1,
        model: 'model-a',
        runner: { num_ctx: 8192 },
        keepAliveClass: 'finite'
      }
    });
    await expect(service.acquireInference({
      principal: 'core-service', requestId: 'shared-same-residency', host: 'http://host-a:11434/',
      model: 'model-a', runtimeOptions: { num_ctx: 8192, temperature: 0.9, seed: 42 }, keepAlive: '30m'
    })).resolves.toMatchObject({ acquired: true, residencyKey: first.residencyKey });

    for (const [requestId, model, runtimeOptions] of [
      ['shared-other-model', 'model-b', { num_ctx: 8192 }],
      ['shared-other-context', 'model-a', { num_ctx: 16384 }],
      ['shared-explicit-default', 'model-a', { num_ctx: null }]
    ]) {
      await expect(service.acquireInference({
        principal: 'core-service', requestId, host: 'http://host-a:11434', model,
        runtimeOptions, keepAlive: '5m'
      })).resolves.toMatchObject({ acquired: false });
    }
  });

  test('UNKNOWN or exclusive inference blocks every new inference on the canonical host alias', async () => {
    const unknown = await service.acquireInference({
      principal: 'core-service', requestId: 'unknown-source', host: 'http://host-a:11434/',
      model: 'model-a', runtimeOptions: { num_ctx: 8192 }
    });
    await service.markInferenceUnknown({
      id: unknown.admissionId, generation: unknown.generation, principal: unknown.principal,
      reason: 'connection lost'
    });
    await expect(service.acquireInference({
      principal: 'core-service', requestId: 'after-unknown', host: 'HTTP://HOST-A:11434',
      model: 'model-a', runtimeOptions: { num_ctx: 8192 }
    })).resolves.toMatchObject({ acquired: false, reason: expect.stringContaining('UNKNOWN') });

    await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $set: { inferences: [] } });
    await expect(service.acquireInference({
      principal: 'core-service', requestId: 'exclusive-source', host: 'http://host-a:11434',
      model: 'model-a', mode: 'exclusive'
    })).resolves.toMatchObject({ acquired: true });
    await expect(service.acquireInference({
      principal: 'core-service', requestId: 'after-exclusive', host: 'http://host-a:11434/',
      model: 'model-a'
    })).resolves.toMatchObject({ acquired: false });
  });

  test('global workload admission refuses any active or UNKNOWN inference', async () => {
    const inference = await service.acquireInference({
      principal: 'core-service',
      requestId: 'global-blocking-inference',
      host: 'http://host-z:11434',
      model: 'model-z'
    });
    await expect(service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'global-workload',
      workloadId: 'global-workload',
      hosts: []
    })).resolves.toMatchObject({ acquired: false });
    await service.markInferenceUnknown({
      id: inference.admissionId,
      generation: inference.generation,
      principal: inference.principal,
      reason: 'upstream terminal state unknown'
    });
    await expect(service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'global-workload-after-unknown',
      workloadId: 'global-workload',
      hosts: []
    })).resolves.toMatchObject({ acquired: false });
  });

  test('workload and inference acquisition race has exactly one winner', async () => {
    const [workload, inference] = await Promise.all([
      service.acquireWorkload({
        principal: 'benchmark-service', requestId: 'race-workload', workloadId: 'race-workload',
        hosts: ['http://host-a:11434']
      }),
      service.acquireInference({
        principal: 'core-service', requestId: 'race-inference',
        host: 'http://host-a:11434', model: 'model-a'
      })
    ]);
    expect([workload.acquired, inference.acquired].filter(Boolean)).toHaveLength(1);
    const stored = await RuntimeCoordination.findById('runtime').lean();
    expect(Number(stored.workloads.length > 0) + Number(stored.inferences.length > 0)).toBe(1);
  });

  test('benchmark inference requires exact active workload proof for the fenced host', async () => {
    const workload = await service.acquireWorkload({
      principal: 'benchmark-service',
      requestId: 'benchmark-proof-request',
      workloadId: 'benchmark-proof',
      hosts: ['http://host-a:11434']
    });
    await expect(service.acquireInference({
      principal: 'benchmark-service',
      requestId: 'benchmark-inference-forged',
      host: 'http://host-a:11434',
      model: 'model-a',
      workloadAdmissionId: workload.admissionId,
      workloadGeneration: 'forged'
    })).resolves.toMatchObject({ acquired: false });
    await expect(service.acquireInference({
      principal: 'benchmark-service',
      requestId: 'benchmark-inference-exact',
      host: 'http://host-a:11434',
      model: 'model-a',
      workloadAdmissionId: workload.admissionId,
      workloadGeneration: workload.generation
    })).resolves.toMatchObject({
      acquired: true,
      workloadAdmissionId: workload.admissionId,
      workloadGeneration: workload.generation
    });
  });

  test('expired inference becomes durable quarantine and blocks maintenance until exact runtime restart receipt', async () => {
    const inference = await service.acquireInference({
      principal: 'core-service',
      requestId: 'crashed-stream',
      host: 'http://host-a:11434',
      model: 'model-a',
      kind: 'chat-stream'
    });
    await RuntimeCoordination.updateOne(
      { _id: 'runtime', 'inferences.admissionId': inference.admissionId },
      { $set: { 'inferences.$.expiresAt': new Date(Date.now() - 1_000) } }
    );
    await service.reapExpired(new Date());
    const stored = await RuntimeCoordination.findById('runtime').lean();
    expect(stored.inferences).toHaveLength(1);
    expect(stored.inferences[0]).toMatchObject({ state: 'UNKNOWN' });
    await expect(service.acquireMaintenance({
      principal: 'operator-token', requestId: 'deploy-during-unknown', scope: 'deploy'
    })).resolves.toMatchObject({ acquired: false });
    await expect(service.releaseInference({
      id: inference.admissionId,
      generation: inference.generation,
      principal: inference.principal
    })).resolves.toMatchObject({ released: false });
    await expect(service.recoverInferenceAfterRuntimeRestart({
      id: inference.admissionId,
      generation: inference.generation,
      principal: inference.principal,
      receipt: {
        contract: 'agentx.ollama-runtime-restart/v1',
        runtimeRestarted: true,
        confirmation: 'OLLAMA_RUNTIME_RESTARTED_AND_PRIOR_REQUESTS_TERMINATED',
        restartedAt: new Date().toISOString()
      }
    })).resolves.toMatchObject({ recovered: true });
    await expect(service.acquireMaintenance({
      principal: 'operator-token', requestId: 'deploy-after-restart', scope: 'deploy'
    })).resolves.toMatchObject({ acquired: true });
  });

  test('maintenance and inference acquisition have exactly one winner', async () => {
    const [maintenance, inference] = await Promise.all([
      service.acquireMaintenance({
        principal: 'operator-token', requestId: 'maintenance-inference-race', scope: 'deploy'
      }),
      service.acquireInference({
        principal: 'core-service', requestId: 'inference-maintenance-race',
        host: 'http://host-a:11434', model: 'model-a'
      })
    ]);
    expect([maintenance.acquired, inference.acquired].filter(Boolean)).toHaveLength(1);
  });
});
