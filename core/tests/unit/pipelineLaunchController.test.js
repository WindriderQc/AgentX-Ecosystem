const Controller = require('../../public/js/pipeline-launch');
const ID = '10000000-0000-4000-8000-000000000001';
const NEXT = '10000000-0000-4000-8000-000000000002';
const selection = { requestId: ID, pipelineId: '0700', expectedAttemptCount: 0 };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const snapshot = (run = null, busy = false, count = 0) => ({ data: {
  contractVersion: 2, available: true, busy, candidates: [{ pipelineId: '0700', expectedAttemptCount: count }], run
} });
const run = (phase, status = 'queued', extra = {}) => ({ ...selection, phase, task: { pipelineId: '0700', status, automationAttemptCount: 0 }, ...extra });

describe('Pipeline launch reconciliation', () => {
  let controllers, data, request, storage, refreshTasks;
  const make = () => {
    const controller = new Controller({ request, storage, refreshTasks, newId: jest.fn().mockReturnValueOnce(ID).mockReturnValue(NEXT) });
    controllers.push(controller);
    return controller;
  };
  beforeEach(() => {
    jest.useFakeTimers();
    controllers = [];
    data = new Map();
    storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
    request = jest.fn().mockResolvedValue(snapshot());
    refreshTasks = jest.fn();
  });
  afterEach(() => { controllers.forEach(c => c.dispose()); jest.clearAllTimers(); jest.useRealTimers(); });
  const posts = () => request.mock.calls.filter(([, options]) => options.method === 'POST');

  test('double click sends one request and queued observations never unlock an accepted run', async () => {
    const controller = make();
    await controller.refresh();
    const post = deferred();
    request.mockImplementation((url, options) => options.method === 'POST' ? post.promise : Promise.resolve(snapshot(run('accepted'), true)));
    const first = controller.launch('0700');
    expect(await controller.launch('0700')).toBe(false);
    expect(posts()).toHaveLength(1);
    post.resolve({ data: { run: run('accepted') } });
    await first;
    await jest.advanceTimersByTimeAsync(8000);
    expect(controller.canLaunch('0700')).toBe(false);
    expect(controller.pending).toEqual(selection);
    expect(posts()).toHaveLength(1);
    request.mockResolvedValue(snapshot(run('running', 'in_progress'), true));
    await jest.advanceTimersByTimeAsync(2000);
    expect(controller.control.run.task.status).toBe('in_progress');
    expect(refreshTasks).toHaveBeenCalled();
  });

  test('reload during a lost response restores the same receipt using GET only', async () => {
    const controller = make();
    await controller.refresh();
    request.mockImplementation((url, options) => options.method === 'POST'
      ? Promise.reject(new Error('Connection lost')) : Promise.resolve(snapshot(run('accepted'), true)));
    await controller.launch('0700');
    controller.dispose();
    const reloaded = make();
    await reloaded.refresh();
    expect(reloaded.pending).toEqual(selection);
    expect(request.mock.calls.at(-1)[0]).toContain(`requestId=${ID}`);
    expect(posts()).toHaveLength(1);
    expect(reloaded.canLaunch('0700')).toBe(false);
  });

  test('failed or outdated status cannot re-enable an old candidate', async () => {
    const controller = make();
    await controller.refresh();
    const stale = deferred();
    request.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(snapshot(run('running'), true));
    const oldRead = controller.refresh();
    await controller.refresh();
    stale.resolve(snapshot());
    await oldRead;
    expect(controller.canLaunch('0700')).toBe(false);
    request.mockRejectedValueOnce(new Error('Host offline'));
    await controller.refresh();
    expect(controller.error).toContain('offline');
    expect(controller.canLaunch('0700')).toBe(false);
  });

  test('a terminal GET wins over a late accepted POST and permits a fresh requeued attempt', async () => {
    const controller = make();
    await controller.refresh();
    const post = deferred();
    request.mockImplementation((url, options) => options.method === 'POST' ? post.promise : Promise.resolve(snapshot(run('finished', 'blocked'))));
    const launch = controller.launch('0700');
    await jest.advanceTimersByTimeAsync(1000);
    expect(controller.pending).toBeNull();
    post.resolve({ data: { run: run('accepted') } });
    await launch;
    expect(controller.pending).toBeNull();
    expect(controller.control.run.phase).toBe('finished');
    request.mockResolvedValue(snapshot(run('finished', 'queued'), false, 1));
    await controller.refresh();
    request.mockImplementation((url, options) => Promise.resolve(options.method === 'POST'
      ? { data: { run: { ...run('accepted'), requestId: NEXT } } }
      : snapshot({ ...run('accepted'), requestId: NEXT }, true, 1)));
    await controller.launch('0700');
    expect(JSON.parse(posts()[1][1].body)).toEqual({ requestId: NEXT, pipelineId: '0700', expectedAttemptCount: 1, confirm: true });
  });

  test('a missing receipt is retried only explicitly with its original request identity', async () => {
    storage.setItem('agentx.pipeline.launchRequest.v1', JSON.stringify(selection));
    request.mockResolvedValue(snapshot(run('not_received')));
    const controller = make();
    await controller.refresh();
    await jest.advanceTimersByTimeAsync(10000);
    expect(posts()).toHaveLength(0);
    expect(controller.canRetry()).toBe(true);
    request.mockResolvedValue(snapshot(run('accepted'), true));
    await controller.retry();
    expect(JSON.parse(posts()[0][1].body)).toEqual({ ...selection, confirm: true });
    expect(controller.canRetry()).toBe(false);
  });

  test('known rejection clears pending state only after authoritative observation', async () => {
    const controller = make();
    await controller.refresh();
    request.mockImplementation((url, options) => options.method === 'POST'
      ? Promise.reject(new Error('Task changed')) : Promise.resolve(snapshot(run('rejected'))));
    await controller.launch('0700');
    expect(controller.pending).toBeNull();
    expect(data.size).toBe(0);
    expect(controller.control.run.phase).toBe('rejected');
  });

  test('unavailable local storage retains in-page exclusion and host status recovers after reload', async () => {
    storage.setItem = () => { throw new Error('Unavailable'); };
    const controller = make();
    await controller.refresh();
    request.mockResolvedValue(snapshot(run('running'), true));
    await controller.launch('0700');
    expect(controller.canLaunch('0700')).toBe(false);
    const reloaded = make();
    await reloaded.refresh();
    expect(reloaded.control.run.requestId).toBe(ID);
    expect(reloaded.pending).toEqual(selection);
    expect(reloaded.canLaunch('0700')).toBe(false);
  });

  test('disposal cancels read reconciliation without another POST', async () => {
    storage.setItem('agentx.pipeline.launchRequest.v1', JSON.stringify(selection));
    const controller = make();
    await controller.refresh();
    const count = request.mock.calls.length;
    controller.dispose();
    await jest.advanceTimersByTimeAsync(30000);
    expect(request).toHaveBeenCalledTimes(count);
    expect(controller.canRetry()).toBe(false);
  });
});
