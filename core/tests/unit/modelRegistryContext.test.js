'use strict';

const ModelRegistry = require('../../models/ModelRegistry');

describe('ModelRegistry context policy', () => {
  it('accepts explicit contexts above the former 131K ceiling', () => {
    const model = new ModelRegistry({
      modelName: 'qwen3.8:27b-mtp-q8_0',
      displayName: 'Qwen 3.8 27B',
      executionOverrides: { num_ctx: 262144 },
      executionDefaults: { num_ctx: 262144, _source: 'user' },
      capabilities: { maxContext: 262144 }
    });

    expect(model.validateSync()).toBeUndefined();
  });

  it('leaves num_ctx unresolved when no explicit or measured evidence exists', () => {
    const model = new ModelRegistry({
      modelName: 'unprofiled:27b',
      displayName: 'Unprofiled 27B'
    });

    expect(model.getEffectiveConfig().num_ctx).toEqual({
      value: null,
      source: 'unresolved'
    });
    expect(model.capabilities.maxContext).toBeNull();
  });
});
