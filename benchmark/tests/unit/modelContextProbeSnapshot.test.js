'use strict';

const ModelContextProbeSnapshot = require('../../models/ModelContextProbeSnapshot');

describe('ModelContextProbeSnapshot', () => {
  it('preserves context probe completion-threshold metadata on steps', () => {
    const doc = new ModelContextProbeSnapshot({
      modelName: 'ax/qwen3.5:9b',
      hostUrl: 'http://192.0.2.12:11434',
      status: 'completed',
      steps: [{
        numCtx: 65536,
        completionTokens: 64,
        requestedCompletionTokens: 64,
        minCompletionTokens: 32,
        passed: true
      }]
    });

    const step = doc.toObject().steps[0];
    expect(step).toMatchObject({
      requestedCompletionTokens: 64,
      minCompletionTokens: 32
    });
  });
});
