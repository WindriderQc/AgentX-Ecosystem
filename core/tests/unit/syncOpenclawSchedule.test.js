describe('OpenClaw schedule sync source policy', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
    jest.resetModules();
  });

  it('reads the optional AgentX OpenClaw cron projection', async () => {
    process.env.AGENTX_OPENCLAW_JOBS_URL = 'http://agentx.test/api/openclaw/cron';
    const jobs = [{ id: 'job-1', schedule: { kind: 'cron', expr: '0 18 * * *' } }];
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ data: jobs }),
    });

    const { loadJobs } = require('../../scripts/sync-openclaw-schedule');
    const result = await loadJobs();

    expect(result).toEqual({ jobs, source: 'http://agentx.test/api/openclaw/cron' });
    expect(global.fetch).toHaveBeenCalledWith(
      'http://agentx.test/api/openclaw/cron',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('parses cron and interval schedules from official OpenClaw jobs', () => {
    const { parseCronSchedule } = require('../../scripts/sync-openclaw-schedule');

    expect(parseCronSchedule({
      schedule: { kind: 'cron', expr: '0 18 * * *', tz: 'America/Toronto' }
    })).toEqual({ type: 'cron', cron: '0 18 * * *', timezone: 'America/Toronto' });
    expect(parseCronSchedule({
      schedule: { kind: 'every', everyMs: 900000 }
    })).toEqual({ type: 'interval', intervalMs: 900000, timezone: 'America/Toronto' });
  });
});
