(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PipelineLaunchController = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const STORAGE_KEY = 'agentx.pipeline.launchRequest.v1';
  const TERMINAL = new Set(['finished', 'rejected', 'stopped']);

  class PipelineLaunchController {
    constructor({ request, onChange, refreshTasks, storage, newId = () => crypto.randomUUID() }) {
      this.request = request;
      this.onChange = onChange || (() => {});
      this.refreshTasks = refreshTasks || (() => {});
      this.storage = storage;
      this.newId = newId;
      this.control = null;
      this.error = null;
      this.pending = this.restore();
      this.submitting = false;
      this.checking = false;
      this.version = 0;
      this.timer = null;
      this.readController = null;
      this.lastRun = '';
      this.disposed = false;
    }
    restore() {
      try {
        const value = JSON.parse(this.storage?.getItem(STORAGE_KEY) || 'null');
        return value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.requestId) && /^\d{4}$/.test(value.pipelineId)
          && Number.isSafeInteger(value.expectedAttemptCount) && value.expectedAttemptCount >= 0 ? value : null;
      } catch { return null; }
    }
    persist() {
      try {
        if (this.pending) this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.pending));
        else this.storage?.removeItem(STORAGE_KEY);
      } catch { /* Server receipts remain authoritative when local storage is unavailable. */ }
    }
    changed() { if (!this.disposed) this.onChange(); }
    canLaunch(id) {
      return !this.disposed && !this.submitting && !this.pending && !this.checking && !this.error
        && this.control?.available === true && this.control?.busy === false
        && this.control.candidates.some(item => item.pipelineId === id);
    }
    canRetry() {
      const run = this.control?.run;
      return !this.disposed && !this.submitting && !this.checking && !this.error && Boolean(this.pending)
        && run?.requestId === this.pending.requestId && (run.phase === 'not_received' || run.canRetry === true);
    }
    schedule() {
      clearTimeout(this.timer);
      if (!this.disposed && (this.pending || this.control?.busy)) {
        this.timer = setTimeout(() => this.refresh(), this.error ? 5000 : 2000);
      }
    }
    async boundedRequest(url, options = {}, controller = new AbortController()) {
      const timer = setTimeout(() => controller.abort(), 25000);
      try { return await this.request(url, { ...options, signal: controller.signal }); }
      finally { clearTimeout(timer); }
    }
    async refresh() {
      if (this.disposed) return;
      const version = ++this.version;
      this.readController?.abort();
      const controller = new AbortController();
      this.readController = controller;
      this.checking = true;
      this.changed();
      try {
        const query = this.pending ? `?requestId=${encodeURIComponent(this.pending.requestId)}` : '';
        const payload = await this.boundedRequest(`/api/runtime-bridges/coding-dispatch/status${query}`, {}, controller);
        if (version !== this.version || this.disposed) return;
        if (payload?.data?.contractVersion !== 2 || !Array.isArray(payload.data.candidates)) throw new Error('The host admission and request status are unavailable. Refresh to recover.');
        this.control = payload.data;
        this.error = null;
        const run = this.control.run;
        if (!this.pending && run?.requestId && run.pipelineId && Number.isSafeInteger(run.expectedAttemptCount)
          && ['submitting', 'uncertain', 'accepted', 'running'].includes(run.phase)) {
          this.pending = { requestId: run.requestId, pipelineId: run.pipelineId, expectedAttemptCount: run.expectedAttemptCount };
          this.persist();
        }
        if (this.pending && run?.requestId === this.pending.requestId && TERMINAL.has(run.phase)) {
          this.pending = null;
          this.persist();
        }
        const signature = run ? [run.requestId, run.phase, run.task?.status, run.task?.automationAttemptCount].join(':') : '';
        if (signature !== this.lastRun) {
          this.lastRun = signature;
          this.refreshTasks();
        }
      } catch (error) {
        if (version !== this.version || this.disposed) return;
        this.error = controller.signal.aborted ? 'Status timed out. Refresh the same request; no retry was launched.' : error.message;
      } finally {
        if (version === this.version && !this.disposed) {
          this.checking = false;
          this.changed();
          this.schedule();
        }
      }
    }
    async launch(id) {
      if (!this.canLaunch(id)) return false;
      const candidate = this.control.candidates.find(item => item.pipelineId === id);
      this.pending = { requestId: this.newId(), pipelineId: id, expectedAttemptCount: candidate.expectedAttemptCount };
      this.persist();
      return this.submit();
    }
    async retry() {
      if (!this.canRetry()) return false;
      return this.submit();
    }
    async submit() {
      if (this.submitting || !this.pending || this.disposed) return false;
      this.submitting = true;
      ++this.version;
      this.readController?.abort();
      this.checking = false;
      this.error = null;
      this.changed();
      const request = { ...this.pending };
      // Read-only reconciliation begins immediately, independently of the POST.
      // It never creates another request, including after a lost HTTP response.
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.refresh(), 1000);
      try {
        const payload = await this.boundedRequest('/api/runtime-bridges/coding-dispatch/runs', {
          method: 'POST', body: JSON.stringify({ ...request, confirm: true })
        });
        if (!payload?.data?.run || payload.data.run.requestId !== request.requestId) throw new Error('The launch receipt was incomplete. Checking the same request.');
      } catch (error) {
        if (this.pending?.requestId === request.requestId) this.error = `${error.message || 'Launch response unavailable'}. Checking the same request; nothing was resubmitted.`;
      } finally {
        this.submitting = false;
        this.changed();
        if (!this.disposed) {
          this.refreshTasks();
          await this.refresh();
        }
      }
      return true;
    }
    dispose() {
      this.disposed = true;
      ++this.version;
      clearTimeout(this.timer);
      this.readController?.abort();
    }
  }
  return PipelineLaunchController;
});
