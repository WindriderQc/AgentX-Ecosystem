const Conversation = require('../../models/Conversation');

describe('Conversation source fields', () => {
  it('defaults source to agentx', () => {
    const conv = new Conversation({ model: 'test' });
    expect(conv.source).toBe('agentx');
    expect(conv.openclawAgentId).toBeUndefined();
  });

  it('accepts openclaw source with agentId', () => {
    const conv = new Conversation({
      model: 'qwen3-coder:30b',
      source: 'openclaw',
      openclawAgentId: 'clawdx-coder'
    });
    expect(conv.source).toBe('openclaw');
    expect(conv.openclawAgentId).toBe('clawdx-coder');
  });

  it('rejects invalid source enum', async () => {
    const conv = new Conversation({ model: 'test', source: 'invalid' });
    const err = conv.validateSync();
    expect(err.errors.source).toBeDefined();
  });
});
