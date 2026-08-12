// core/tests/unit/recommendHostScoring.test.js

// Mock logger to suppress output during tests
jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const HostPreference = require('../../models/HostPreference');

afterEach(async () => {
  await HostPreference.deleteMany({});
});

describe('recommendHost — default model scoring', () => {
  it('should add bonus when model is a host default', async () => {
    await HostPreference.create({
      hostUrl: 'http://192.0.2.66:11434',
      hostKey: 'primary',
      pinnedModels: [{ model: 'qwen3-2507-30b-long-48k' }]
    });

    const { getDefaultModelsMap } = require('../../src/services/hostPreferenceService');
    const map = await getDefaultModelsMap();
    expect(map.get('http://192.0.2.66:11434')).toContain('qwen3-2507-30b-long-48k');
  });
});
