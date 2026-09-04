'use strict';

const {
  MAX_LIVE_RESPONSE_BYTES,
  buildLiveTransport,
  parseArgs
} = require('../../../scripts/toolcall-qualification');

function response(body, status = 200, declaredLength) {
  const bytes = Buffer.from(JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        if (String(name).toLowerCase() !== 'content-length') return null;
        return String(declaredLength ?? bytes.byteLength);
      }
    },
    body: {
      async *[Symbol.asyncIterator]() {
        yield bytes;
      }
    }
  };
}

describe('toolcall qualification live transport bounds', () => {
  test('owns redirects, deadline, and response size for a successful tool call', async () => {
    const fetchImpl = jest.fn(async () => response({
      done: true,
      message: {
        tool_calls: [{ function: { name: 'lookup', arguments: { id: 7 } } }]
      }
    }));
    const transport = buildLiveTransport({
      model: 'candidate',
      host: 'http://ollama:11434',
      fetchImpl,
      timeoutMs: 1000
    });

    await expect(transport({
      messages: [],
      tools: [],
      execution: {
        numCtx: 32768,
        numPredict: 1024,
        think: false,
        sampling: { temperature: 0, seed: 42 }
      }
    })).resolves.toEqual({
      toolCalls: [{ name: 'lookup', args: { id: 7 } }]
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://ollama:11434/api/chat',
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        signal: expect.any(AbortSignal)
      })
    );
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      model: 'candidate',
      stream: false,
      think: false,
      options: { num_ctx: 32768, num_predict: 1024, temperature: 0, seed: 42 }
    });
  });

  test('rejects a declared response overflow before buffering it', async () => {
    const fetchImpl = jest.fn(async () => response(
      { message: { content: 'unused' } },
      200,
      MAX_LIVE_RESPONSE_BYTES + 1
    ));
    const transport = buildLiveTransport({
      model: 'candidate',
      host: 'http://ollama:11434',
      fetchImpl,
      timeoutMs: 1000
    });

    await expect(transport({ messages: [], tools: [] }))
      .rejects.toThrow(/Response body exceeded its byte limit/);
  });

  test('classifies only an explicit Ollama no-tool-surface response as unsupported', async () => {
    const fetchImpl = jest.fn(async () => response(
      { error: 'model does not support tools' },
      400
    ));
    const transport = buildLiveTransport({
      model: 'candidate',
      host: 'http://ollama:11434',
      fetchImpl,
      timeoutMs: 1000
    });

    await expect(transport({ messages: [], tools: [] }))
      .resolves.toEqual({ toolSupport: false });
  });

  test('rejects a successful HTTP response without Ollama terminal evidence', async () => {
    const fetchImpl = jest.fn(async () => response({
      message: { tool_calls: [{ function: { name: 'lookup', arguments: {} } }] }
    }));
    const transport = buildLiveTransport({
      model: 'candidate',
      host: 'http://ollama:11434',
      fetchImpl,
      timeoutMs: 1000
    });

    await expect(transport({ messages: [], tools: [] }))
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
