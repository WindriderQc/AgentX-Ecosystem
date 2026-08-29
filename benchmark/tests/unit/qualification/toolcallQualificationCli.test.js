'use strict';

const {
  MAX_LIVE_RESPONSE_BYTES,
  buildLiveTransport
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

    await expect(transport({ messages: [], tools: [] })).resolves.toEqual({
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
});
