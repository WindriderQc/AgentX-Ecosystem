const { PassThrough } = require('stream');

const {
  TrustedRuntimeServiceError,
  buildEffectiveRoutingSnapshot,
  executeRoutedInference
} = require('../../src/extensions/trustedRuntimeServices');

function response({ ok = true, status = 200, body = {}, raw = null, stream = null } = {}) {
  return {
    ok,
    status,
    headers: new Map(),
    body: stream,
    text: jest.fn(async () => raw == null ? JSON.stringify(body) : raw)
  };
}

function inferenceDeps(overrides = {}) {
  return {
    beginInferenceAdmission: jest.fn(async ({ signal } = {}) => ({
      signal: signal || new AbortController().signal,
      markDispatched: jest.fn(),
      assertActive: jest.fn(),
      complete: jest.fn(async () => ({ released: true })),
      abandon: jest.fn(async () => ({ released: true }))
    })),
    getAdvisoryModelForTask: jest.fn(),
    getTargetForModel: jest.fn(() => 'http://ollama.test:11434'),
    resolveHostKey: jest.fn(() => 'primary'),
    assertHostAvailableForConsumer: jest.fn(async () => null),
    validateHostUrl: jest.fn((host) => ({ valid: true, host })),
    hostPreferenceService: {
      getByHost: jest.fn(async () => ({
        pinnedModels: [{ model: 'model-a', contextSize: 32768, keepAlive: -1 }]
      })),
      prepareExclusiveModel: jest.fn(async () => ({ status: 'ready', unloaded: [] }))
    },
    modelsMatch: (left, right) => left === right,
    resolveInferenceContract: jest.fn(async () => ({
      version: 1,
      contextBudget: { windowTokens: 32768 }
    })),
    applyContractOutputLimit: jest.fn(),
    hostGate: {
      acquire: jest.fn(async () => jest.fn()),
      acquireExclusive: jest.fn(async () => jest.fn())
    },
    recordInference: jest.fn(async () => null),
    fetch: jest.fn(async () => response({ body: { model: 'model-a', response: 'ok', done: true } })),
    ...overrides
  };
}

describe('trusted runtime services', () => {
  test('executes a non-streaming request through Core routing and resident pin policy', async () => {
    const release = jest.fn();
    const deps = inferenceDeps({
      hostGate: { acquire: jest.fn(async () => release) }
    });

    const result = await executeRoutedInference(deps, {
      mode: 'generate',
      model: 'model-a',
      prompt: 'hello',
      keepAlive: 0,
      callerDetail: 'extension-test'
    });

    expect(deps.getTargetForModel).toHaveBeenCalledWith('model-a');
    expect(deps.assertHostAvailableForConsumer).toHaveBeenCalledWith(
      'http://ollama.test:11434',
      expect.objectContaining({ model: 'model-a' })
    );
    expect(deps.fetch).toHaveBeenCalledWith(
      'http://ollama.test:11434/api/generate',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringMatching(/"num_ctx":32768.*"keep_alive":-1/)
      })
    );
    expect(result.body.response).toBe('ok');
    expect(result.metadata).toMatchObject({
      model: 'model-a',
      hostKey: 'primary',
      numCtxSource: 'host_preference_pin'
    });
    expect(Object.isFrozen(result.metadata)).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(deps.recordInference).toHaveBeenCalledWith(expect.objectContaining({ caller: 'proxy' }));
  });

  test.each([
    [
      'a contradictory embed success and error',
      response({ body: { embeddings: [[1]], error: 'failed' } }),
      'embed',
      'OLLAMA_EMBED_RESPONSE_INVALID'
    ],
    [
      'a non-Ollama HTTP rejection',
      response({ ok: false, status: 500, raw: 'proxy failure' }),
      'generate',
      'OLLAMA_REJECTION_UNVERIFIED'
    ]
  ])('quarantines admission after %s', async (_label, upstream, mode, causeCode) => {
    const lifecycle = [];
    const complete = jest.fn(async () => lifecycle.push('complete'));
    const abandon = jest.fn(async () => lifecycle.push('abandon'));
    const deps = inferenceDeps({
      beginInferenceAdmission: jest.fn(async () => ({
        signal: new AbortController().signal,
        markDispatched: jest.fn(() => lifecycle.push('dispatched')),
        assertActive: jest.fn(),
        complete,
        abandon
      })),
      fetch: jest.fn(async () => upstream)
    });
    const request = mode === 'embed'
      ? { mode, model: 'model-a', input: 'hello' }
      : { mode, model: 'model-a', prompt: 'hello' };

    await expect(executeRoutedInference(deps, request)).rejects.toMatchObject({
      code: 'INFERENCE_UPSTREAM_UNAVAILABLE',
      cause: { code: causeCode }
    });
    expect(lifecycle).toEqual(['dispatched', 'abandon']);
    expect(complete).not.toHaveBeenCalled();
    expect(abandon).toHaveBeenCalledWith(expect.objectContaining({ code: causeCode }));
  });

  test('releases admission after an exact Ollama HTTP rejection', async () => {
    const lifecycle = [];
    const complete = jest.fn(async () => lifecycle.push('complete'));
    const abandon = jest.fn(async () => lifecycle.push('abandon'));
    const deps = inferenceDeps({
      beginInferenceAdmission: jest.fn(async () => ({
        signal: new AbortController().signal,
        markDispatched: jest.fn(() => lifecycle.push('dispatched')),
        assertActive: jest.fn(),
        complete,
        abandon
      })),
      fetch: jest.fn(async () => response({
        ok: false,
        status: 404,
        body: { error: 'model not found' }
      }))
    });

    const result = await executeRoutedInference(deps, {
      mode: 'generate', model: 'model-a', prompt: 'hello'
    });

    expect(result).toMatchObject({ ok: false, status: 404, body: { error: 'model not found' } });
    expect(lifecycle).toEqual(['dispatched', 'complete']);
    expect(abandon).not.toHaveBeenCalled();
  });

  test('relays a stream and aborts it when the caller disconnects', async () => {
    const upstream = new PassThrough();
    const release = jest.fn();
    const deps = inferenceDeps({
      hostGate: { acquire: jest.fn(async () => release) },
      fetch: jest.fn(async () => response({ stream: upstream }))
    });
    const controller = new AbortController();
    const result = await executeRoutedInference(deps, {
      mode: 'chat',
      model: 'model-a',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true
    }, { signal: controller.signal });
    const errors = [];
    result.stream.on('error', (error) => errors.push(error));

    controller.abort(new Error('client disconnected'));
    await new Promise((resolve) => result.stream.once('close', resolve));

    expect(result.stream.destroyed).toBe(true);
    expect(errors).toHaveLength(1);
    expect(deps.recordInference).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error', error: 'cancelled'
    }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('attests a trusted consumer contract and validates its internal host override', async () => {
    const deps = inferenceDeps();

    await executeRoutedInference(deps, {
      mode: 'chat',
      model: 'model-a',
      taskType: 'buddy_chat',
      messages: [{ role: 'user', content: 'hello' }],
      callerDetail: 'nestor/voix-native/chat',
    }, {
      consumerContract: 'nestor-v1',
      hostUrl: 'http://allowed.test:11434',
    });

    expect(deps.validateHostUrl).toHaveBeenCalledWith('http://allowed.test:11434');
    expect(deps.fetch).toHaveBeenCalledWith(
      'http://allowed.test:11434/api/chat',
      expect.any(Object)
    );
    expect(deps.recordInference).toHaveBeenCalledWith(expect.objectContaining({
      consumerContract: 'nestor-v1',
      callerDetail: 'nestor/voix-native/chat',
      routingTrace: { selected: { routingSource: 'trusted_host_override' } },
    }));
  });

  test('takes exclusive host admission and releases an idle resident model before inference', async () => {
    const events = [];
    const release = jest.fn(() => events.push('release'));
    const deps = inferenceDeps({
      hostGate: {
        acquire: jest.fn(async () => jest.fn()),
        acquireExclusive: jest.fn(async () => {
          events.push('exclusive-acquired');
          return release;
        })
      },
      hostPreferenceService: {
        getByHost: jest.fn(async () => ({ pinnedModels: [] })),
        prepareExclusiveModel: jest.fn(async () => {
          events.push('resident-released');
          return { status: 'ready', unloaded: ['normal-model'] };
        })
      },
      fetch: jest.fn(async () => {
        events.push('inference');
        return response({ body: { model: 'open-model', response: 'ok', done: true } });
      })
    });

    const result = await executeRoutedInference(deps, {
      mode: 'generate', model: 'open-model', prompt: 'hello', exclusiveHost: true
    });

    expect(result.ok).toBe(true);
    expect(deps.hostGate.acquire).not.toHaveBeenCalled();
    expect(deps.hostGate.acquireExclusive).toHaveBeenCalledWith(
      'http://ollama.test:11434', 'open-model', { signal: expect.any(AbortSignal) }
    );
    expect(deps.hostPreferenceService.prepareExclusiveModel).toHaveBeenCalledWith(
      'http://ollama.test:11434', 'open-model', {
        signal: expect.any(AbortSignal),
        assertAuthorityActive: expect.any(Function)
      }
    );
    expect(events).toEqual(['exclusive-acquired', 'resident-released', 'inference', 'release']);
  });

  test('quarantines an exclusive handoff when authority is lost before a late unload settles', async () => {
    const controller = new AbortController();
    const lifecycle = [];
    let dispatched = false;
    const abandon = jest.fn(async () => {
      lifecycle.push('abandon');
      return { quarantined: dispatched };
    });
    const markDispatched = jest.fn(() => {
      dispatched = true;
      lifecycle.push('dispatched');
    });
    const assertActive = jest.fn(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
    });
    let releaseLateUnload;
    const deps = inferenceDeps({
      beginInferenceAdmission: jest.fn(async () => ({
        signal: controller.signal,
        markDispatched,
        assertActive,
        complete: jest.fn(async () => ({ released: true })),
        abandon
      })),
      hostPreferenceService: {
        getByHost: jest.fn(async () => ({ pinnedModels: [] })),
        prepareExclusiveModel: jest.fn(async (_host, _model, options) => {
          expect(dispatched).toBe(true);
          expect(options.signal).toBe(controller.signal);
          options.assertAuthorityActive();
          await new Promise(resolve => { releaseLateUnload = resolve; });
          options.assertAuthorityActive();
          return { status: 'ready', unloaded: ['normal-model'] };
        })
      }
    });

    const pending = executeRoutedInference(deps, {
      mode: 'generate', model: 'open-model', prompt: 'hello', exclusiveHost: true
    });
    await new Promise(resolve => setImmediate(resolve));
    const lost = Object.assign(new Error('inference admission heartbeat was lost'), {
      code: 'RUNTIME_INFERENCE_ADMISSION_LOST'
    });
    controller.abort(lost);
    releaseLateUnload();

    await expect(pending).rejects.toMatchObject({ code: 'INFERENCE_UPSTREAM_UNAVAILABLE' });
    expect(lifecycle).toEqual(['dispatched', 'abandon']);
    expect(abandon).toHaveBeenCalledWith(lost);
    expect(await abandon.mock.results[0].value).toEqual({ quarantined: true });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  test('records only validated server-side work attribution', async () => {
    const deps = inferenceDeps();

    const result = await executeRoutedInference(deps, {
      mode: 'chat',
      model: 'model-a',
      messages: [{ role: 'user', content: 'hello' }],
      callerDetail: 'openclaw-runtime-bridge',
    }, {
      consumerContract: 'openclaw-pipeline-runtime-v1',
      attribution: {
        workItemId: '0401',
        correlationId: 'lease:7f8e9d',
        runtime: 'external',
        attempt: 2,
      },
    });

    expect(deps.recordInference).toHaveBeenCalledWith(expect.objectContaining({
      consumerContract: 'openclaw-pipeline-runtime-v1',
      workItemId: '0401',
      correlationId: 'lease:7f8e9d',
      runtime: 'external',
      attempt: 2,
    }));
    expect(result.metadata).not.toHaveProperty('attribution');
  });

  test.each([
    ['non-object', 'pipeline:0401'],
    ['unknown field', { workItemId: 'pipeline:0401', runtime: 'external', prompt: 'private' }],
    ['missing identifiers', { runtime: 'external' }],
    ['invalid identifier', { workItemId: 'pipeline 0401', runtime: 'external' }],
    ['invalid runtime', { workItemId: 'pipeline:0401', runtime: 'openclaw' }],
    ['invalid attempt', { workItemId: 'pipeline:0401', runtime: 'external', attempt: 0 }],
  ])('rejects invalid server attribution: %s', async (_label, attribution) => {
    const deps = inferenceDeps();

    await expect(executeRoutedInference(deps, {
      mode: 'generate', model: 'model-a', prompt: 'hello'
    }, {
      consumerContract: 'openclaw-pipeline-runtime-v1',
      attribution,
    })).rejects.toMatchObject({ code: 'INFERENCE_ATTRIBUTION_INVALID', statusCode: 400 });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  test('requires server-attested consumer identity for work attribution', async () => {
    const deps = inferenceDeps();

    await expect(executeRoutedInference(deps, {
      mode: 'generate', model: 'model-a', prompt: 'hello'
    }, {
      attribution: { workItemId: 'pipeline:0401', runtime: 'external' },
    })).rejects.toMatchObject({
      code: 'INFERENCE_ATTRIBUTION_CONTRACT_REQUIRED', statusCode: 400
    });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  test('relays streaming bytes unchanged and records split final usage metadata', async () => {
    const upstream = new PassThrough();
    const deps = inferenceDeps({
      fetch: jest.fn(async () => response({ stream: upstream }))
    });
    const result = await executeRoutedInference(deps, {
      mode: 'chat',
      model: 'model-a',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true
    }, {
      consumerContract: 'openclaw-pipeline-runtime-v1',
      attribution: { workItemId: '0401', runtime: 'external' },
    });
    const expected = [
      `${JSON.stringify({ message: { content: 'hé' }, done: false })}\n`,
      '{"message":{"content":"llo"},"done":true,"prompt_eval_',
      'count":10,"eval_count":4}\n'
    ];

    const received = [];
    result.stream.on('data', (chunk) => received.push(chunk));
    const ended = new Promise((resolve, reject) => {
      result.stream.once('end', resolve);
      result.stream.once('error', reject);
    });
    for (const chunk of expected) upstream.write(chunk);
    upstream.end();
    await ended;
    await new Promise((resolve) => setImmediate(resolve));

    expect(Buffer.concat(received).toString('utf8')).toBe(expected.join(''));
    expect(deps.recordInference).toHaveBeenCalledWith(expect.objectContaining({
      status: 'success', tokensIn: 10, tokensOut: 4,
      consumerContract: 'openclaw-pipeline-runtime-v1',
      workItemId: '0401', runtime: 'external', attempt: 1,
    }));
  });

  test('rejects and quarantines a stream that sends bytes after done:true', async () => {
    const upstream = new PassThrough();
    const abandon = jest.fn(async () => ({ quarantined: true }));
    const complete = jest.fn(async () => ({ released: true }));
    const deps = inferenceDeps({
      beginInferenceAdmission: jest.fn(async () => ({
        signal: new AbortController().signal,
        markDispatched: jest.fn(),
        assertActive: jest.fn(),
        complete,
        abandon
      })),
      fetch: jest.fn(async () => response({ stream: upstream }))
    });
    const result = await executeRoutedInference(deps, {
      mode: 'chat', model: 'model-a', messages: [{ role: 'user', content: 'hello' }], stream: true
    });
    const streamError = new Promise(resolve => result.stream.once('error', resolve));

    upstream.end(`${JSON.stringify({ done: true })}\n${JSON.stringify({ message: { content: 'late' } })}\n`);
    await expect(streamError).resolves.toMatchObject({ code: 'OLLAMA_STREAM_INCOMPLETE' });
    await new Promise(resolve => setImmediate(resolve));

    expect(complete).not.toHaveBeenCalled();
    expect(abandon).toHaveBeenCalled();
    expect(deps.recordInference).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      error: expect.stringMatching(/terminal/i)
    }));
  });

  test('quarantines when downstream closes after done:true but before upstream EOF', async () => {
    const upstream = new PassThrough();
    const abandon = jest.fn(async () => ({ quarantined: true }));
    const complete = jest.fn(async () => ({ released: true }));
    const deps = inferenceDeps({
      beginInferenceAdmission: jest.fn(async () => ({
        signal: new AbortController().signal,
        markDispatched: jest.fn(),
        assertActive: jest.fn(),
        complete,
        abandon
      })),
      fetch: jest.fn(async () => response({ stream: upstream }))
    });
    const result = await executeRoutedInference(deps, {
      mode: 'chat', model: 'model-a', messages: [{ role: 'user', content: 'hello' }], stream: true
    });
    result.stream.resume();
    const firstChunk = new Promise(resolve => result.stream.once('data', resolve));

    upstream.write(`${JSON.stringify({ done: true })}\n`);
    await firstChunk;
    result.stream.destroy();
    await new Promise(resolve => result.stream.once('close', resolve));
    upstream.end(`${JSON.stringify({ message: { content: 'late' } })}\n`);
    await new Promise(resolve => setImmediate(resolve));

    expect(complete).not.toHaveBeenCalled();
    expect(abandon).toHaveBeenCalledWith(expect.any(Error));
    expect(deps.recordInference).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      error: expect.stringMatching(/terminal|closed|cancelled/i)
    }));
  });

  test('returns a bounded timeout error and releases admission', async () => {
    const release = jest.fn();
    const deps = inferenceDeps({
      hostGate: { acquire: jest.fn(async () => release) },
      fetch: jest.fn((_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }))
    });

    await expect(executeRoutedInference(deps, {
      mode: 'generate', model: 'model-a', prompt: 'hello', timeoutMs: 1
    })).rejects.toMatchObject({
      code: 'INFERENCE_TIMEOUT',
      statusCode: 504
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('builds an immutable effective routing snapshot without mutable database documents', async () => {
    const query = {
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn(async () => [{ modelName: 'model-a', sourceHost: 'http://ollama.test:11434' }])
    };
    const snapshot = await buildEffectiveRoutingSnapshot({
      buildRouterConfigPayload: jest.fn(async () => ({
        authority: { operational: 'router' },
        hosts: { primary: 'http://ollama.test:11434' },
        taskModels: { general_chat: { model: 'model-a', host: 'primary' } }
      })),
      hostPreferenceService: {
        getAll: jest.fn(async () => [{
          hostUrl: 'http://ollama.test:11434',
          pinnedModels: [{ model: 'model-a', contextSize: 32768 }]
        }]),
        getPinnedEntries: (pref) => pref.pinnedModels
      },
      getContextInfo: jest.fn(async () => ({ num_ctx: 32768, source: 'host_preference_pin' })),
      resolveInferenceContract: jest.fn(async () => ({ version: 1 })),
      modelsMatch: (left, right) => left === right,
      ModelRegistry: { find: jest.fn(() => query) }
    });

    expect(snapshot.tasks.general_chat).toMatchObject({
      model: 'model-a',
      hostKey: 'primary',
      contextSize: 32768,
      contextSource: 'host_preference_pin'
    });
    expect(snapshot.catalog).toEqual([expect.objectContaining({ model: 'model-a' })]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tasks.general_chat)).toBe(true);
    expect(() => Object.defineProperty(snapshot.tasks.general_chat, 'model', { value: 'changed' })).toThrow();
  });

  test('resolves exact artifact identity only when a trusted consumer explicitly requests it', async () => {
    const resolveInferenceContract = jest.fn(async () => ({
      version: 'agentx.inference-contract.v1',
      qualification: { qualified: true, exactArtifact: true }
    }));
    const deps = {
      buildRouterConfigPayload: jest.fn(async () => ({
        authority: { operational: 'router' },
        hosts: { primary: 'http://ollama.test:11434' },
        taskModels: { code_generation: { model: 'model-a', host: 'primary' } }
      })),
      hostPreferenceService: {
        getAll: jest.fn(async () => []),
        getPinnedEntries: () => []
      },
      getContextInfo: jest.fn(async () => null),
      resolveInferenceContract,
      modelsMatch: (left, right) => left === right,
      ModelRegistry: { find: jest.fn() }
    };

    await buildEffectiveRoutingSnapshot(deps, { includeCatalog: false });
    expect(resolveInferenceContract.mock.calls[0]).toEqual([
      { model: 'model-a', host: 'http://ollama.test:11434' }
    ]);

    await buildEffectiveRoutingSnapshot(deps, {
      includeCatalog: false,
      includeArtifactIdentity: true
    });
    expect(resolveInferenceContract.mock.calls[1]).toEqual([
      { model: 'model-a', host: 'http://ollama.test:11434' },
      { includeArtifactIdentity: true }
    ]);
  });

  test('rejects invalid requests before routing', async () => {
    await expect(executeRoutedInference(inferenceDeps(), {
      mode: 'chat', model: 'model-a', messages: 'not-an-array'
    })).rejects.toBeInstanceOf(TrustedRuntimeServiceError);
    await expect(executeRoutedInference(inferenceDeps(), {
      mode: 'generate', model: 'model-a', prompt: 'hello', options: { num_gpu: 99 }
    })).rejects.toMatchObject({ code: 'INFERENCE_OPTION_UNSUPPORTED', statusCode: 400 });
    await expect(executeRoutedInference(inferenceDeps(), {
      mode: 'generate', model: 'model-a', prompt: 'hello'
    }, { consumerContract: 'NOT VALID' })).rejects.toMatchObject({
      code: 'INFERENCE_CONSUMER_CONTRACT_INVALID', statusCode: 400
    });
  });
});
