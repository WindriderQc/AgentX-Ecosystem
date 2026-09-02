class JobScheduler {
  constructor(concurrency = 4) {
    this.concurrency = concurrency;
    this.queue = []; this.active = new Set(); this.results = new Map();
    this.lock = false; this.waiters = [];
  }
  async acquireLock() {
    while (this.lock) await new Promise(r => this.waiters.push(r));
    this.lock = true;
  }
  releaseLock() {
    this.lock = false;
    if (this.waiters.length) this.waiters.shift()();
  }
  async submit(jobId, fn) {
    await this.acquireLock();
    if (this.results.has(jobId)) { this.releaseLock(); return this.results.get(jobId); }
    this.queue.push({ jobId, fn });
    this.releaseLock();
    this._drain();
    return new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        if (this.results.has(jobId)) {
          clearInterval(interval);
          const r = this.results.get(jobId);
          r.error ? reject(r.error) : resolve(r.value);
        }
      }, 50);
    });
  }
  async _drain() {
    await this.acquireLock();
    while (this.queue.length && this.active.size < this.concurrency) {
      const job = this.queue.shift();
      this.active.add(job.jobId);
      this._run(job);
    }
    this.releaseLock();
  }
  async _run(job) {
    try {
      const value = await job.fn();
      await this.acquireLock();
      this.results.set(job.jobId, { value });
      this.active.delete(job.jobId);
      this.releaseLock();
    } catch (error) {
      await this.acquireLock();
      this.results.set(job.jobId, { error });
      this.active.delete(job.jobId);
      this.releaseLock();
    }
    this._drain();
  }
}

module.exports = JobScheduler;
