'use strict';

const express = require('express');
const request = require('supertest');

const mockFindOne = jest.fn();
const mockSort = jest.fn();
const mockSave = jest.fn();

jest.mock('../../models/PromptConfig', () => {
  const MockPromptConfig = jest.fn(function PromptConfig(values) {
    Object.assign(this, values);
    this.save = () => mockSave(this);
  });
  MockPromptConfig.findOne = (...args) => mockFindOne(...args);
  return MockPromptConfig;
});

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

const PromptConfig = require('../../models/PromptConfig');
const logger = require('../../config/logger');
const promptRoutes = require('../../routes/prompts');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/prompts', promptRoutes);
  return app;
}

function duplicateKeyError() {
  return Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
}

describe('POST /api/prompts create contract', () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindOne.mockImplementation(() => ({ sort: mockSort }));
    mockSort.mockResolvedValue(null);
    mockSave.mockImplementation(async (prompt) => {
      prompt._id = `prompt-${prompt.version}`;
      prompt.stats = { impressions: 0, positiveCount: 0, negativeCount: 0 };
      return prompt;
    });
  });

  test.each([
    ['a non-object body', [], 'Request body must be a JSON object'],
    ['a missing name', { systemPrompt: 'Be useful.' }, 'name must be a non-empty string'],
    ['a non-string name', { name: 42, systemPrompt: 'Be useful.' }, 'name must be a non-empty string'],
    ['a whitespace-only name', { name: '   ', systemPrompt: 'Be useful.' }, 'name must be a non-empty string'],
    ['an overlong name', { name: 'n'.repeat(121), systemPrompt: 'Be useful.' }, 'name must be 120 characters or fewer'],
    ['a missing system prompt', { name: 'test_prompt' }, 'systemPrompt must be a non-empty string'],
    ['a non-string system prompt', { name: 'test_prompt', systemPrompt: 42 }, 'systemPrompt must be a non-empty string'],
    ['a whitespace-only system prompt', { name: 'test_prompt', systemPrompt: '\n\t ' }, 'systemPrompt must be a non-empty string'],
    ['a non-string description', { name: 'test_prompt', systemPrompt: 'Be useful.', description: null }, 'description must be a string'],
    ['an overlong description', { name: 'test_prompt', systemPrompt: 'Be useful.', description: 'd'.repeat(501) }, 'description must be 500 characters or fewer'],
    ['a non-boolean active flag', { name: 'test_prompt', systemPrompt: 'Be useful.', isActive: 'false' }, 'isActive must be a boolean'],
    ['a string traffic weight', { name: 'test_prompt', systemPrompt: 'Be useful.', trafficWeight: '50' }, 'trafficWeight must be a number between 0 and 100'],
    ['a null traffic weight', { name: 'test_prompt', systemPrompt: 'Be useful.', trafficWeight: null }, 'trafficWeight must be a number between 0 and 100'],
    ['a negative traffic weight', { name: 'test_prompt', systemPrompt: 'Be useful.', trafficWeight: -1 }, 'trafficWeight must be a number between 0 and 100'],
    ['an excessive traffic weight', { name: 'test_prompt', systemPrompt: 'Be useful.', trafficWeight: 101 }, 'trafficWeight must be a number between 0 and 100']
  ])('rejects %s with the stable error envelope', async (_label, body, message) => {
    const response = await request(app)
      .post('/api/prompts')
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ status: 'error', message });
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  test('normalizes persisted metadata while preserving the system prompt text', async () => {
    mockSort.mockResolvedValue({ version: 4 });
    const systemPrompt = '\n  Keep this indentation.  \n';

    const response = await request(app)
      .post('/api/prompts')
      .send({
        name: '  test_trimmed  ',
        systemPrompt,
        description: '  Trimmed description  ',
        isActive: false,
        trafficWeight: 0
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      status: 'success',
      data: {
        _id: 'prompt-5',
        name: 'test_trimmed',
        version: 5,
        systemPrompt,
        description: 'Trimmed description',
        isActive: false,
        trafficWeight: 0
      }
    });
    expect(mockFindOne).toHaveBeenCalledWith({ name: 'test_trimmed' });
    expect(mockSort).toHaveBeenCalledWith({ version: -1 });
    expect(PromptConfig).toHaveBeenCalledWith({
      name: 'test_trimmed',
      systemPrompt,
      description: 'Trimmed description',
      version: 5,
      isActive: false,
      trafficWeight: 0
    });
  });

  test('checks a normalized name against the removed-persona boundary', async () => {
    const response = await request(app)
      .post('/api/prompts')
      .send({ name: '  visual_llm  ', systemPrompt: 'Do not persist this.' });

    expect(response.status).toBe(410);
    expect(response.body).toEqual({
      status: 'error',
      message: 'This persona name has been removed from the runtime'
    });
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  test('re-reads the latest version and succeeds after a duplicate-key race', async () => {
    mockSort
      .mockResolvedValueOnce({ version: 1 })
      .mockResolvedValueOnce({ version: 2 });
    mockSave.mockRejectedValueOnce(duplicateKeyError());

    const response = await request(app)
      .post('/api/prompts')
      .send({
        name: 'test_race',
        systemPrompt: 'Be concurrency-safe.',
        description: '   '
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      status: 'success',
      data: {
        name: 'test_race',
        version: 3,
        description: 'test_race v3'
      }
    });
    expect(mockFindOne).toHaveBeenCalledTimes(2);
    expect(mockSave).toHaveBeenCalledTimes(2);
    expect(PromptConfig.mock.calls.map(([values]) => values.version)).toEqual([2, 3]);
    expect(PromptConfig.mock.calls.map(([values]) => values.description)).toEqual([
      'test_race v2',
      'test_race v3'
    ]);
  });

  test('bounds duplicate-key allocation attempts and returns a conflict envelope', async () => {
    mockSave.mockRejectedValue(duplicateKeyError());

    const response = await request(app)
      .post('/api/prompts')
      .send({ name: 'test_contended', systemPrompt: 'Be bounded.' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      status: 'error',
      message: 'Could not allocate a prompt version because of concurrent updates. Please retry.'
    });
    expect(mockFindOne).toHaveBeenCalledTimes(3);
    expect(mockSave).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith('Prompt version allocation conflict', {
      name: 'test_contended',
      attempts: 3
    });
  });

  test('does not retry a non-duplicate persistence failure', async () => {
    mockSave.mockRejectedValue(new Error('storage unavailable'));

    const response = await request(app)
      .post('/api/prompts')
      .send({ name: 'test_storage_error', systemPrompt: 'Fail once.' });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ status: 'error', message: 'storage unavailable' });
    expect(mockFindOne).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });
});
