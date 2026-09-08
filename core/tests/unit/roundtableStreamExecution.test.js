'use strict';

const { Readable } = require('stream');
const { EventEmitter } = require('events');
jest.mock('node-fetch', () => jest.fn());
jest.mock('../../models/Roundtable', () => ({}));
jest.mock('../../config/logger', () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/services/modelRouter', () => ({
  getTargetForModel: jest.fn(() => 'http://council.test:11434'), recordInference: jest.fn(),
}));
jest.mock('../../src/services/hostPreferenceService', () => {
  const pins = jest.requireActual('../../src/services/hostPinPrimitives');
  return { ...pins, getByHost: jest.fn(async () => ({ pinnedModels: [{ model: 'exact-tag', contextSize: 8192, keepAlive: -1 }] })) };
});
jest.mock('../../src/services/inferenceAdmissionService', () => ({ beginInferenceAdmission: jest.fn() }));
const fetch = require('node-fetch');
const { beginInferenceAdmission } = require('../../src/services/inferenceAdmissionService');
const { recordInference } = require('../../src/services/modelRouter');
const { callAgentStreaming } = require('../../src/services/roundtable/orchestrator');

test.each([false, true])('Council preserves streaming bytes, exact model, admission and one telemetry row (invalid: %s)', async invalid => {
  jest.clearAllMocks();
  const admission = { markDispatched: jest.fn(), assertActive: jest.fn(), complete: jest.fn(async () => {}), abandon: jest.fn(async () => {}) };
  beginInferenceAdmission.mockImplementation(async ({ signal }) => ({ ...admission, signal }));
  const bytes = Buffer.from('{"message":{"content":"été"},"done":false}\n{"done":true,"eval_count":2}\n' + (invalid ? 'garbage\n' : ''));
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  fetch.mockResolvedValue({ ok: true, status: 200, body: Readable.from([bytes.subarray(0, split), bytes.subarray(split)]) });
  const emitter = new EventEmitter();
  const tokens = [];
  emitter.on('chunk', chunk => tokens.push(chunk.content));
  const result = await callAgentStreaming({ agentId: 'critic', model: 'exact-tag', _round: 1 },
    [{ role: 'user', content: 'hello' }], 1000, emitter, 'turn', { roundtableId: 'canary', round: 1 });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ model: 'exact-tag', options: { num_ctx: 8192 }, keep_alive: -1 });
  expect(recordInference).toHaveBeenCalledTimes(1);
  if (invalid) {
    expect(result.error).toMatch(/terminal/);
    expect(admission.complete).not.toHaveBeenCalled();
    expect(admission.abandon).toHaveBeenCalledTimes(1);
    expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  } else {
    expect(result).toMatchObject({ response: 'été', error: null });
    expect(tokens).toEqual(['été']);
    expect(admission.complete).toHaveBeenCalledTimes(1);
    expect(admission.abandon).not.toHaveBeenCalled();
    expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
  }
});
