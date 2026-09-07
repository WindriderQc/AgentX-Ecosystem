'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/api.js'), 'utf8');

function loadApi(fetchImpl) {
  const context = { window: {}, fetch: fetchImpl };
  vm.runInNewContext(source, context);
  return context.window.RAG;
}

describe('RAG browser API error envelopes', () => {
  test('a non-JSON service failure keeps its status and a readable retry message', async () => {
    const api = loadApi(async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
    await expect(api.search('question')).rejects.toMatchObject({ message: 'Request failed (502). Try again.', status: 502 });
  });

  test.each([null, [], 'unavailable'])('rejects an unusable JSON response: %p', async body => {
    const api = loadApi(async () => ({ ok: true, status: 200, json: async () => body }));
    await expect(api.search('question')).rejects.toThrow('The service returned an unreadable response. Try again.');
  });

  test('throws the Core proxy message on a non-2xx response', async () => {
    const api = loadApi(jest.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ status: 'error', message: 'Embedding route unavailable', code: 'RAG_PROXY_ERROR' })
    })));

    await expect(api.search('question')).rejects.toMatchObject({
      message: 'Embedding route unavailable',
      status: 503,
      code: 'RAG_PROXY_ERROR'
    });
  });

  test('throws the standalone error envelope even when HTTP is 200', async () => {
    const api = loadApi(jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: 'Vector query failed' })
    })));

    await expect(api.search('question')).rejects.toThrow('Vector query failed');
  });
});
