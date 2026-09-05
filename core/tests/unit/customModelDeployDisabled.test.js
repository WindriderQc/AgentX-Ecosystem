'use strict';

jest.mock('../../models/CustomModel', () => ({}));

const customModelService = require('../../src/services/customModelService');

describe('custom model runtime deployment boundary', () => {
  test('cannot dispatch the legacy direct Ollama create operation', async () => {
    await expect(customModelService.deployToOllama(
      'custom-a',
      'http://ollama.test:11434'
    )).rejects.toMatchObject({
      code: 'CUSTOM_MODEL_DEPLOY_DISABLED',
      statusCode: 409
    });

    expect(customModelService._deployToOllamaAPI).toBeUndefined();
  });
});
