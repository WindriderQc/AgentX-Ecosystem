const { PassThrough } = require('stream');

const {
  TrustedRuntimeServiceError,
  buildEffectiveRoutingSnapshot,
  executeRoutedInference
} = require('../../src/extensions/trustedRuntimeServices');

function response({ ok = true, status = 200, body = {}, stream = null } = {}) {
  return {
    ok,
    status,
    headers: new Map(),
    body: stream,
    text: jest.fn(async () => JSON.stringify(body))
  };
}

function inferenceDeps(overrides = {}) {
  return {
    getAdvisoryModelForTask: jest.fn(),
    getTargetForModel: jest.fn(() => 'http://ollama.test:11434'),
    resolveHostKey: jest.fn(() => 'primary'),
    assertHostAvailableForConsumer: jest.fn(async () => null),
    validateHostUrl: jest.fn((host) => ({ valid: true, host })),
    hostPreferenceService: {
      getByHost: jest.fn(async () => ({
        pinnedModels: [{ model: 'model-a', contextSize: 32768, keepAlive: -1 }]
      }))
    },
    modelsMatch: (left, right) => left === right,
    resolveInferenceContract: jest.fn(async () => ({
      version: 1,
      contextBudget: { windowTokens: 32768 }
    })),
    applyContractOutputLimit: jest.fn(),
    hostGate: { acquire: jest.fn(async () => jest.fn()) },
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

    expect(Buffer.concat(received).toString('utf8')).toBe(expected.join(''));
    expect(deps.recordInference).toHaveBeenCalledWith(expect.objectContaining({
      status: 'success', tokensIn: 10, tokensOut: 4,
      consumerContract: 'openclaw-pipeline-runtime-v1',
      workItemId: '0401', runtime: 'external', attempt: 1,
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
