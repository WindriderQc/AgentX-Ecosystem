'use strict';

const {
  buildLiveTransport,
  parseArgs
} = require('../../../scripts/toolcall-qualification');

describe('toolcall qualification live transport bounds', () => {
  test('uses Core workload admission for a successful tool call', async () => {
    const generateImpl = jest.fn(async () => ({
      done: true,
      message: {
        tool_calls: [{ function: { name: 'lookup', arguments: { id: 7 } } }]
      }
    }));
    const transport = buildLiveTransport({
      model: 'candidate',
      host: 'http://ollama:11434',
      generateImpl,
      timeoutMs: 1000
    });

    await expect(transport({
      messages: [],
      tools: [],
      workloadId: 'campaign-a',
      execution: {
        numCtx: 32768,
        numPredict: 1024,
        think: false,
        sampling: { temperature: 0, seed: 42 }
      }
    })).resolves.toEqual({
      toolCalls: [{ name: 'lookup', args: { id: 7 } }]
    });
    expect(generateImpl).toHaveBeenCalledWith('campaign-a', expect.objectContaining({
      model: 'candidate',
      host: 'http://ollama:11434',
      stream: false,
      rawResponse: true,
      think: false,
      options: { num_ctx: 32768, num_predict: 1024, temperature: 0, seed: 42 }
    }), { signal: expect.any(AbortSignal) });
  });

  test('refuses to dispatch without the exact workload identity', async () => {
    const generateImpl = jest.fn();
    const transport = buildLiveTransport({
      model: 'candidate',
      host: 'http://ollama:11434',
      generateImpl,
      timeoutMs: 1000
    });

    await expect(transport({ messages: [], tools: [] }))
      .rejects.toMatchObject({ code: 'WORKLOAD_ADMISSION_REQUIRED' });
    expect(generateImpl).not.toHaveBeenCalled();
  });

  test('classifies only an explicit Ollama no-tool-surface response as unsupported', async () => {
    const failure = Object.assign(new Error('Core API 400: model does not support tools'), { status: 400 });
    const generateImpl = jest.fn(async () => { throw failure; });
    const transport = buildLiveTransport({
      model: 'candidate',
      host: 'http://ollama:11434',
      generateImpl,
      timeoutMs: 1000
    });

    await expect(transport({ messages: [], tools: [], workloadId: 'campaign-a' }))
      .resolves.toEqual({ toolSupport: false });
  });

  test('rejects a successful HTTP response without Ollama terminal evidence', async () => {
    const generateImpl = jest.fn(async () => ({
      message: { tool_calls: [{ function: { name: 'lookup', arguments: {} } }] }
    }));
    const transport = buildLiveTransport({
      model: 'candidate',
      host: 'http://ollama:11434',
      generateImpl,
      timeoutMs: 1000
    });

    await expect(transport({ messages: [], tools: [], workloadId: 'campaign-a' }))
      .rejects.toMatchObject({ code: 'OLLAMA_RESPONSE_INCOMPLETE' });
  });

  test('parses the typed campaign token and mandatory repetition count', () => {
    expect(parseArgs([
      'node',
      'toolcall-qualification.js',
      '--live',
      '--model', 'candidate',
      '--host', 'http://ollama:11434',
      '--repetitions', '5',
      '--confirm-campaign', 'RUN_NATIVE_TOOL_QUALIFICATION'
    ])).toMatchObject({
      live: true,
      model: 'candidate',
      host: 'http://ollama:11434',
      repetitions: 5,
      confirmCampaign: 'RUN_NATIVE_TOOL_QUALIFICATION'
    });
  });
});
