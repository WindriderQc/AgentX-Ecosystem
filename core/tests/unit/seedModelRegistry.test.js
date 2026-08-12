jest.mock('../../models/ModelRegistry', () => ({}));
jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const { MODELS } = require('../../scripts/seed-model-registry');

describe('seed model registry definitions', () => {
  it('does not recreate the phantom Qwen Q4_0 registry entry', () => {
    const names = MODELS.map(model => model.modelName);

    expect(names).not.toContain('qwen2.5:7b-instruct-q4_0');
    expect(names).toContain('qwen2.5:7b-instruct-q5_K_M');
  });
});
