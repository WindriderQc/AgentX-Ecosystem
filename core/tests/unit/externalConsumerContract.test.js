'use strict';

const {
  normalizeInferenceRequest,
  sanitizeRoutingSnapshot,
} = require('../../src/services/externalConsumerContract');

describe('external consumer contract', () => {
  test('forces bounded external attribution and never forwards placement or persistence controls', () => {
    const normalized = normalizeInferenceRequest({
      consumer: 'example-app',
      mode: 'chat',
      taskType: 'general_chat',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      persist: false,
      think: true,
      options: { temperature: 0.4, num_predict: 600, stop: ['END'] },
      callerDetail: 'benchmark/profiler',
      host: 'http://private-host:11434',
    });

    expect(normalized.runtimeRequest).toEqual({
      mode: 'chat',
      taskType: 'general_chat',
      options: { temperature: 0.4, num_predict: 600, stop: ['END'] },
      stream: true,
      callerDetail: 'external/example-app',
      think: true,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(normalized.runtimeRequest).not.toHaveProperty('host');
    expect(normalized.runtimeRequest).not.toHaveProperty('persist');
  });

  test('rejects context, placement, and unknown runtime options', () => {
    const request = (options) => ({
      consumer: 'example-app',
      mode: 'generate',
      taskType: 'general_chat',
      prompt: 'hello',
      options,
    });
    expect(() => normalizeInferenceRequest(request({ num_ctx: 131072 })))
      .toThrow(expect.objectContaining({ code: 'INFERENCE_OPTION_UNSUPPORTED' }));
    expect(() => normalizeInferenceRequest(request({ num_gpu: 99 })))
      .toThrow(expect.objectContaining({ code: 'INFERENCE_OPTION_UNSUPPORTED' }));
    expect(() => normalizeInferenceRequest(request({ temperature: 99 })))
      .toThrow(expect.objectContaining({ code: 'INFERENCE_OPTION_INVALID' }));
  });

  test('accepts only boolean thinking control', () => {
    const request = {
      consumer: 'example-app',
      mode: 'generate',
      taskType: 'general_chat',
      prompt: 'hello',
    };
    expect(normalizeInferenceRequest({ ...request, think: false }).runtimeRequest.think).toBe(false);
    expect(() => normalizeInferenceRequest({ ...request, think: 'low' }))
      .toThrow(expect.objectContaining({ code: 'INFERENCE_THINK_INVALID' }));
  });

  test('rejects route identifiers and stream values that are unsafe at the HTTP boundary', () => {
    const request = {
      consumer: 'example-app',
      mode: 'generate',
      taskType: 'general_chat',
      prompt: 'hello',
    };
    expect(() => normalizeInferenceRequest({ ...request, taskType: 'General Chat' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_TASK_TYPE' }));
    expect(() => normalizeInferenceRequest({ ...request, model: 'bad\r\nheader' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_MODEL' }));
    expect(() => normalizeInferenceRequest({ ...request, stream: 'true' }))
      .toThrow(expect.objectContaining({ code: 'INFERENCE_STREAM_INVALID' }));
  });

  test('rejects requests that ask Core to persist application conversations', () => {
    expect(() => normalizeInferenceRequest({
      consumer: 'example-app',
      mode: 'generate',
      model: 'exact:model',
      prompt: 'hello',
      persist: true,
    })).toThrow(expect.objectContaining({ code: 'PERSISTENCE_NOT_SUPPORTED' }));
  });

  test('publishes routing evidence without host URLs, mutable defaults, or raw warnings', () => {
    const publicSnapshot = sanitizeRoutingSnapshot({
      generatedAt: '2026-08-19T00:00:00.000Z',
      hosts: { primary: 'http://private-host:11434' },
      authority: { deploymentDefaults: 'private' },
      warnings: ['Failed to reach http://private-host:11434'],
      tasks: {
        general_chat: {
          model: 'exact:model',
          hostKey: 'primary',
          hostUrl: 'http://private-host:11434',
          hostPreference: {
            hostUrl: 'http://private-host:11434',
            status: 'available',
            benchmarkClaimed: false,
          },
          inferenceContract: {
            contextBudget: { windowTokens: 32768, source: 'profile' },
            qualification: { state: 'qualified', qualified: true },
          },
        },
        unavailable_task: {
          model: 'configured-but-unreachable:model',
          hostKey: 'secondary',
          hostUrl: null,
        },
      },
    });

    expect(publicSnapshot.tasks.general_chat).toMatchObject({
      model: 'exact:model',
      hostKey: 'primary',
      available: true,
      context: { windowTokens: 32768, source: 'profile' },
    });
    expect(publicSnapshot.tasks.unavailable_task.available).toBe(false);
    expect(JSON.stringify(publicSnapshot)).not.toContain('http://');
    expect(publicSnapshot).not.toHaveProperty('hosts');
    expect(publicSnapshot).not.toHaveProperty('authority');
  });
});
