'use strict';

const { _internal } = require('../../../src/services/hostTestService');

describe('streaming host-test TTFT', () => {
  it('measures wall-to-wall time at the first emitted output token and keeps terminal metrics', async () => {
    const response = {
      stream() {
        return (async function* () {
          yield Buffer.from('{"response":"A","done":false}\n');
          yield Buffer.from('{"response":"","done":true,"eval_count":1,"eval_duration":1000000000,"prompt_eval_duration":250000000}\n');
        })();
      }
    };

    const result = await _internal.readOllamaGenerateStream(response, 1_000, () => 1_125);
    expect(result.timeToFirstTokenMs).toBe(125);
    expect(result.data).toMatchObject({ response: 'A', done: true, eval_count: 1 });
  });

  it('keeps TTFT unknown when the stream produces no output token', async () => {
    const response = {
      stream() {
        return (async function* () {
          yield Buffer.from('{"response":"","done":true,"eval_count":0}\n');
        })();
      }
    };
    await expect(_internal.readOllamaGenerateStream(response, 1_000, () => 1_125))
      .resolves.toMatchObject({ timeToFirstTokenMs: null });
  });
});
