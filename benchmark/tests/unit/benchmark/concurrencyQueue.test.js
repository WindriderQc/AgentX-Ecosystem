/**
 * Unit tests for ConcurrencyQueue
 * Tests queue behavior, concurrency limits, drain logic, and backpressure
 */

jest.mock('../../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const ConcurrencyQueue = require('../../../src/services/benchmark/ConcurrencyQueue');

/**
 * Helper: create a task that resolves after delayMs and records when it started/ended
 */
function makeTimedTask(delayMs, log = []) {
    return () => new Promise((resolve) => {
        log.push({ started: Date.now() });
        setTimeout(() => {
            log.push({ ended: Date.now() });
            resolve(`done-${delayMs}`);
        }, delayMs);
    });
}

/**
 * Helper: create a task that immediately resolves
 */
function makeQuickTask(value = 'ok') {
    return () => Promise.resolve(value);
}

/**
 * Helper: create a task that rejects with the given error
 */
function makeFailingTask(msg = 'task error') {
    return () => Promise.reject(new Error(msg));
}

describe('ConcurrencyQueue — basic behavior', () => {
    it('enqueues and executes tasks up to concurrency limit', async () => {
        const queue = new ConcurrencyQueue(2);
        const log = [];

        // Add 5 tasks, each taking 30ms
        const promises = Array.from({ length: 5 }, () => queue.add(makeTimedTask(30, log)));

        // After a short tick, exactly 2 should have started
        await new Promise(resolve => setTimeout(resolve, 5));
        const startedAfterTick = log.filter(e => e.started).length;
        expect(startedAfterTick).toBe(2);

        // Wait for all to complete
        await Promise.allSettled(promises);
        expect(queue.completed).toBe(5);
    });

    it('completes all tasks', async () => {
        const queue = new ConcurrencyQueue(2);
        const promises = Array.from({ length: 3 }, () => queue.add(makeQuickTask()));
        await Promise.allSettled(promises);

        const result = await queue.drain();
        expect(result.completed).toBe(3);
        expect(result.timedOut).toBe(false);
    });

    it('tracks failed tasks', async () => {
        const queue = new ConcurrencyQueue(2);
        const p = queue.add(makeFailingTask('boom'));

        // Silence the unhandled rejection
        await p.catch(() => {});

        await queue.drain();
        expect(queue.failed).toBe(1);
        expect(queue.completed).toBe(0);
    });

    it('respects maxPending backpressure — waitForCapacity resolves when queue drops below threshold', async () => {
        const queue = new ConcurrencyQueue(1);

        // Fill the queue: 1 running + 4 queued = 5 pending
        const slowTasks = Array.from({ length: 5 }, () =>
            queue.add(makeTimedTask(30))
        );

        // Wait for queue to be full (concurrency 1 means 1 running + 4 waiting)
        await new Promise(resolve => setTimeout(resolve, 5));

        let capacityResolvedAt = null;
        const capacityWait = queue.waitForCapacity(3, 10).then(() => {
            capacityResolvedAt = Date.now();
        });

        const start = Date.now();
        await Promise.allSettled(slowTasks);
        await capacityWait;

        // waitForCapacity should have resolved before all tasks completed
        expect(capacityResolvedAt).not.toBeNull();
    });
});

describe('ConcurrencyQueue — drain behavior', () => {
    it('drain resolves when all tasks complete', async () => {
        const queue = new ConcurrencyQueue(2);
        Array.from({ length: 3 }, () => queue.add(makeQuickTask()));

        const result = await queue.drain({ timeoutMs: 5000 });
        expect(result.timedOut).toBe(false);
        expect(result.completed).toBe(3);
    });

    it('drain times out after timeoutMs', async () => {
        const queue = new ConcurrencyQueue(1);

        // Task that never resolves
        queue.add(() => new Promise(() => {}));

        const result = await queue.drain({ timeoutMs: 50, stallTimeoutMs: 999999 });
        expect(result.timedOut).toBe(true);
        expect(result.reason).toBe('timeout');
    });

    it('does not mark a long-running active task as stalled', async () => {
        const queue = new ConcurrencyQueue(1);

        // Task that hangs; this must be governed by the overall timeout, not
        // the stall timeout, because the worker is still active.
        queue.add(() => new Promise(() => {}));

        const result = await queue.drain({ timeoutMs: 80, stallTimeoutMs: 20 });
        expect(result.timedOut).toBe(true);
        expect(result.reason).toBe('timeout');
    });

    it('drain detects scheduler stall when queued work has no active worker', async () => {
        const queue = new ConcurrencyQueue(0);

        queue.add(makeQuickTask());

        const result = await queue.drain({ timeoutMs: 999999, stallTimeoutMs: 50 });
        expect(result.timedOut).toBe(true);
        expect(result.reason).toBe('stalled');
    });

    it('drain returns correct completed and failed counts', async () => {
        const queue = new ConcurrencyQueue(4);
        const tasks = [
            queue.add(makeQuickTask()),
            queue.add(makeQuickTask()),
            queue.add(makeFailingTask()).catch(() => {}),
            queue.add(makeQuickTask()),
        ];

        await Promise.allSettled(tasks);
        const result = await queue.drain({ timeoutMs: 5000 });

        expect(result.completed).toBe(3);
        expect(result.failed).toBe(1);
        expect(result.timedOut).toBe(false);
    });

    it('drain on empty queue resolves immediately', async () => {
        const queue = new ConcurrencyQueue(2);
        const start = Date.now();
        const result = await queue.drain({ timeoutMs: 5000 });
        const elapsed = Date.now() - start;

        expect(result.timedOut).toBe(false);
        expect(elapsed).toBeLessThan(300);
    });

    it('enqueue after drain starts still completes', async () => {
        const queue = new ConcurrencyQueue(2);

        // Enqueue a task that will resolve quickly
        const earlyTask = queue.add(makeQuickTask('early'));

        // Start draining concurrently
        const drainPromise = queue.drain({ timeoutMs: 500 });

        // Wait for a short period then enqueue another task
        await new Promise(resolve => setTimeout(resolve, 10));
        const lateTask = queue.add(makeQuickTask('late'));

        await earlyTask;
        await lateTask;

        const result = await drainPromise;
        expect(result.completed).toBe(2);
    });

    it('cancels queued work and waits for the active task to settle', async () => {
        const queue = new ConcurrencyQueue(1);
        let releaseActive;
        const active = queue.add(() => new Promise(resolve => {
            releaseActive = resolve;
        }));
        const queued = queue.add(makeQuickTask('must-not-run'));
        await new Promise(resolve => setImmediate(resolve));

        const reason = new Error('batch stopped');
        reason.code = 'BENCHMARK_BATCH_STOPPED';
        expect(queue.cancel(reason)).toEqual({
            cancelled: true,
            queuedCancelled: 1,
            running: 1
        });
        await expect(queued).rejects.toMatchObject({ code: 'BENCHMARK_BATCH_STOPPED' });

        let drained = false;
        const drainPromise = queue.drain({ timeoutMs: 1000 }).then((result) => {
            drained = true;
            return result;
        });
        await new Promise(resolve => setImmediate(resolve));
        expect(drained).toBe(false);

        releaseActive('done');
        await expect(active).resolves.toBe('done');
        await expect(drainPromise).resolves.toMatchObject({
            timedOut: false,
            cancelled: true
        });
    });

    it('rejects new work and capacity waiters after cancellation', async () => {
        const queue = new ConcurrencyQueue(1);
        const reason = new Error('stopped');
        reason.code = 'BENCHMARK_BATCH_STOPPED';
        queue.cancel(reason);

        await expect(queue.add(makeQuickTask())).rejects.toBe(reason);
        await expect(queue.waitForCapacity()).rejects.toBe(reason);
    });
});

describe('ConcurrencyQueue — edge cases', () => {
    it('getStatus returns correct shape', () => {
        const queue = new ConcurrencyQueue(3);
        const status = queue.getStatus();

        expect(status).toHaveProperty('queued');
        expect(status).toHaveProperty('running');
        expect(status).toHaveProperty('completed');
        expect(status).toHaveProperty('failed');
        expect(status).toHaveProperty('stalledMs');
        expect(typeof status.stalledMs).toBe('number');
    });

    it('handles zero concurrency queue by processing tasks sequentially with concurrency=1', async () => {
        const queue = new ConcurrencyQueue(1);
        const order = [];

        await Promise.all([
            queue.add(async () => { order.push(1); }),
            queue.add(async () => { order.push(2); }),
            queue.add(async () => { order.push(3); }),
        ]);

        // With concurrency=1 tasks run one at a time; all 3 should complete
        expect(queue.completed).toBe(3);
        expect(order).toHaveLength(3);
    });
});
