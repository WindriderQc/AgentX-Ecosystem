jest.mock('../../src/services/buddyRagEvents', () => ({
  ingestStart: jest.fn(),
  ingestProgress: jest.fn(),
  clearProgress: jest.fn(),
  ingestDone: jest.fn(),
  ingestFailed: jest.fn(),
}));

const jobManager = require('../../src/services/ingestJobManager');

describe('ingestJobManager', () => {
  beforeEach(() => {
    jobManager._reset();
  });

  describe('createJob', () => {
    it('creates a job with correct initial state', () => {
      const result = jobManager.createJob({ limit: 100 });
      expect(result).not.toBeNull();
      expect(result.jobId).toBeDefined();
      expect(result.job.status).toBe('running');
      expect(result.job.progress).toEqual({ processed: 0, total: 0, errors: 0 });
      expect(result.job.startedAt).toBeDefined();
      expect(result.job.completedAt).toBeNull();
      expect(result.job.params).toEqual({ limit: 100 });
    });

    it('returns null when a scan is already running', () => {
      const first = jobManager.createJob();
      expect(first).not.toBeNull();

      const second = jobManager.createJob();
      expect(second).toBeNull();
    });

    it('generates unique job IDs', () => {
      const first = jobManager.createJob();
      jobManager.completeJob(first.jobId, {});
      const second = jobManager.createJob();
      expect(first.jobId).not.toBe(second.jobId);
    });
  });

  describe('getJob', () => {
    it('returns the job by ID', () => {
      const { jobId } = jobManager.createJob();
      const job = jobManager.getJob(jobId);
      expect(job).not.toBeNull();
      expect(job.jobId).toBe(jobId);
    });

    it('returns null for unknown ID', () => {
      expect(jobManager.getJob('nonexistent')).toBeNull();
    });
  });

  describe('updateProgress', () => {
    it('updates progress on the job', () => {
      const { jobId } = jobManager.createJob();
      jobManager.updateProgress(jobId, { processed: 5, total: 20, errors: 1 });
      const job = jobManager.getJob(jobId);
      expect(job.progress).toEqual({ processed: 5, total: 20, errors: 1 });
    });

    it('does nothing for unknown job ID', () => {
      // Should not throw
      jobManager.updateProgress('nonexistent', { processed: 1 });
    });
  });

  describe('completeJob', () => {
    it('marks job as completed with summary', () => {
      const { jobId } = jobManager.createJob();
      const summary = { processed: 10, ingested: 8, failed: 2 };
      jobManager.completeJob(jobId, summary);

      const job = jobManager.getJob(jobId);
      expect(job.status).toBe('completed');
      expect(job.summary).toEqual(summary);
      expect(job.completedAt).toBeDefined();
    });

    it('releases the active slot', () => {
      const { jobId } = jobManager.createJob();
      expect(jobManager.isRunning()).toBe(true);

      jobManager.completeJob(jobId, {});
      expect(jobManager.isRunning()).toBe(false);
    });
  });

  describe('failJob', () => {
    it('marks job as failed with error message', () => {
      const { jobId } = jobManager.createJob();
      jobManager.failJob(jobId, 'Connection lost');

      const job = jobManager.getJob(jobId);
      expect(job.status).toBe('failed');
      expect(job.error).toBe('Connection lost');
      expect(job.completedAt).toBeDefined();
    });

    it('releases the active slot', () => {
      const { jobId } = jobManager.createJob();
      jobManager.failJob(jobId, 'error');
      expect(jobManager.isRunning()).toBe(false);
    });
  });

  describe('cancelJob', () => {
    it('marks a running job as cancelled', () => {
      const { jobId } = jobManager.createJob();
      const result = jobManager.cancelJob(jobId);

      expect(result).toBe(true);
      const job = jobManager.getJob(jobId);
      expect(job.status).toBe('cancelled');
      expect(job.completedAt).toBeDefined();
    });

    it('returns false for non-running job', () => {
      const { jobId } = jobManager.createJob();
      jobManager.completeJob(jobId, {});
      expect(jobManager.cancelJob(jobId)).toBe(false);
    });

    it('returns false for unknown job', () => {
      expect(jobManager.cancelJob('nonexistent')).toBe(false);
    });

    it('releases the active slot', () => {
      const { jobId } = jobManager.createJob();
      jobManager.cancelJob(jobId);
      expect(jobManager.isRunning()).toBe(false);
    });
  });

  describe('isRunning / getActiveJobId', () => {
    it('returns false/null when no jobs', () => {
      expect(jobManager.isRunning()).toBe(false);
      expect(jobManager.getActiveJobId()).toBeNull();
    });

    it('returns true/jobId when a job is active', () => {
      const { jobId } = jobManager.createJob();
      expect(jobManager.isRunning()).toBe(true);
      expect(jobManager.getActiveJobId()).toBe(jobId);
    });

    it('allows new job after previous completes', () => {
      const first = jobManager.createJob();
      jobManager.completeJob(first.jobId, {});

      const second = jobManager.createJob();
      expect(second).not.toBeNull();
      expect(jobManager.getActiveJobId()).toBe(second.jobId);
    });
  });
});
