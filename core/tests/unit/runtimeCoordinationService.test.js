'use strict';

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const service = require('../../src/services/runtimeCoordinationService');

describe('runtime maintenance and benchmark workload coordination', () => {
  beforeEach(async () => {
    await RuntimeCoordination.deleteMany({});
    await RuntimeCoordination.create({ _id: 'runtime', maintenance: null, workloads: [] });
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

  test('reaper cannot delete a renewed workload and removes only still-expired proof', async () => {
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
    expect(renewed.heartbeat).toBe(true);
    await service.reapExpired(new Date());
    expect((await RuntimeCoordination.findById('runtime').lean()).workloads).toHaveLength(1);

    await RuntimeCoordination.updateOne(
      { _id: 'runtime', 'workloads.admissionId': admission.admissionId },
      { $set: { 'workloads.$.expiresAt': new Date(Date.now() - 1_000) } }
    );
    await service.reapExpired(new Date());
    expect((await RuntimeCoordination.findById('runtime').lean()).workloads).toHaveLength(0);
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
});
