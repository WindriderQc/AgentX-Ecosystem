'use strict';

const mockGetActive = jest.fn();
const mockFindOne = jest.fn().mockResolvedValue({ name: 'default_chat', version: 1 });

jest.mock('../../models/PromptConfig', () => {
  const MockPromptConfig = jest.fn();
  MockPromptConfig.getActive = (...args) => mockGetActive(...args);
  MockPromptConfig.findOne = (...args) => mockFindOne(...args);
  return MockPromptConfig;
});
jest.mock('../../config/logger', () => ({ warn: jest.fn() }));

const { getActivePrompt } = require('../../src/services/chat/chatPromptHelpers');

describe('chatPromptHelpers', () => {
  beforeEach(() => jest.clearAllMocks());

  test('uses an explicit authoritative system prompt without consulting stored personas', async () => {
    const prompt = await getActivePrompt('Nestor local system.', 'default_chat', {
      preferSystem: true
    });

    expect(prompt).toEqual({
      systemPrompt: 'Nestor local system.',
      version: 'request-override',
      name: 'default_chat',
      _id: null
    });
    expect(mockGetActive).not.toHaveBeenCalled();
  });

  test('preserves stored prompt precedence for ordinary chat callers', async () => {
    mockGetActive.mockResolvedValue({
      systemPrompt: 'Stored prompt.',
      version: 3,
      name: 'default_chat',
      _id: 'prompt-3'
    });

    const prompt = await getActivePrompt('Request prompt.', 'default_chat');

    expect(prompt.systemPrompt).toBe('Stored prompt.');
    expect(mockGetActive).toHaveBeenCalledWith('default_chat');
  });
});
