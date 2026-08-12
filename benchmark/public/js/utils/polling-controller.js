/**
 * PollingController - Manages periodic polling tasks with pause-on-blur support
 */
export class PollingController {
    constructor() {
        this._tasks = new Map();
        this._running = false;
        this._onVisibilityChange = this._handleVisibility.bind(this);
        document.addEventListener('visibilitychange', this._onVisibilityChange);
    }

    addTask(name, fn, intervalMs, opts = {}) {
        this._tasks.set(name, {
            fn,
            intervalMs,
            runOnStart: opts.runOnStart !== false,
            timerId: null
        });
    }

    start() {
        if (this._running) return;
        this._running = true;
        for (const [name, task] of this._tasks) {
            if (task.runOnStart) {
                try { task.fn(); } catch (e) { console.error(`Polling task ${name} error:`, e); }
            }
            task.timerId = setInterval(() => {
                try { task.fn(); } catch (e) { console.error(`Polling task ${name} error:`, e); }
            }, task.intervalMs);
        }
    }

    stop() {
        this._running = false;
        for (const task of this._tasks.values()) {
            if (task.timerId) {
                clearInterval(task.timerId);
                task.timerId = null;
            }
        }
    }

    destroy() {
        this.stop();
        this._tasks.clear();
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
    }

    _handleVisibility() {
        if (document.hidden) {
            this.stop();
        } else if (this._tasks.size > 0) {
            this.start();
        }
    }
}
