/**
 * PollingController — IIFE build for non-module scripts.
 * Exposes window.PollingController from the canonical ES module source.
 * Canonical source: ./polling-controller.js (ES module, imported by analytics-cost.js)
 *
 * Features:
 * - Pause on tab hidden (visibilitychange)
 * - Skip overlapping runs (skip-if-running)
 * - Run immediately on start/resume
 */
(function () {
  'use strict';

  function PollingController(options) {
    this._tasks = new Map();
    this._timers = new Map();
    this._active = false;
    this._onError = options && typeof options.onError === 'function' ? options.onError : null;
    this._boundOnVisibilityChange = this._onVisibilityChange.bind(this);
  }

  PollingController.prototype.addTask = function (name, fn, intervalMs, options) {
    if (!name || typeof name !== 'string') throw new Error('PollingController.addTask: name must be a string');
    if (typeof fn !== 'function') throw new Error('PollingController.addTask(' + name + '): fn must be a function');
    var ms = Number(intervalMs);
    if (!isFinite(ms) || ms <= 0) throw new Error('PollingController.addTask(' + name + '): intervalMs must be > 0');
    options = options || {};
    var task = {
      name: name,
      fn: fn,
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
  };

  PollingController.prototype.removeTask = function (name) {
    var task = this._tasks.get(name);
    if (!task) return this;
    this._stopTimer(task);
    this._tasks.delete(name);
    return this;
  };

  PollingController.prototype.start = function () {
    if (this._active) return;
    this._active = true;
    document.addEventListener('visibilitychange', this._boundOnVisibilityChange);
    if (!document.hidden) {
      var self = this;
      this._tasks.forEach(function (task) {
        self._startTimer(task);
        if (task.runOnStart) self._runTask(task);
      });
    }
  };

  PollingController.prototype.stop = function () {
    if (!this._active) return;
    var self = this;
    this._tasks.forEach(function (task) { self._stopTimer(task); });
    document.removeEventListener('visibilitychange', this._boundOnVisibilityChange);
    this._active = false;
  };

  PollingController.prototype.destroy = function () {
    this.stop();
    this._tasks.clear();
  };

  PollingController.prototype._onVisibilityChange = function () {
    if (!this._active) return;
    var self = this;
    if (document.hidden) {
      this._tasks.forEach(function (task) { self._stopTimer(task); });
      return;
    }
    this._tasks.forEach(function (task) {
      self._startTimer(task);
      if (task.runOnResume) self._runTask(task);
    });
  };

  PollingController.prototype._startTimer = function (task) {
    if (this._timers.has(task.name)) return;
    var self = this;
    var timerId = setInterval(function () {
      if (task.skipIfHidden && document.hidden) return;
      self._runTask(task);
    }, task.intervalMs);
    this._timers.set(task.name, timerId);
  };

  PollingController.prototype._stopTimer = function (task) {
    var timerId = this._timers.get(task.name);
    if (!timerId) return;
    clearInterval(timerId);
    this._timers.delete(task.name);
  };

  PollingController.prototype._runTask = function (task) {
    if (task._running) return;
    task._running = true;
    var self = this;
    var result;
    try {
      result = task.fn();
    } catch (err) {
      task._running = false;
      self._handleError(err, task.name);
      return;
    }
    if (result && typeof result.then === 'function') {
      result.then(function () {
        task._running = false;
      }).catch(function (err) {
        task._running = false;
        self._handleError(err, task.name);
      });
    } else {
      task._running = false;
    }
  };

  PollingController.prototype._handleError = function (err, name) {
    if (this._onError) {
      try { this._onError(err, name); } catch (_e) { /* swallow */ }
    } else {
      console.error('Polling task failed: ' + name, err);
    }
  };

  window.PollingController = PollingController;
}());
