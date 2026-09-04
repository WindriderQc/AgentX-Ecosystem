'use strict';

const fetch = require('node-fetch');
const hostGate = require('../../src/services/hostGate');
const { beginInferenceAdmission } = require('../../src/services/inferenceAdmissionService');

jest.mock('node-fetch');
jest.mock('../../src/services/inferenceAdmissionService', () => ({
  beginInferenceAdmission: jest.fn()
}));

const {
  executeAdmittedOllamaAttempt,
  executeOllamaAttempt,
  hasTerminalOllamaFrame,
  hasTerminalOllamaResponse,
  OLLAMA_ABORT_SOURCE,
} = require('../../src/services/routing/inferenceAttemptExecutor');

function rejectWhenAborted(signal) {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) rejectAbort();
    else signal.addEventListener('abort', rejectAbort, { once: true });
  });
}

describe('inferenceAttemptExecutor cancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    beginInferenceAdmission.mockImplementation(async ({ signal }) => ({
      signal,
      markDispatched: jest.fn(),
      assertActive: jest.fn(),
      complete: jest.fn().mockResolvedValue({ released: true }),
      abandon: jest.fn().mockResolvedValue({ released: true })
    }));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('owned timeout remains active while the response body stalls after headers', async () => {
    let transportSignal;
    let bodyStartedResolve;
    const bodyStarted = new Promise((resolve) => { bodyStartedResolve = resolve; });

    fetch.mockImplementation(async (_url, options) => {
      transportSignal = options.signal;
      return {
        ok: true,
        status: 200,
        text: () => {
          bodyStartedResolve();
          return rejectWhenAborted(transportSignal);
        },
      };
    });

    const attempt = executeOllamaAttempt({
      hostUrl: 'http://ollama.test:11434',
      payload: { model: 'model-a', prompt: 'hello' },
      useChat: false,
      timeoutMs: 250,
    }).catch((error) => error);

    await bodyStarted;
    expect(transportSignal.aborted).toBe(false);

    jest.advanceTimersByTime(250);
    const error = await attempt;

    expect(transportSignal.aborted).toBe(true);
    expect(error).toMatchObject({
      name: 'AbortError',
      isOllamaAttemptError: true,
      isOllamaTimeout: true,
      isCallerCancellation: false,
      ollamaAbortSource: OLLAMA_ABORT_SOURCE.TIMEOUT,
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  test('caller cancellation aborts transport and removes its listener and timeout', async () => {
    const caller = new AbortController();
    const addListener = jest.spyOn(caller.signal, 'addEventListener');
    const removeListener = jest.spyOn(caller.signal, 'removeEventListener');
    let transportSignal;
    let bodyStartedResolve;
    const bodyStarted = new Promise((resolve) => { bodyStartedResolve = resolve; });

    fetch.mockImplementation(async (_url, options) => {
      transportSignal = options.signal;
      return {
        ok: true,
        status: 200,
        text: () => {
          bodyStartedResolve();
          return rejectWhenAborted(transportSignal);
        },
      };
    });

    const attempt = executeOllamaAttempt({
      hostUrl: 'http://ollama.test:11434',
      payload: { model: 'model-a', prompt: 'hello' },
      useChat: false,
      timeoutMs: 60_000,
      signal: caller.signal,
    }).catch((error) => error);

    await bodyStarted;
    expect(transportSignal.aborted).toBe(false);
    caller.abort(new Error('private caller reason'));
    const error = await attempt;

    const attachedListener = addListener.mock.calls[0][1];
    expect(transportSignal.aborted).toBe(true);
    expect(transportSignal.reason.message).toBe('Ollama attempt cancelled by caller');
    expect(transportSignal.reason.message).not.toContain('private caller reason');
    expect(error).toMatchObject({
      name: 'AbortError',
      isOllamaAttemptError: true,
      isOllamaTimeout: false,
      isCallerCancellation: true,
      ollamaAbortSource: OLLAMA_ABORT_SOURCE.CALLER,
    });
    expect(addListener).toHaveBeenCalledWith('abort', attachedListener, { once: true });
    expect(removeListener).toHaveBeenCalledWith('abort', attachedListener);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('successful completion detaches caller cancellation without aborting transport', async () => {
    const caller = new AbortController();
    const removeListener = jest.spyOn(caller.signal, 'removeEventListener');
    let transportSignal;

    fetch.mockImplementation(async (_url, options) => {
      transportSignal = options.signal;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ response: 'done', done: true }),
      };
    });

    const result = await executeOllamaAttempt({
      hostUrl: 'http://ollama.test:11434',
      payload: { model: 'model-a', prompt: 'hello' },
      useChat: false,
      timeoutMs: 60_000,
      signal: caller.signal,
    });

    expect(result.data.response).toBe('done');
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);

    caller.abort();
    expect(transportSignal.aborted).toBe(false);
  });

  test('streaming remains free of an owned timeout while honoring caller cancellation', async () => {
    const caller = new AbortController();
    let transportSignal;

    fetch.mockImplementation((_url, options) => {
      transportSignal = options.signal;
      return rejectWhenAborted(transportSignal);
    });

    const attempt = executeOllamaAttempt({
      hostUrl: 'http://ollama.test:11434',
      payload: { model: 'model-a', prompt: 'hello', stream: true },
      useChat: false,
      stream: true,
      timeoutMs: 1,
      signal: caller.signal,
    }).catch((error) => error);

    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(60_000);
    expect(transportSignal.aborted).toBe(false);

    caller.abort();
    const error = await attempt;
    expect(error.ollamaAbortSource).toBe(OLLAMA_ABORT_SOURCE.CALLER);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('admission receives the caller signal and aborts before transport dispatch', async () => {
    const caller = new AbortController();
    let admissionSignal;
    let admissionStartedResolve;
    const admissionStarted = new Promise(resolve => { admissionStartedResolve = resolve; });
    beginInferenceAdmission.mockImplementationOnce(async ({ signal }) => {
      const controller = new AbortController();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener('abort', () => controller.abort(), { once: true });
      return {
        signal: controller.signal,
        markDispatched: jest.fn(),
        assertActive: jest.fn(),
        complete: jest.fn().mockResolvedValue({ released: true }),
        abandon: jest.fn().mockResolvedValue({ released: true })
      };
    });
    const acquireSpy = jest.spyOn(hostGate, 'acquire').mockImplementation(
      (_host, _model, options) => {
        admissionSignal = options.signal;
        admissionStartedResolve();
        return new Promise((_resolve, reject) => {
          const onAbort = () => {
            const error = new Error('Host gate admission cancelled');
            error.name = 'AbortError';
            error.code = hostGate.HOST_GATE_ABORT_CODE;
            reject(error);
          };
          if (admissionSignal.aborted) onAbort();
          else admissionSignal.addEventListener('abort', onAbort, { once: true });
        });
      }
    );

    try {
      const attempt = executeAdmittedOllamaAttempt({
        hostUrl: 'http://ollama.test:11434',
        model: 'model-a',
        payload: { model: 'model-a', prompt: 'hello' },
        useChat: false,
        timeoutMs: 60_000,
        signal: caller.signal,
      }).catch((error) => error);

      await admissionStarted;
      expect(admissionSignal).toBeDefined();
      expect(admissionSignal).not.toBe(caller.signal);
      expect(admissionSignal.aborted).toBe(false);
      caller.abort();
      const error = await attempt;

      expect(error).toMatchObject({
        name: 'AbortError',
        code: hostGate.HOST_GATE_ABORT_CODE,
        isCallerCancellation: true,
        isOllamaTimeout: false,
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      acquireSpy.mockRestore();
    }
  });

  test('distributed admission remains held until the response body reaches EOF', async () => {
    let bodyStartedResolve;
    let finishBody;
    const bodyStarted = new Promise(resolve => { bodyStartedResolve = resolve; });
    const bodyFinished = new Promise(resolve => { finishBody = resolve; });
    const lifecycle = {
      signal: new AbortController().signal,
      markDispatched: jest.fn(),
      assertActive: jest.fn(),
      complete: jest.fn().mockResolvedValue({ released: true }),
      abandon: jest.fn().mockResolvedValue({ released: false })
    };
    beginInferenceAdmission.mockResolvedValueOnce(lifecycle);
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => {
        bodyStartedResolve();
        await bodyFinished;
        return JSON.stringify({ response: 'terminal', done: true });
      }
    });

    const attempt = executeAdmittedOllamaAttempt({
      hostUrl: 'http://ollama.test:11434',
      model: 'model-a',
      payload: { model: 'model-a', prompt: 'hello' },
      useChat: false,
      timeoutMs: 60_000
    });
    await bodyStarted;
    expect(lifecycle.markDispatched).toHaveBeenCalledTimes(1);
    expect(lifecycle.complete).not.toHaveBeenCalled();

    finishBody();
    await expect(attempt).resolves.toMatchObject({ data: { response: 'terminal', done: true } });
    expect(lifecycle.complete).toHaveBeenCalledTimes(1);
    expect(lifecycle.abandon).not.toHaveBeenCalled();
  });

  test('disconnect after dispatch aborts transport and abandons into quarantine', async () => {
    const caller = new AbortController();
    let transportSignal;
    let bodyStartedResolve;
    const bodyStarted = new Promise(resolve => { bodyStartedResolve = resolve; });
    const lifecycleController = new AbortController();
    caller.signal.addEventListener('abort', () => lifecycleController.abort(new Error('caller disconnected')), { once: true });
    const lifecycle = {
      signal: lifecycleController.signal,
      markDispatched: jest.fn(),
      assertActive: jest.fn(),
      complete: jest.fn().mockResolvedValue({ released: true }),
      abandon: jest.fn().mockResolvedValue({ quarantined: true })
    };
    beginInferenceAdmission.mockResolvedValueOnce(lifecycle);
    fetch.mockImplementation(async (_url, options) => {
      transportSignal = options.signal;
      return {
        ok: true,
        status: 200,
        text: () => {
          bodyStartedResolve();
          return rejectWhenAborted(transportSignal);
        }
      };
    });

    const attempt = executeAdmittedOllamaAttempt({
      hostUrl: 'http://ollama.test:11434',
      model: 'model-a',
      payload: { model: 'model-a', prompt: 'hello' },
      useChat: false,
      stream: true,
      signal: caller.signal
    }).catch(error => error);
    await bodyStarted;
    caller.abort();
    const error = await attempt;

    expect(error).toMatchObject({ name: 'AbortError', isCallerCancellation: true });
    expect(lifecycle.markDispatched).toHaveBeenCalledTimes(1);
    expect(lifecycle.complete).not.toHaveBeenCalled();
    expect(lifecycle.abandon).toHaveBeenCalledTimes(1);
  });

  test('stream EOF without an Ollama done frame abandons the distributed admission', async () => {
    const lifecycle = {
      signal: new AbortController().signal,
      markDispatched: jest.fn(),
      assertActive: jest.fn(),
      complete: jest.fn().mockResolvedValue({ released: true }),
      abandon: jest.fn().mockResolvedValue({ quarantined: true })
    };
    beginInferenceAdmission.mockResolvedValueOnce(lifecycle);
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"response":"partial","done":false}\n'
    });

    await expect(executeAdmittedOllamaAttempt({
      hostUrl: 'http://ollama.test:11434',
      model: 'model-a',
      payload: { model: 'model-a', prompt: 'hello', stream: true },
      useChat: false,
      stream: true,
      timeoutMs: 60_000
    })).rejects.toMatchObject({ code: 'OLLAMA_STREAM_INCOMPLETE' });

    expect(lifecycle.complete).not.toHaveBeenCalled();
    expect(lifecycle.abandon).toHaveBeenCalledTimes(1);
  });

  test('stream terminal done frame permits exact admission release', async () => {
    const lifecycle = {
      signal: new AbortController().signal,
      markDispatched: jest.fn(),
      assertActive: jest.fn(),
      complete: jest.fn().mockResolvedValue({ released: true }),
      abandon: jest.fn().mockResolvedValue({ quarantined: true })
    };
    beginInferenceAdmission.mockResolvedValueOnce(lifecycle);
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"response":"partial","done":false}\n{"response":"done","done":true}\n'
    });

    await expect(executeAdmittedOllamaAttempt({
      hostUrl: 'http://ollama.test:11434',
      model: 'model-a',
      payload: { model: 'model-a', prompt: 'hello', stream: true },
      useChat: false,
      stream: true,
      timeoutMs: 60_000
    })).resolves.toMatchObject({ ok: true });

    expect(lifecycle.complete).toHaveBeenCalledTimes(1);
    expect(lifecycle.abandon).not.toHaveBeenCalled();
  });

  test.each([
    ['', 'empty EOF'],
    ['not-json', 'malformed JSON'],
    ['{"response":"partial","done":false}', 'done false'],
    ['{"response":"done","done":true} trailing', 'garbage after JSON'],
  ])('non-stream %s fails closed without completing admission (%s)', async (raw) => {
    const lifecycle = {
      signal: new AbortController().signal,
      markDispatched: jest.fn(),
      assertActive: jest.fn(),
      complete: jest.fn().mockResolvedValue({ released: true }),
      abandon: jest.fn().mockResolvedValue({ quarantined: true })
    };
    beginInferenceAdmission.mockResolvedValueOnce(lifecycle);
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => raw
    });

    await expect(executeAdmittedOllamaAttempt({
      hostUrl: 'http://ollama.test:11434',
      model: 'model-a',
      payload: { model: 'model-a', prompt: 'hello', stream: false },
      useChat: false,
      stream: false,
      timeoutMs: 60_000
    })).rejects.toMatchObject({
      code: 'OLLAMA_RESPONSE_INCOMPLETE',
      isOllamaAttemptError: true,
      ollamaTerminalObserved: false
    });

    expect(lifecycle.complete).not.toHaveBeenCalled();
    expect(lifecycle.abandon).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['{"response":"done","done":true}\n{"response":"late","done":false}\n', 'data after done'],
    ['{"response":"done","done":true}\ngarbage\n', 'garbage after done'],
    ['{"response":"done","done":true}\n{"response":"duplicate","done":true}\n', 'a duplicate terminal frame'],
    ['{"response":"partial","done":false}\ngarbage\n{"response":"done","done":true}\n', 'a malformed earlier frame'],
    ['{"response":"partial"}\n{"response":"done","done":true}\n', 'a frame without explicit done state'],
    ['{"error":"failed","done":true}\n', 'an error disguised as a done frame'],
  ])('stream fails closed when it contains %s (%s)', async (raw) => {
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => raw
    });

    await expect(executeOllamaAttempt({
      hostUrl: 'http://ollama.test:11434',
      payload: { model: 'model-a', prompt: 'hello', stream: true },
      useChat: false,
      stream: true,
      timeoutMs: 60_000
    })).rejects.toMatchObject({
      code: 'OLLAMA_STREAM_INCOMPLETE',
      isOllamaAttemptError: true,
      ollamaTerminalObserved: false
    });
  });

  test('terminal validators accept only exact completed Ollama payloads', () => {
    expect(hasTerminalOllamaResponse('{"response":"done","done":true}')).toBe(true);
    expect(hasTerminalOllamaResponse('{"response":"done","done":true}\n')).toBe(true);
    expect(hasTerminalOllamaResponse('{"response":"done","done":true} trailing')).toBe(false);
    expect(hasTerminalOllamaResponse('{"error":"failed","done":true}')).toBe(false);
    expect(hasTerminalOllamaFrame('{"response":"partial","done":false}\n{"response":"done","done":true}\n')).toBe(true);
    expect(hasTerminalOllamaFrame('{"response":"done","done":true}\n{"response":"late","done":false}\n')).toBe(false);
  });
});
