'use strict';

const {
  addCanonicalEnvelope
} = require('../../src/middleware/responseEnvelopeCompatibility');
const envelope = require('../../src/helpers/responseEnvelope');

describe('responseEnvelopeCompatibility', () => {
  it('adds ok:true to legacy success envelopes without dropping legacy fields', () => {
    expect(addCanonicalEnvelope({ status: 'success', data: { value: 1 } })).toEqual({
      ok: true,
      status: 'success',
      data: { value: 1 }
    });
  });

  it('adds ok:false and error to legacy error envelopes', () => {
    expect(addCanonicalEnvelope({ status: 'error', message: 'Nope', code: 'NOPE' })).toEqual({
      ok: false,
      status: 'error',
      message: 'Nope',
      code: 'NOPE',
      error: 'Nope'
    });
  });

  it('leaves canonical and non-envelope payloads unchanged', () => {
    const canonical = { ok: true, data: { value: 1 } };
    const rawArray = [{ value: 1 }];

    expect(addCanonicalEnvelope(canonical)).toBe(canonical);
    expect(addCanonicalEnvelope(rawArray)).toBe(rawArray);
    expect(addCanonicalEnvelope({ generated_at: '2026-07-03T00:00:00Z' })).toEqual({
      generated_at: '2026-07-03T00:00:00Z'
    });
  });
});

describe('responseEnvelope helper', () => {
  function mockResponse() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
  }

  it('emits canonical success and preserves status for legacy clients', () => {
    const res = mockResponse();

    envelope.success(res, { value: 1 }, { durationMs: 12 }, 201);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      status: 'success',
      data: { value: 1 },
      meta: { durationMs: 12 }
    });
  });

  it('emits canonical error and preserves message for legacy clients', () => {
    const res = mockResponse();

    envelope.error(res, 400, 'Bad input', 'BAD_INPUT');

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      status: 'error',
      error: 'Bad input',
      message: 'Bad input',
      code: 'BAD_INPUT'
    });
  });
});
