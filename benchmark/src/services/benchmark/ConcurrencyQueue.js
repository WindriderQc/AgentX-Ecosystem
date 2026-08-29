/**
 * Concurrency Queue for managing parallel tasks with rate limiting
 * Used primarily for judge tasks to prevent overwhelming the LLM host
 */

const logger = require('../../../config/logger');

class ConcurrencyQueue {
    constructor(concurrency) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
        this.activePromises = [];
        this.completed = 0;
        this.failed = 0;
        this.lastActivityAt = Date.now();
        this.cancelled = false;
        this.cancelReason = null;
    }

    add(task) {
        return new Promise((resolve, reject) => {
            if (this.cancelled) {
                reject(this.cancelReason || new Error('Queue cancelled'));
                return;
            }
            this.queue.push({ task, resolve, reject, addedAt: Date.now() });
            logger.debug('Judge task queued', { queueLength: this.queue.length, running: this.running });
            this.process();
        });
    }

    process() {
        // Fill up to concurrency limit (not just one task per call)
        while (!this.cancelled && this.running < this.concurrency && this.queue.length > 0) {
            this.running++;
            const { task, resolve, reject } = this.queue.shift();
            logger.debug('Starting judge task', { running: this.running, queueLength: this.queue.length });

            const promise = (async () => {
                try {
                    const result = await task();
                    this.completed++;
                    this.lastActivityAt = Date.now();
                    logger.debug('Judge task completed', { completed: this.completed, failed: this.failed });
                    resolve(result);
                } catch (err) {
                    this.failed++;
                    this.lastActivityAt = Date.now();
                    logger.warn('Judge task failed', { error: err.message, completed: this.completed, failed: this.failed });
                    reject(err);
                } finally {
                    this.running--;
                    const idx = this.activePromises.indexOf(promise);
                    if (idx > -1) this.activePromises.splice(idx, 1);
                    this.process();  // Refill when a slot opens
                }
            })();

            this.activePromises.push(promise);
        }
    }

    /**
     * Get current queue status for monitoring
     */
    getStatus() {
        return {
            queued: this.queue.length,
            running: this.running,
            completed: this.completed,
            failed: this.failed,
            cancelled: this.cancelled,
            lastActivityAt: this.lastActivityAt,
            stalledMs: Date.now() - this.lastActivityAt
        };
    }

    /**
     * Wait until queue has capacity (backpressure mechanism)
     * Pauses test execution when judge queue gets too large to prevent memory buildup
     * @param {number} maxPending - Maximum pending tasks before blocking (default: 10)
     * @param {number} checkIntervalMs - How often to check queue size (default: 100ms)
     * @returns {Promise<void>}
     */
    async waitForCapacity(maxPending = 10, checkIntervalMs = 100) {
        if (this.cancelled) {
            throw this.cancelReason || new Error('Queue cancelled');
        }
        const pending = this.queue.length + this.running;
        if (pending < maxPending) {
            return; // Capacity available
        }

        logger.debug('Judge queue backpressure - waiting for capacity', {
            pending,
            maxPending,
            queued: this.queue.length,
            running: this.running
        });

        // Wait until queue drains below threshold
        while (this.queue.length + this.running >= maxPending) {
            await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
            if (this.cancelled) {
                throw this.cancelReason || new Error('Queue cancelled');
            }
        }

        logger.debug('Judge queue backpressure released', {
            queued: this.queue.length,
            running: this.running
        });
    }

    /**
     * Reject work that has not started. Active tasks are deliberately allowed
     * to settle; callers can pair this with an AbortSignal owned by the task
     * and then await drain() before releasing external lifecycle protection.
     */
    cancel(reason = null) {
        if (this.cancelled) {
            return { cancelled: true, queuedCancelled: 0, running: this.running };
        }

        const cancellation = reason instanceof Error ? reason : new Error('Queue cancelled');
        if (!cancellation.code) cancellation.code = 'QUEUE_CANCELLED';
        this.cancelled = true;
        this.cancelReason = cancellation;
        this.lastActivityAt = Date.now();

        const queued = this.queue.splice(0);
        for (const entry of queued) {
            entry.reject(cancellation);
        }

        return {
            cancelled: true,
            queuedCancelled: queued.length,
            running: this.running
        };
    }

    /**
     * Drain the queue with timeout protection
     * @param {Object} options - Drain options
     * @param {number} options.timeoutMs - Maximum time to wait (default: 30 minutes)
     * @param {number} options.stallTimeoutMs - Max time without activity before considered stalled (default: 2 minutes)
     * @param {function} options.onProgress - Callback for progress updates
     * @returns {Promise<{completed: number, failed: number, timedOut: boolean}>}
     */
    async drain(options = {}) {
        const {
            timeoutMs = 30 * 60 * 1000,  // 30 minutes max
            stallTimeoutMs = 2 * 60 * 1000,  // 2 minutes stall detection
            onProgress = null
        } = options;

        const startTime = Date.now();
        let lastProgressReport = Date.now();
        let lastStallReport = 0;

        while (this.queue.length > 0 || this.running > 0) {
            const elapsed = Date.now() - startTime;
            const stalledFor = Date.now() - this.lastActivityAt;

            // Check for overall timeout
            if (elapsed > timeoutMs) {
                logger.warn('Judge queue drain timed out', {
                    elapsed,
                    queued: this.queue.length,
                    running: this.running,
                    completed: this.completed,
                    failed: this.failed
                });
                return { completed: this.completed, failed: this.failed, timedOut: true, reason: 'timeout' };
            }

            // Check for scheduler stall. Long-running judge calls can produce
            // no queue activity for many minutes; returning "stalled" while a
            // task is still running lets callers release claims/pins while the
            // task continues mutating results in the background.
            if (stalledFor > stallTimeoutMs && this.queue.length > 0 && this.running === 0) {
                logger.warn('Judge queue appears stalled', {
                    stalledFor,
                    queued: this.queue.length,
                    running: this.running,
                    completed: this.completed,
                    failed: this.failed
                });
                return { completed: this.completed, failed: this.failed, timedOut: true, reason: 'stalled' };
            }

            if (stalledFor > stallTimeoutMs && this.running > 0 && Date.now() - lastStallReport > stallTimeoutMs) {
                logger.warn('Judge queue has long-running active task', {
                    stalledFor,
                    queued: this.queue.length,
                    running: this.running,
                    completed: this.completed,
                    failed: this.failed
                });
                lastStallReport = Date.now();
            }

            // Report progress every 10 seconds
            if (onProgress && Date.now() - lastProgressReport > 10000) {
                onProgress(this.getStatus());
                lastProgressReport = Date.now();
            }

            await new Promise(resolve => setTimeout(resolve, 100));
        }

        return {
            completed: this.completed,
            failed: this.failed,
            timedOut: false,
            cancelled: this.cancelled
        };
    }
}

module.exports = ConcurrencyQueue;
