'use strict';

const {
  CONFIRMATION_CODE,
  CONFIRMATION_HEADER,
  buildTypedConfirmation,
  requireTypedConfirmation
} = require('../../src/helpers/typedConfirmation');

function responseHarness() {
  const body = { statusCode: null, payload: null };
  return {
    body,
    response: {
      status(code) {
        body.statusCode = code;
        return this;
      },
      json(payload) {
        body.payload = payload;
        return this;
      }
    }
  };
}

describe('typed destructive-action confirmation', () => {
  test('builds a stable phrase and normalizes unsafe whitespace', () => {
    expect(buildTypedConfirmation('DELETE  MODEL', '  llama\n3:8b  '))
      .toBe('DELETE MODEL llama 3:8b');
    expect(() => buildTypedConfirmation('', null, '   ')).toThrow(TypeError);
  });

  test.each([undefined, '', 'DELETE MODEL', 'delete model llama3:8b'])(
    'rejects an absent or inexact value before the caller mutates (%p)',
    (supplied) => {
      const { body, response } = responseHarness();
      const req = { get: jest.fn(() => supplied) };

      expect(requireTypedConfirmation(req, response, 'DELETE MODEL', 'llama3:8b')).toBe(false);
      expect(body.statusCode).toBe(400);
      expect(body.payload).toEqual({
        status: 'error',
        code: CONFIRMATION_CODE,
        message: 'Type DELETE MODEL llama3:8b exactly to confirm this destructive operation.',
        confirmation: {
          header: CONFIRMATION_HEADER,
          expected: 'DELETE MODEL llama3:8b'
        }
      });
    }
  );

  test('admits only the exact resource-bound phrase', () => {
    const { body, response } = responseHarness();
    const req = { get: jest.fn(() => 'DELETE MODEL llama3:8b') };

    expect(requireTypedConfirmation(req, response, 'DELETE MODEL', 'llama3:8b')).toBe(true);
    expect(body.statusCode).toBeNull();
    expect(body.payload).toBeNull();
  });
});
