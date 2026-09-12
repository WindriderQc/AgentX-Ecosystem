const { withInferenceRetry } = require('../../src/services/routing/inferenceRetry');

const busy = () => Object.assign(new Error('occupied'), { code: 'RUNTIME_INFERENCE_ADMISSION_DENIED',
  failure: { cause: 'inference_residency_active', retryable: true, safeToRetry: true } });
function clock() {
  let ms = 0;
  return { enabled: true, now: () => ms, wait: jest.fn(async delay => { ms += delay; }) };
}

test('temporary refusal retries one model call, preserving the logical operation and bounded history', async () => {
  const run = jest.fn().mockRejectedValueOnce(busy()).mockResolvedValue({ ok: true, data: { done: true } });
  const progress = jest.fn();
  const result = await withInferenceRetry(run, { ...clock(), onProgress: progress });
  expect(run).toHaveBeenCalledTimes(2);
  expect(result.retry).toMatchObject({ state: 'completed', attempts: 2,
    history: [{ attempt: 1, cause: 'inference_residency_active', delayMs: 2000 }] });
  expect(progress.mock.calls[0][0].state).toBe('waiting');
});

test('persistent temporary refusal exhausts exactly six attempts within the time ceiling', async () => {
  const run = jest.fn().mockImplementation(() => { throw busy(); });
  const timing = clock();
  await expect(withInferenceRetry(run, timing)).rejects.toMatchObject({ retry: { state: 'exhausted', attempts: 6 } });
  expect(run).toHaveBeenCalledTimes(6);
  expect(timing.now()).toBeLessThan(120000);
});

test.each(['RUNTIME_INFERENCE_ADMISSION_DENIED', 'RUNTIME_INFERENCE_RECOVERY_REQUIRED',
  'INFERENCE_HOST_INVALID', 'OLLAMA_STREAM_INCOMPLETE', 'ECONNRESET'])('%s is not blindly retried', async code => {
  const run = jest.fn().mockRejectedValue(Object.assign(new Error('unknown/permanent'), { code }));
  await expect(withInferenceRetry(run, clock())).rejects.toMatchObject({ code, retry: { attempts: 1 } });
  expect(run).toHaveBeenCalledTimes(1);
});

test('Retry-After is respected, including refusal to wait past the deadline', async () => {
  const result = { ok: false, status: 503, response: { headers: new Map([['retry-after', '30']]) } };
  const run = jest.fn().mockResolvedValueOnce(result).mockResolvedValue({ ok: true });
  const timing = clock();
  await withInferenceRetry(run, timing);
  expect(timing.wait.mock.calls[0][0]).toBe(30000);
  await expect(withInferenceRetry(jest.fn().mockResolvedValue(result), { ...clock(), maxElapsedMs: 10000 }))
    .rejects.toMatchObject({ retry: { state: 'exhausted', attempts: 1 } });
});

test('cancellation during backoff stops without another provider call', async () => {
  const controller = new AbortController();
  const run = jest.fn().mockRejectedValue(busy());
  const progress = jest.fn();
  await expect(withInferenceRetry(run, { enabled: true, signal: controller.signal, onProgress: progress,
    wait: async () => { controller.abort(); controller.signal.throwIfAborted(); } })).rejects.toBeDefined();
  expect(run).toHaveBeenCalledTimes(1);
  expect(progress.mock.calls.at(-1)[0].state).toBe('cancelled');
});

test('returning a stream closes the retry loop; partial delivery cannot call the provider again', async () => {
  const { PassThrough } = require('stream');
  const stream = new PassThrough();
  stream.on('error', () => {});
  const run = jest.fn().mockResolvedValue({ ok: true, stream });
  const result = await withInferenceRetry(run, clock());
  stream.write('{"message":{"tool_calls":[{"function":');
  stream.destroy(new Error('connection reset after partial tool call'));
  expect(result.stream).toBe(stream);
  expect(run).toHaveBeenCalledTimes(1);
});
