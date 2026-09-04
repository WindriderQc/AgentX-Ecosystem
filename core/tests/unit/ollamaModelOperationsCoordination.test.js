'use strict';

jest.mock('node-fetch', () => jest.fn());
jest.mock('../../src/services/runtimeMutationLeaseService', () => ({
  beginRuntimeMutation: jest.fn()
}));

const fetch = require('node-fetch');
const { beginRuntimeMutation } = require('../../src/services/runtimeMutationLeaseService');
const operations = require('../../src/services/ollamaModelOperations');

function lifecycle() {
  return {
    signal: new AbortController().signal,
    markDispatched: jest.fn(),
    assertActive: jest.fn(),
    complete: jest.fn(async () => ({ released: true })),
    abandon: jest.fn(async () => ({ quarantined: true }))
  };
}

describe('Ollama model mutations use durable runtime coordination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([
    ['pull', () => operations.pullModel('http://host:11434', 'model-a', { principal: 'operator-token' }), '/api/pull', '{"status":"success"}'],
    ['start', () => operations.startModel('http://host:11434', 'model-a', '5m', { principal: 'operator-token' }), '/api/generate', '{"done":true}'],
    ['stop', () => operations.stopModel('http://host:11434', 'model-a', { principal: 'operator-token' }), '/api/generate', '{"done":true}'],
    ['delete', () => operations.deleteModel('http://host:11434', 'model-a', { principal: 'operator-token' }), '/api/delete', '']
  ])('%s holds maintenance through the full response body', async (_action, invoke, path, terminalBody) => {
    const lease = lifecycle();
    beginRuntimeMutation.mockResolvedValueOnce(lease);
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: jest.fn(async () => terminalBody)
    });
    await invoke();
    expect(beginRuntimeMutation).toHaveBeenCalledWith(expect.objectContaining({ principal: 'operator-token' }));
    expect(fetch.mock.calls[0][0]).toBe(`http://host:11434${path}`);
    expect(lease.markDispatched.mock.invocationCallOrder[0])
      .toBeLessThan(lease.complete.mock.invocationCallOrder[0]);
    expect(lease.complete).toHaveBeenCalledTimes(1);
    expect(lease.abandon).not.toHaveBeenCalled();
  });

  test('transport ambiguity quarantines and never releases the maintenance fence', async () => {
    const lease = lifecycle();
    beginRuntimeMutation.mockResolvedValueOnce(lease);
    const failure = new Error('socket reset after dispatch');
    fetch.mockRejectedValueOnce(failure);
    await expect(operations.pullModel('http://host:11434', 'model-a', { principal: 'operator-token' }))
      .rejects.toBe(failure);
    expect(lease.abandon).toHaveBeenCalledWith(failure);
    expect(lease.complete).not.toHaveBeenCalled();
  });

  test.each([
    ['pull', () => operations.pullModel('http://host:11434', 'model-a'), '{"status":"downloading"}'],
    ['start', () => operations.startModel('http://host:11434', 'model-a'), '{"done":false}'],
    ['stop', () => operations.stopModel('http://host:11434', 'model-a'), 'not-json'],
    ['delete', () => operations.deleteModel('http://host:11434', 'model-a'), '{"status":"success"}']
  ])('%s quarantines a non-terminal success response', async (_action, invoke, terminalBody) => {
    const lease = lifecycle();
    beginRuntimeMutation.mockResolvedValueOnce(lease);
    fetch.mockResolvedValueOnce({ ok: true, status: 200, text: jest.fn(async () => terminalBody) });

    await expect(invoke()).rejects.toMatchObject({ code: 'OLLAMA_MUTATION_TERMINAL_INVALID' });

    expect(lease.abandon).toHaveBeenCalledTimes(1);
    expect(lease.complete).not.toHaveBeenCalled();
  });
});
