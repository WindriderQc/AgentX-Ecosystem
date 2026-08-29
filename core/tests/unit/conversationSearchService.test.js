jest.mock('../../models/Conversation', () => ({
  aggregate: jest.fn()
}));

jest.mock('../../config/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}));

const Conversation = require('../../models/Conversation');
const { searchConversations } = require('../../src/services/conversationSearchService');

describe('conversationSearchService', () => {
  beforeEach(() => {
    Conversation.aggregate.mockReset();
  });

  it('keeps $text inside the first $match stage for result and count pipelines', async () => {
    const aggregatePipelines = [];
    Conversation.aggregate.mockImplementation(async (pipeline) => {
      aggregatePipelines.push(pipeline);
      if (pipeline.some(stage => stage.$count)) {
        return [{ total: 1 }];
      }
      return [{ _id: 'conversation-1' }];
    });

    const result = await searchConversations({
      userId: 'default',
      query: '  smoke test  ',
      limit: 2
    });

    expect(result.status).toBe('success');
    expect(Conversation.aggregate).toHaveBeenCalledTimes(2);

    const [resultPipeline, countPipeline] = aggregatePipelines;
    expect(resultPipeline[0]).toEqual({
      $match: expect.objectContaining({
        userId: 'default',
        $nor: expect.any(Array),
        $text: { $search: 'smoke test' }
      })
    });
    expect(countPipeline[0]).toEqual({
      $match: expect.objectContaining({
        userId: 'default',
        $nor: expect.any(Array),
        $text: { $search: 'smoke test' }
      })
    });

    const laterResultTextMatches = resultPipeline.slice(1).filter(stage => stage.$match?.$text);
    const laterCountTextMatches = countPipeline.slice(1).filter(stage => stage.$match?.$text);
    expect(laterResultTextMatches).toEqual([]);
    expect(laterCountTextMatches).toEqual([]);
  });
});
