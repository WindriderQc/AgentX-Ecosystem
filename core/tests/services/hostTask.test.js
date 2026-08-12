'use strict';

jest.mock('../../models/HostTask');
const HostTask = require('../../models/HostTask');
const taskService = require('../../src/services/hostTaskService');

afterEach(() => jest.clearAllMocks());

describe('hostTaskService', () => {
  test('createTask creates a pending task', async () => {
    const mockTask = { _id: 'abc', hostId: 'h1', type: 'diag.ping', params: {}, status: 'pending' };
    HostTask.create.mockResolvedValue(mockTask);

    const result = await taskService.createTask('h1', 'diag.ping', {});
    expect(HostTask.create).toHaveBeenCalledWith(expect.objectContaining({
      hostId: 'h1', type: 'diag.ping', status: 'pending'
    }));
    expect(result.status).toBe('pending');
  });

  test('createTask rejects unknown task type', async () => {
    await expect(taskService.createTask('h1', 'rm.rf', {}))
      .rejects.toThrow('Unknown task type');
  });

  test('getPendingTasks returns pending tasks for a host', async () => {
    const mockQuery = { sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) };
    HostTask.find.mockReturnValue(mockQuery);

    await taskService.getPendingTasks('h1');
    expect(HostTask.find).toHaveBeenCalledWith({ hostId: 'h1', status: 'pending' });
  });

  test('processTaskResults marks tasks completed or failed', async () => {
    HostTask.findByIdAndUpdate.mockResolvedValue({});
    const results = [
      { taskId: 't1', status: 'completed', result: { ok: true } },
      { taskId: 't2', status: 'failed', result: { error: 'timeout' } }
    ];

    await taskService.processTaskResults(results);
    expect(HostTask.findByIdAndUpdate).toHaveBeenCalledTimes(2);
    expect(HostTask.findByIdAndUpdate).toHaveBeenCalledWith('t1', expect.objectContaining({ status: 'completed' }));
    expect(HostTask.findByIdAndUpdate).toHaveBeenCalledWith('t2', expect.objectContaining({ status: 'failed' }));
  });

  test('dispatchTasks marks tasks as dispatched and returns them', async () => {
    const pending = [{ _id: 't1', type: 'diag.ping', params: {} }];
    const mockQuery = { sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(pending) };
    HostTask.find.mockReturnValue(mockQuery);
    HostTask.updateMany.mockResolvedValue({});

    const result = await taskService.dispatchTasks('h1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('t1');
  });
});
