/**
 * Shared polling utility with built-in pause-on-blur.
 *
 * Goals:
 * - Centralize interval creation/cleanup
 * - Pause all polling when the tab is hidden
 * - Optionally run tasks immediately on start/resume
 * - Prevent overlapping async runs (skip if still running)
 */

export class PollingController {
  constructor(options = {}) {
    this._tasks = new Map();
    this._timers = new Map();
    this._active = false;
    this._onError = typeof options.onError === 'function' ? options.onError : null;

    this._boundOnVisibilityChange = this._onVisibilityChange.bind(this);
  }

  addTask(name, fn, intervalMs, options = {}) {
    if (!name || typeof name !== 'string') throw new Error('PollingController.addTask: name must be a string');
    if (typeof fn !== 'function') throw new Error(`PollingController.addTask(${name}): fn must be a function`);

    const ms = Number(intervalMs);
    if (!Number.isFinite(ms) || ms <= 0) throw new Error(`PollingController.addTask(${name}): intervalMs must be > 0`);

    const task = {
      name,
      fn,
      intervalMs: ms,
      runOnStart: options.runOnStart !== false,
      runOnResume: options.runOnResume !== false,
      skipIfHidden: options.skipIfHidden !== false,
      _running: false
    };

    this._tasks.set(name, task);

    if (this._active && !document.hidden) {
      this._startTimer(task);
      if (task.runOnStart) this._runTask(task);
    }

    return this;
  }

  removeTask(name) {
    const task = this._tasks.get(name);
    if (!task) return this;

    this._stopTimer(task);
    this._tasks.delete(name);
    return this;
  }

  start() {
    if (this._active) return;
    this._active = true;

    document.addEventListener('visibilitychange', this._boundOnVisibilityChange);

    if (!document.hidden) {
      for (const task of this._tasks.values()) {
        this._startTimer(task);
        if (task.runOnStart) this._runTask(task);
      }
    }
  }

  stop() {
    if (!this._active) return;

    for (const task of this._tasks.values()) {
      this._stopTimer(task);
    }

    document.removeEventListener('visibilitychange', this._boundOnVisibilityChange);
    this._active = false;
  }

  destroy() {
    this.stop();
    this._tasks.clear();
  }

  _onVisibilityChange() {
    if (!this._active) return;

    if (document.hidden) {
      for (const task of this._tasks.values()) {
        this._stopTimer(task);
      }
      return;
    }

    // Visible again
    for (const task of this._tasks.values()) {
      this._startTimer(task);
      if (task.runOnResume) this._runTask(task);
    }
  }

  _startTimer(task) {
    if (this._timers.has(task.name)) return;

    const timerId = setInterval(() => {
      if (task.skipIfHidden && document.hidden) return;
      this._runTask(task);
    }, task.intervalMs);

    this._timers.set(task.name, timerId);
  }

  _stopTimer(task) {
    const timerId = this._timers.get(task.name);
    if (!timerId) return;

    clearInterval(timerId);
    this._timers.delete(task.name);
  }

  async _runTask(task) {
    if (task._running) return;
    task._running = true;

    try {
      await task.fn();
    } catch (error) {
      if (this._onError) {
        try {
          this._onError(error, task.name);
        } catch (_e) {
          // swallow
        }
      } else {
        // eslint-disable-next-line no-console
        console.error(`Polling task failed: ${task.name}`, error);
      }
    } finally {
      task._running = false;
    }
  }
}
