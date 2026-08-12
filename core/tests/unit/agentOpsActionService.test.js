const mockLogActivity = jest.fn();
const mockFindOneAndUpdate = jest.fn();

jest.mock('../../models/ActivityLog', () => ({
  logActivity: (...args) => mockLogActivity(...args)
}));

jest.mock('../../models/PipelineTask', () => ({
  findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args)
}));

const {
  AgentOpsActionError,
  confirmationKey,
  executeAgentOpsAction
} = require('../../src/services/agentOpsActionService');

const PROJECTION = {
  agents: [
    { id: 'codex', registryId: 'codex', name: 'Codex', status: 'lead' },
    { id: 'old', registryId: 'old', name: 'Old', status: 'superseded' }
  ],
  work: {
    active: [{ pipelineId: '0400', title: 'Queued task', status: 'queued', assignee: null }]
  }
};

describe('agentOpsActionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLogActivity.mockResolvedValue({});
  });

  test('builds an exact action confirmation key', () => {
    expect(confirmationKey('work-claim', '0400')).toBe('work-claim:0400');
  });

  test('rejects duplicated runtime automation mutations', async () => {
    await expect(executeAgentOpsAction({
      action: 'automation-run',
      target: 'live-job',
      projection: PROJECTION,
      requestMeta: { username: 'operator' }
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_ACTION', status: 400 });
  });

  test('atomically assigns queued work to an active registered identity', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ pipelineId: '0400', status: 'in_progress', assignee: 'codex' });

    const result = await executeAgentOpsAction({
      action: 'work-claim',
      target: '0400',
      assignee: 'Codex',
      projection: PROJECTION
    });

    expect(result).toMatchObject({ action: 'work-claim', target: '0400', assignee: 'codex' });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { pipelineId: '0400', status: 'queued', assignee: null },
      { $set: expect.objectContaining({ assignee: 'codex', status: 'in_progress', heartbeatAt: expect.any(Date) }) },
      { new: true }
    );
  });

  test('rejects superseded assignees', async () => {
    await expect(executeAgentOpsAction({
      action: 'work-claim',
      target: '0400',
      assignee: 'old',
      projection: PROJECTION
    })).rejects.toBeInstanceOf(AgentOpsActionError);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
