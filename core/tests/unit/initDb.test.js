'use strict';

const mockFindOne = jest.fn();
const mockCreate = jest.fn();
const mockSave = jest.fn();

jest.mock('../../models/PromptConfig', () => {
  function MockPromptConfig(values) {
    Object.assign(this, values);
    this.save = (...args) => mockSave(...args);
  }
  MockPromptConfig.findOne = (...args) => mockFindOne(...args);
  MockPromptConfig.create = (...args) => mockCreate(...args);
  return MockPromptConfig;
});
jest.mock('../../config/logger', () => ({ info: jest.fn(), error: jest.fn() }));

const seedDefaultData = require('../../src/helpers/initDb');

describe('default persona seed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('seeds the generic default and learning personas without private runtime data', async () => {
    mockFindOne.mockResolvedValue(null);

    await seedDefaultData();

    expect(mockFindOne.mock.calls.map(([query]) => query.name)).toEqual([
      'default_chat',
      'learning_guide'
    ]);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'learning_guide',
      isActive: true,
      description: expect.stringContaining('same local model'),
      uiConfig: expect.objectContaining({ type: 'chat', route: '/playground' })
    }));

    const learningPersona = mockCreate.mock.calls
      .map(([persona]) => persona)
      .find(persona => persona.name === 'learning_guide');
    expect(JSON.stringify(learningPersona)).not.toMatch(/openclaw|herm[eè]s|nestor|192\.168\.|credential|token/i);
  });

  test('does not overwrite an existing persona', async () => {
    mockFindOne.mockResolvedValue({ _id: 'existing' });

    await seedDefaultData();

    expect(mockCreate).not.toHaveBeenCalled();
  });
});
