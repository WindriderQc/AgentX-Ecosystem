'use strict';

const fetch = require('node-fetch');
const hostGate = require('../../src/services/hostGate');

jest.mock('node-fetch');

const {
  executeAdmittedOllamaAttempt,
  executeOllamaAttempt,
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
        text: async () => JSON.stringify({ response: 'done' }),
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
    const acquireSpy = jest.spyOn(hostGate, 'acquire').mockImplementation(
      (_host, _model, options) => {
        admissionSignal = options.signal;
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

      expect(admissionSignal).toBe(caller.signal);
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
});
