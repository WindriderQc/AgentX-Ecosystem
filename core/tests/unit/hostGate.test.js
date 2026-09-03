'use strict';

// Enable gate with low limit for these tests
process.env.GATE_ENABLED = 'true';
process.env.GATE_MAX_INFLIGHT = '2';

jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const hostGate = require('../../src/services/hostGate');
const HostGateAdmission = require('../../models/HostGateAdmission');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('hostGate', () => {
  beforeEach(() => {
    hostGate._resetForTests();
  });

  it('admits up to MAX_INFLIGHT concurrent acquirers immediately', async () => {
    const r1 = await hostGate.acquire('http://h1', 'm1');
    const r2 = await hostGate.acquire('http://h1', 'm1');
    const s = hostGate.stats();
    expect(s.entries['http://h1::m1'].inFlight).toBe(2);
    expect(s.entries['http://h1::m1'].waiters).toBe(0);
    r1();
    r2();
  });

  it('queues additional acquirers beyond the limit', async () => {
    const r1 = await hostGate.acquire('http://h1', 'm1');
    const r2 = await hostGate.acquire('http://h1', 'm1');

    let thirdResolved = false;
    const third = hostGate.acquire('http://h1', 'm1').then((release) => {
      thirdResolved = true;
      return release;
    });

    // Let the microtask queue flush
    await new Promise((r) => setImmediate(r));
    expect(thirdResolved).toBe(false);
    expect(hostGate.stats().entries['http://h1::m1'].waiters).toBe(1);

    r1(); // free a slot
    const r3 = await third;
    expect(thirdResolved).toBe(true);
    expect(hostGate.stats().entries['http://h1::m1'].inFlight).toBe(2);

    r2();
    r3();
  });

  it('removes an aborted local waiter and hands the freed slot to the next waiter exactly once', async () => {
    const r1 = await hostGate.acquire('http://cancel-local', 'm1');
    const r2 = await hostGate.acquire('http://cancel-local', 'm1');
    const controller = new AbortController();

    const cancelled = hostGate
      .acquire('http://cancel-local', 'm1', { signal: controller.signal })
      .catch((error) => error);
    const next = hostGate.acquire('http://cancel-local', 'm1');

    await new Promise((resolve) => setImmediate(resolve));
    expect(hostGate.stats().entries['http://cancel-local::m1']).toMatchObject({
      inFlight: 2,
      waiters: 2,
      totalAcquired: 2,
      totalReleased: 0,
    });

    controller.abort(new Error('private caller reason'));
    const cancellationError = await cancelled;
    expect(cancellationError).toMatchObject({
      name: 'AbortError',
      code: hostGate.HOST_GATE_ABORT_CODE,
    });
    expect(cancellationError.message).not.toContain('private caller reason');
    expect(hostGate.stats().entries['http://cancel-local::m1'].waiters).toBe(1);

    r1();
    const r3 = await next;
    expect(hostGate.stats().entries['http://cancel-local::m1']).toMatchObject({
      inFlight: 2,
      waiters: 0,
      totalAcquired: 3,
      totalReleased: 1,
    });

    r2();
    r3();
    expect(hostGate.stats().entries['http://cancel-local::m1']).toMatchObject({
      inFlight: 0,
      waiters: 0,
      totalAcquired: 3,
      totalReleased: 3,
    });
  });

  it('tracks peak inFlight and maxWaiters', async () => {
    const r1 = await hostGate.acquire('http://h2', 'm1');
    const r2 = await hostGate.acquire('http://h2', 'm1');
    // Two waiting
    const w1 = hostGate.acquire('http://h2', 'm1');
    const w2 = hostGate.acquire('http://h2', 'm1');

    await new Promise((r) => setImmediate(r));

    const stats = hostGate.stats().entries['http://h2::m1'];
    expect(stats.peak).toBe(2);
    expect(stats.maxWaiters).toBe(2);

    r1();
    r2();
    const rw1 = await w1;
    const rw2 = await w2;
    rw1();
    rw2();
  });

  it('separates different (host, model) pairs', async () => {
    const r1 = await hostGate.acquire('http://h1', 'model-a');
    const r2 = await hostGate.acquire('http://h1', 'model-a');
    // Different model on same host — should get its own slots
    const r3 = await hostGate.acquire('http://h1', 'model-b');
    const r4 = await hostGate.acquire('http://h1', 'model-b');

    const entries = hostGate.stats().entries;
    expect(entries['http://h1::model-a'].inFlight).toBe(2);
    expect(entries['http://h1::model-b'].inFlight).toBe(2);
    expect(entries['http://h1::model-a'].waiters).toBe(0);

    r1(); r2(); r3(); r4();
  });

  it('drains the host for an exclusive model handoff and blocks cross-model arrivals until release', async () => {
    const normalRelease = await hostGate.acquire('http://exclusive', 'normal-model');
    let exclusiveResolved = false;
    let lateNormalResolved = false;
    const exclusive = hostGate.acquireExclusive('http://exclusive', 'open-model').then((release) => {
      exclusiveResolved = true;
      return release;
    });
    const lateNormal = hostGate.acquire('http://exclusive', 'normal-model').then((release) => {
      lateNormalResolved = true;
      return release;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(exclusiveResolved).toBe(false);
    expect(lateNormalResolved).toBe(false);

    normalRelease();
    const exclusiveRelease = await exclusive;
    expect(exclusiveResolved).toBe(true);
    expect(lateNormalResolved).toBe(false);
    expect(hostGate.inFlightFor('http://exclusive', 'open-model')).toBe(1);
    expect(hostGate.hostHasInflight('http://exclusive')).toBe(true);

    exclusiveRelease();
    const lateNormalRelease = await lateNormal;
    expect(lateNormalResolved).toBe(true);
    expect(hostGate.inFlightFor('http://exclusive', 'open-model')).toBe(0);
    expect(hostGate.inFlightFor('http://exclusive', 'normal-model')).toBe(1);
    lateNormalRelease();
  });

  it('release is idempotent (double-release does not over-free slots)', async () => {
    const r1 = await hostGate.acquire('http://h3', 'm1');
    r1();
    r1(); // second call should no-op
    const stats = hostGate.stats().entries['http://h3::m1'];
    expect(stats.inFlight).toBe(0);
    expect(stats.totalReleased).toBe(1);
  });

  it('processes waiters FIFO', async () => {
    const r1 = await hostGate.acquire('http://h4', 'm1');
    const r2 = await hostGate.acquire('http://h4', 'm1');

    const order = [];
    const w1 = hostGate.acquire('http://h4', 'm1').then((rel) => { order.push('w1'); return rel; });
    const w2 = hostGate.acquire('http://h4', 'm1').then((rel) => { order.push('w2'); return rel; });
    const w3 = hostGate.acquire('http://h4', 'm1').then((rel) => { order.push('w3'); return rel; });

    r1(); // w1 admitted
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['w1']);

    r2(); // w2 admitted
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['w1', 'w2']);

    const rw1 = await w1;
    rw1();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['w1', 'w2', 'w3']);

    const rw2 = await w2;
    const rw3 = await w3;
    rw2();
    rw3();
  });

  describe('in-flight introspection', () => {
    it('inFlightFor reports the per-(host,model) counter', async () => {
      expect(hostGate.inFlightFor('http://h1', 'm1')).toBe(0);
      const r1 = await hostGate.acquire('http://h1', 'm1');
      expect(hostGate.inFlightFor('http://h1', 'm1')).toBe(1);
      const r2 = await hostGate.acquire('http://h1', 'm1');
      expect(hostGate.inFlightFor('http://h1', 'm1')).toBe(2);
      r1(); r2();
      expect(hostGate.inFlightFor('http://h1', 'm1')).toBe(0);
    });

    it('inFlightFor isolates by (host, model) pair', async () => {
      const r = await hostGate.acquire('http://h1', 'm1');
      expect(hostGate.inFlightFor('http://h1', 'm1')).toBe(1);
      expect(hostGate.inFlightFor('http://h1', 'm2')).toBe(0);
      expect(hostGate.inFlightFor('http://h2', 'm1')).toBe(0);
      r();
    });

    it('hostHasInflight is true when any model on the host is active', async () => {
      expect(hostGate.hostHasInflight('http://h1')).toBe(false);
      const r = await hostGate.acquire('http://h1', 'judge-model');
      expect(hostGate.hostHasInflight('http://h1')).toBe(true);
      expect(hostGate.hostHasInflight('http://h2')).toBe(false);
      r();
      expect(hostGate.hostHasInflight('http://h1')).toBe(false);
    });
  });
});

describe('hostGate (shared Mongo admission)', () => {
  let sharedGate;

  beforeEach(async () => {
    process.env.GATE_ENABLED = 'true';
    process.env.GATE_MAX_INFLIGHT = '2';
    process.env.GATE_SHARED_STATE_ENABLED = 'true';
    process.env.GATE_SHARED_RETRY_MS = '25';
    sharedGate = hostGate;
    sharedGate._resetForTests();
    await sharedGate._clearSharedAdmissionsForTests();
  });

  afterEach(async () => {
    await sharedGate._clearSharedAdmissionsForTests();
    delete process.env.GATE_SHARED_STATE_ENABLED;
    delete process.env.GATE_SHARED_RETRY_MS;
    process.env.GATE_ENABLED = 'true';
    process.env.GATE_MAX_INFLIGHT = '2';
  });

  it('limits admission through Mongo-backed slots across callers', async () => {
    const r1 = await sharedGate.acquire('http://shared', 'm1');
    const r2 = await sharedGate.acquire('http://shared', 'm1');
    expect(await HostGateAdmission.countDocuments({ key: 'http://shared::m1' })).toBe(2);
    expect(sharedGate.stats().mode).toBe('mongo-shared');

    let thirdResolved = false;
    const third = sharedGate.acquire('http://shared', 'm1').then((release) => {
      thirdResolved = true;
      return release;
    });

    await delay(30);
    expect(thirdResolved).toBe(false);

    r1();
    await delay(150);
    const r3 = await third;
    expect(thirdResolved).toBe(true);
    expect(await HostGateAdmission.countDocuments({ key: 'http://shared::m1' })).toBe(2);

    r2();
    r3();
    await delay(30);
    expect(await HostGateAdmission.countDocuments({ key: 'http://shared::m1' })).toBe(0);
  });

  it('cancels a shared waiter during its polling sleep without leaking waiter accounting', async () => {
    const r1 = await sharedGate.acquire('http://shared-cancel', 'm1');
    const r2 = await sharedGate.acquire('http://shared-cancel', 'm1');
    const controller = new AbortController();
    const pending = sharedGate
      .acquire('http://shared-cancel', 'm1', { signal: controller.signal })
      .catch((error) => error);

    await delay(30);
    expect(sharedGate.stats().entries['http://shared-cancel::m1']).toMatchObject({
      inFlight: 2,
      waiters: 1,
      totalAcquired: 2,
      totalReleased: 0,
    });

    controller.abort();
    await expect(pending).resolves.toMatchObject({
      name: 'AbortError',
      code: sharedGate.HOST_GATE_ABORT_CODE,
    });
    expect(sharedGate.stats().entries['http://shared-cancel::m1']).toMatchObject({
      inFlight: 2,
      waiters: 0,
      totalAcquired: 2,
      totalReleased: 0,
    });
    expect(await HostGateAdmission.countDocuments({ key: 'http://shared-cancel::m1' })).toBe(2);

    r1();
    r2();
    await delay(30);
  });

  it('releases a shared slot won after the caller aborts during acquisition', async () => {
    const claim = deferred();
    const findSpy = jest.spyOn(HostGateAdmission, 'findOneAndUpdate').mockImplementation(
      (filter, update) => ({
        lean: () => claim.promise.then(() => ({
          _id: filter._id,
          ...update.$set,
        })),
      })
    );
    const deleteSpy = jest.spyOn(HostGateAdmission, 'deleteOne').mockResolvedValue({ deletedCount: 1 });
    const controller = new AbortController();

    try {
      const pending = sharedGate
        .acquire('http://shared-race', 'm1', { signal: controller.signal })
        .catch((error) => error);
      await new Promise((resolve) => setImmediate(resolve));
      expect(findSpy).toHaveBeenCalledTimes(1);

      controller.abort();
      claim.resolve();

      await expect(pending).resolves.toMatchObject({
        name: 'AbortError',
        code: sharedGate.HOST_GATE_ABORT_CODE,
      });
      const claimedOwnerId = findSpy.mock.calls[0][1].$set.ownerId;
      expect(deleteSpy).toHaveBeenCalledWith({
        _id: 'http://shared-race::m1::0',
        ownerId: claimedOwnerId,
      });
      expect(sharedGate.stats().entries['http://shared-race::m1']).toMatchObject({
        inFlight: 0,
        waiters: 0,
        totalAcquired: 0,
        totalReleased: 0,
      });
    } finally {
      findSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });
});

describe('hostGate (disabled)', () => {
  // Re-require with gate disabled to verify no-op behavior
  let disabledGate;
  beforeAll(() => {
    jest.resetModules();
    process.env.GATE_ENABLED = 'false';
    disabledGate = require('../../src/services/hostGate');
  });
  afterAll(() => {
    process.env.GATE_ENABLED = 'true';
  });

  it('acquire returns no-op release when disabled', async () => {
    const r1 = await disabledGate.acquire('http://h', 'm');
    const r2 = await disabledGate.acquire('http://h', 'm');
    const r3 = await disabledGate.acquire('http://h', 'm');
    // All resolved immediately without blocking — no assertion beyond "did not hang"
    r1(); r2(); r3();
    expect(disabledGate.ENABLED).toBe(false);
  });

  it('fails closed instead of evicting a resident model without admission ownership', async () => {
    await expect(disabledGate.acquireExclusive('http://h', 'open-model')).rejects.toMatchObject({
      code: 'HOST_GATE_EXCLUSIVE_DISABLED'
    });
  });
});
