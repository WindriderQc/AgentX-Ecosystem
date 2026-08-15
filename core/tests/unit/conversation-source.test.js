const Conversation = require('../../models/Conversation');

describe('Conversation source fields', () => {
  it('defaults source to agentx', () => {
    const conv = new Conversation({ model: 'test' });
    expect(conv.source).toBe('agentx');
    expect(conv.clientRef).toBeUndefined();
  });

  it('accepts a bounded external source with an opaque client ref', () => {
    const conv = new Conversation({
      model: 'qwen3-coder:30b',
      source: 'external',
      clientRef: 'client-42'
    });
    expect(conv.source).toBe('external');
    expect(conv.clientRef).toBe('client-42');
  });

  it('rejects invalid source enum', async () => {
    const conv = new Conversation({ model: 'test', source: 'invalid' });
    const err = conv.validateSync();
    expect(err.errors.source).toBeDefined();
  });
});
