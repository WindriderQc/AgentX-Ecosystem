'use strict';

const { PassThrough } = require('stream');
const { executeAdmittedOllamaStream } = require('../../src/services/routing/inferenceStreamExecutor');

function fixture(overrides = {}) {
  const source = new PassThrough();
  const release = jest.fn(async () => {});
  const admission = {
    markDispatched: jest.fn(), assertActive: jest.fn(),
    complete: jest.fn(async () => {}), abandon: jest.fn(async () => {}),
  };
  const deps = {
    beginInferenceAdmission: jest.fn(async ({ signal }) => ({ ...admission, signal })),
    hostGate: { acquire: jest.fn(async () => release) },
    fetch: jest.fn(async () => ({ ok: true, status: 200, body: source })),
    ...overrides,
  };
  return { source, release, admission, deps };
}
const request = {
  hostUrl: 'http://ollama.test:11434', model: 'exact-tag', useChat: true,
  payload: { model: 'exact-tag', messages: [{ role: 'user', content: 'hello' }], stream: true },
  timeoutMs: 1000,
};
async function read(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('relays UTF-8 bytes exactly and releases once after source EOF', async () => {
  const { source, deps, admission, release } = fixture();
  const attempt = await executeAdmittedOllamaStream(request, deps);
  const bytes = Buffer.from('{"message":{"content":"été"},"done":false}\n{"done":true,"eval_count":0}\n');
  const reading = read(attempt.stream);
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  source.write(bytes.subarray(0, split));
  source.write(bytes.subarray(split));
  expect(admission.complete).not.toHaveBeenCalled();
  source.end();
  expect(await reading).toEqual(bytes);
  expect(await attempt.completion).toMatchObject({ completed: true, terminalComplete: true, eval_count: 0 });
  expect(admission.complete).toHaveBeenCalledTimes(1);
  expect(admission.abandon).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
  expect(deps.fetch).toHaveBeenCalledTimes(1);
});

test.each([
  ['oversized discarded frame', `${'x'.repeat(65537)}\n{"done":true}\n`],
  ['SSE envelope on a native endpoint', 'data: {"done":true}\n'],
  ['data after terminal', '{"done":true}\n{"done":false}\n'],
])('%s cannot produce terminal proof', async (_label, bytes) => {
  const { source, deps, admission, release } = fixture();
  const attempt = await executeAdmittedOllamaStream(request, deps);
  const reading = read(attempt.stream);
  source.end(bytes);
  await expect(reading).rejects.toMatchObject({ code: 'OLLAMA_STREAM_INCOMPLETE' });
  expect(await attempt.completion).toMatchObject({ completed: false });
  expect(admission.complete).not.toHaveBeenCalled();
  expect(admission.abandon).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
});

test('an owned deadline terminates a stalled body even before anyone reads it', async () => {
  const { source, deps, admission, release } = fixture();
  const attempt = await executeAdmittedOllamaStream({ ...request, timeoutMs: 20 }, deps);
  const errors = [];
  attempt.stream.on('error', error => errors.push(error));
  await new Promise(resolve => attempt.stream.once('close', resolve));
  expect(await attempt.completion).toMatchObject({ completed: false });
  expect(errors).toEqual([expect.objectContaining({ name: 'AbortError', isOllamaTimeout: true })]);
  expect(source.destroyed).toBe(true);
  expect(admission.abandon).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
});

test('caller cancellation terminates a body without adding a fallback attempt', async () => {
  const { source, deps, admission, release } = fixture();
  const controller = new AbortController();
  const attempt = await executeAdmittedOllamaStream({ ...request, signal: controller.signal }, deps);
  attempt.stream.on('error', () => {});
  const closed = new Promise(resolve => attempt.stream.once('close', resolve));
  controller.abort();
  await closed;
  expect(await attempt.completion).toMatchObject({ completed: false });
  expect(source.destroyed).toBe(true);
  expect(deps.fetch).toHaveBeenCalledTimes(1);
  expect(admission.abandon).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
});

test('a settlement failure remains an error and releases its local slot once', async () => {
  const { source, deps, admission, release } = fixture();
  admission.complete.mockImplementation(() => { throw new Error('fence lost'); });
  const attempt = await executeAdmittedOllamaStream(request, deps);
  const reading = read(attempt.stream);
  source.end('{"done":true}\n');
  await reading;
  expect(await attempt.completion).toMatchObject({ completed: false, admissionError: 'fence lost' });
  expect(admission.abandon).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
});

test('an exact HTTP rejection returns once without changing model or retrying', async () => {
  const { deps, admission, release } = fixture({
    fetch: jest.fn(async () => ({ ok: false, status: 404, text: async () => '{"error":"model not found"}' })),
  });
  const attempt = await executeAdmittedOllamaStream({ ...request, verifyRejection: true }, deps);
  expect(attempt).toMatchObject({ ok: false, status: 404, data: { error: 'model not found' } });
  expect(JSON.parse(deps.fetch.mock.calls[0][1].body).model).toBe('exact-tag');
  expect(deps.fetch).toHaveBeenCalledTimes(1);
  expect(admission.complete).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
});

test('embeddings remain buffered on their native endpoint even with a stream preference', async () => {
  const { deps, admission, release } = fixture({
    fetch: jest.fn(async () => ({ ok: true, status: 200, text: async () => '{"embeddings":[[0,1]]}' })),
  });
  const attempt = await executeAdmittedOllamaStream({ ...request, mode: 'embed', timeoutMs: null }, deps);
  expect(attempt.data).toEqual({ embeddings: [[0, 1]] });
  expect(attempt.stream).toBeUndefined();
  expect(deps.fetch.mock.calls[0][0]).toBe('http://ollama.test:11434/api/embed');
  expect(admission.complete).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
});
