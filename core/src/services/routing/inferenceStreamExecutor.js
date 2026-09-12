'use strict';

const fetch = require('node-fetch');
const { StringDecoder } = require('string_decoder');
const { Transform, Readable } = require('stream');
const {
  beginAdmittedOllamaAttempt, createAttemptAbortBridge,
  createOllamaStreamTerminalValidator, readOllamaResponse,
  requestNotSent,
} = require('./inferenceAttemptExecutor');

const MAX_STREAM_TELEMETRY_LINE_CHARS = 65_536;

function releaseOnce(release) {
  let released = false;
  return (...args) => {
    if (released) return;
    released = true;
    release?.(...args);
  };
}

function createStreamingTelemetryObserver() {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let discardingOversizedLine = false;
  let tokensIn = 0;
  let tokensOut = 0;
  const terminalValidator = createOllamaStreamTerminalValidator();

  const observeLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line) return;

    const observed = terminalValidator.observe(line);
    if (!observed.accepted) return;
    const data = observed.data;
    const observedTokensIn = Number(data?.prompt_eval_count ?? data?.usage?.prompt_tokens);
    const observedTokensOut = Number(data?.eval_count ?? data?.usage?.completion_tokens);
    if (Number.isFinite(observedTokensIn) && observedTokensIn >= 0) tokensIn = observedTokensIn;
    if (Number.isFinite(observedTokensOut) && observedTokensOut >= 0) tokensOut = observedTokensOut;
  };

  const consume = (text, final = false) => {
    let cursor = 0;
    while (cursor < text.length) {
      const newline = text.indexOf('\n', cursor);
      const end = newline === -1 ? text.length : newline;
      const segment = text.slice(cursor, end);

      if (!discardingOversizedLine) {
        if (pending.length + segment.length <= MAX_STREAM_TELEMETRY_LINE_CHARS) {
          pending += segment;
        } else {
          pending = '';
          discardingOversizedLine = true;
          terminalValidator.observe('{}');
        }
      }

      if (newline === -1) break;
      if (!discardingOversizedLine) observeLine(pending);
      pending = '';
      discardingOversizedLine = false;
      cursor = newline + 1;
    }

    if (final) {
      if (!discardingOversizedLine) observeLine(pending);
      pending = '';
      discardingOversizedLine = false;
    }
  };

  return {
    write(chunk, encoding) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      consume(decoder.write(buffer));
    },
    end() {
      consume(decoder.end(), true);
    },
    snapshot() {
      const terminal = terminalValidator.snapshot();
      return {
        prompt_eval_count: tokensIn,
        eval_count: tokensOut,
        terminalObserved: terminal.terminalObserved,
        terminalComplete: terminal.complete,
        terminalInvalid: terminal.invalid
      };
    }
  };
}

function attachStreamLifecycle(stream, { abortBridge, release, inferenceAdmission }) {
  let resolveCompletion;
  const completion = new Promise(resolve => { resolveCompletion = resolve; });
  const observer = createStreamingTelemetryObserver();
  let sourceEnded = false;
  let relayFinished = false;
  const relay = new Transform({
    transform(chunk, encoding, callback) {
      observer.write(chunk, encoding);
      callback(null, chunk);
    },
    flush(callback) {
      observer.end();
      const snapshot = observer.snapshot();
      if (snapshot.terminalComplete !== true) {
        const error = new Error('Ollama stream ended without a verified exact terminal record');
        error.code = 'OLLAMA_STREAM_INCOMPLETE';
        callback(error);
        return;
      }
      callback();
    }
  });
  const settle = releaseOnce((mode, error = null) => {
    abortBridge.cleanup();
    abortBridge.signal.removeEventListener('abort', cancel);
    const snapshot = observer.snapshot();
    const exactSourceTerminal = mode === 'complete'
      && sourceEnded === true
      && snapshot.terminalComplete === true
      && !abortBridge.signal.aborted;
    void Promise.resolve().then(() => {
      if (exactSourceTerminal) {
        inferenceAdmission.assertActive();
        return inferenceAdmission.complete();
      }
      return inferenceAdmission.abandon(error || new Error('Ollama stream closed before verified upstream EOF'));
    })
      .then(() => ({ ...snapshot, completed: exactSourceTerminal }))
      .catch(async settlementError => {
        await inferenceAdmission.abandon(settlementError).catch(() => {});
        return { ...snapshot, completed: false, admissionError: settlementError.message };
      })
      .then(async result => {
        try { await release(); }
        catch (error) { result = { ...result, completed: false, admissionError: error.message }; }
        resolveCompletion(result);
      });
  });
  stream.once('end', () => { sourceEnded = true; });
  stream.once('error', (error) => {
    relay.destroy(error);
    settle('abandon', error);
  });
  stream.once('close', () => {
    if (!stream.readableEnded && !relay.destroyed) relay.destroy();
    if (!stream.readableEnded) settle('abandon', new Error('Ollama upstream closed before EOF'));
  });
  // Transform.flush runs only after the upstream readable reaches EOF. The
  // writable-side finish event is therefore the sole success settlement.
  relay.once('finish', () => {
    relayFinished = true;
    settle('complete');
  });
  relay.once('close', () => {
    if (!stream.destroyed && !stream.readableEnded) stream.destroy();
    if (!relayFinished) {
      settle('abandon', new Error(sourceEnded
        ? 'Ollama relay closed after upstream EOF but before terminal settlement'
        : 'Ollama downstream closed before upstream EOF'));
    }
  });
  relay.once('error', error => settle('abandon', error));
  const cancel = () => {
    const error = new Error(abortBridge.signal.reason?.message || 'Inference request cancelled');
    error.name = 'AbortError';
    error.isOllamaTimeout = abortBridge.getAbortSource() === 'timeout';
    error.isCallerCancellation = abortBridge.getAbortSource() === 'caller';
    if (!stream.destroyed) stream.destroy(error);
    if (!relay.destroyed) relay.destroy(error);
    settle('abandon', error);
  };
  abortBridge.signal.addEventListener('abort', cancel, { once: true });
  stream.pipe(relay);
  return { stream: relay, completion };
}

/** Open one native stream; the shared relay owns exact EOF and settlement.
 * The caller chooses whether its signal aborts upstream or only stops delivery.
 * HTTP errors return a buffered result, with no retry or model substitution.
 */
async function executeAdmittedOllamaStream(options, dependencies = {}) {
  const fetchImpl = dependencies.fetch || fetch;
  const abortBridge = createAttemptAbortBridge({
    externalSignal: options.signal || new AbortController().signal, stream: false,
    timeoutMs: options.timeoutMs === undefined ? 600000 : options.timeoutMs,
  });
  let scope;
  let relaying = false;
  let receivedResponse = false;
  try {
    scope = await beginAdmittedOllamaAttempt({ ...options, stream: true, signal: abortBridge.signal }, dependencies);
    const endpoint = options.mode === 'embed' ? 'embed' : options.useChat ? 'chat' : 'generate';
    const response = await fetchImpl(`${options.hostUrl}/api/${endpoint}`, {
      ...options.fetchOptions,
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options.payload), signal: scope.signal,
    });
    receivedResponse = true;
    scope.admission.assertActive();
    if (abortBridge.signal.aborted) throw abortBridge.signal.reason;
    if (!response.ok || !response.body || options.mode === 'embed') {
      const result = await readOllamaResponse(response, {
        mode: options.mode, verifyRejection: options.verifyRejection,
      });
      scope.admission.assertActive();
      await scope.admission.complete();
      return result;
    }
    // Chat also accepts an async byte iterable (for embedded transports).
    const source = typeof response.body.pipe === 'function' ? response.body
      : Readable.from(response.body, { objectMode: false });
    const relay = attachStreamLifecycle(source, {
      abortBridge, release: scope.release, inferenceAdmission: scope.admission,
    });
    relaying = true;
    return { ok: true, status: response.status, response, ...relay };
  } catch (error) {
    error.ollamaRequestNotSent = Boolean(scope) && !receivedResponse && requestNotSent(error);
    if (scope) await (error.ollamaRequestNotSent ? scope.admission.complete() : scope.admission.abandon(error)).catch(quarantineError => {
      error.inferenceQuarantineError = quarantineError;
    });
    throw error;
  } finally {
    if (!relaying) {
      abortBridge.cleanup();
      await scope?.release();
    }
  }
}

module.exports = { executeAdmittedOllamaStream };
