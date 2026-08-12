jest.mock('../../src/services/hostPreferenceService', () => ({
  getByHost: jest.fn(),
  resolvePinnedRuntimeOptions: jest.fn()
}));

const hostPreferenceService = require('../../src/services/hostPreferenceService');
const {
  applyContractOutputLimit,
  resolveEmbeddingKeepAlive
} = require('../../src/services/inferenceRuntimePolicy');

describe('inferenceRuntimePolicy', () => {
  beforeEach(() => jest.clearAllMocks());

  test('enforces the contract output reserve on routed traffic', () => {
    const options = {};
    const inferenceContract = {
      contextBudget: { output: { reservedTokens: 4096 }, enforcement: 'report_only' }
    };

    applyContractOutputLimit({ routed: true, options, inferenceContract });

    expect(options.num_predict).toBe(4096);
    expect(inferenceContract.contextBudget.enforcement).toBe('ollama_num_predict');
  });

  test('preserves explicit caller limits and direct-lane control', () => {
    const explicitOptions = { num_predict: 777 };
    const explicitContract = {
      contextBudget: { output: { reservedTokens: 4096 }, enforcement: 'report_only' }
    };
    applyContractOutputLimit({ routed: true, options: explicitOptions, inferenceContract: explicitContract });
    expect(explicitOptions.num_predict).toBe(777);
    expect(explicitContract.contextBudget.enforcement).toBe('caller_num_predict');

    const directOptions = {};
    const directContract = {
      contextBudget: { output: { reservedTokens: 4096 }, enforcement: 'report_only' }
    };
    applyContractOutputLimit({ routed: false, options: directOptions, inferenceContract: directContract });
    expect(directOptions.num_predict).toBeUndefined();
    expect(directContract.contextBudget.enforcement).toBe('report_only');
  });

  test('reads embedding residency from the matching app-managed pin', async () => {
    const pref = { pinnedModels: [{ model: 'nomic-embed-text:v1.5', keepAlive: -1 }] };
    hostPreferenceService.getByHost.mockResolvedValue(pref);
    hostPreferenceService.resolvePinnedRuntimeOptions.mockReturnValue({ keepAlive: -1 });

    await expect(resolveEmbeddingKeepAlive('http://secondary:11434', 'nomic-embed-text:v1.5'))
      .resolves.toBe(-1);
  });

  test('fails open when app configuration cannot be read', async () => {
    hostPreferenceService.getByHost.mockRejectedValue(new Error('mongo unavailable'));

    await expect(resolveEmbeddingKeepAlive('http://secondary:11434', 'nomic-embed-text:v1.5'))
      .resolves.toBeUndefined();
  });
});
