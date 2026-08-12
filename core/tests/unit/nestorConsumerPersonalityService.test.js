'use strict';

const mockGetPersonality = jest.fn();
const mockHermesStatus = jest.fn();
const mockListOpenclawAgents = jest.fn();

jest.mock('../../src/services/personalityAdapters', () => ({
  getPersonality: (...args) => mockGetPersonality(...args),
  getHermesPersonalitySourceStatus: (...args) => mockHermesStatus(...args),
  listOpenclawAgents: (...args) => mockListOpenclawAgents(...args),
}));

const fs = require('fs');
const {
  getPersonalitySources,
  resolveAgentxNestorRole,
  resolvePersonalityCandidate,
} = require('../../src/services/nestorConsumerPersonalityService');

describe('Nestor read-only personality candidates', () => {
  let readFileSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    readFileSpy = jest.spyOn(fs.promises, 'readFile').mockResolvedValue('# Nestor role');
    mockHermesStatus.mockResolvedValue({ available: true, ref: 'hermes:SOUL.md' });
    mockListOpenclawAgents.mockResolvedValue([{ id: 'main' }]);
  });

  afterEach(() => readFileSpy.mockRestore());

  it('discovers AgentX, Hermes, and OpenClaw without importing the Buddy model', async () => {
    const result = await getPersonalitySources();
    expect(result.sources.agentx.available).toBe(true);
    expect(result.sources.hermes.available).toBe(true);
    expect(result.sources.openclaw.agents).toEqual([{ id: 'main' }]);
  });

  it('resolves candidates with provenance and does not save configuration', async () => {
    mockGetPersonality.mockResolvedValue({ soul: 'Hermes soul', ref: 'hermes:SOUL.md' });
    const hermes = await resolvePersonalityCandidate({ source: 'hermes' });
    const agentx = await resolvePersonalityCandidate({ source: 'agentx' });
    expect(hermes).toEqual(expect.objectContaining({ source: 'hermes', ref: 'hermes:SOUL.md', soul: 'Hermes soul' }));
    expect(agentx).toEqual(expect.objectContaining({ source: 'agentx', ref: 'agentx:roles/Nestor.md' }));
    expect(mockGetPersonality).toHaveBeenCalledWith({ source: 'hermes', agentId: '' });
  });

  it('requires an OpenClaw agent id and rejects personal standalone authority', async () => {
    await expect(resolvePersonalityCandidate({ source: 'openclaw' }))
      .rejects.toEqual(expect.objectContaining({ code: 'AGENT_ID_REQUIRED' }));
    await expect(resolvePersonalityCandidate({ source: 'standalone' }))
      .rejects.toEqual(expect.objectContaining({ code: 'UNKNOWN_PERSONALITY_SOURCE' }));
  });

  it('resolves the packaged AgentX role and rejects OpenClaw path traversal before adapters run', async () => {
    expect(resolveAgentxNestorRole({ AGENTX_REPO_ROOT: '/workspace/agentx' }))
      .toBe(require('path').resolve('/workspace/agentx/roles/Nestor.md'));
    await expect(resolvePersonalityCandidate({ source: 'openclaw', agentId: '../../outside' }))
      .rejects.toEqual(expect.objectContaining({ code: 'INVALID_AGENT_ID' }));
    expect(mockGetPersonality).not.toHaveBeenCalled();
  });
});
