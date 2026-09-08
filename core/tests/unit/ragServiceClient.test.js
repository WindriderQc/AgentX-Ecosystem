'use strict';

jest.mock('node-fetch', () => jest.fn());
const fetch = require('node-fetch');
const { RagServiceClient } = require('../../src/services/ragServiceClient');

afterEach(() => { jest.useRealTimers(); jest.resetAllMocks(); });

test('typed metrics returns the owner data unchanged in one bounded request', async () => {
  const data = { totals: { documents: 351, chunks: 1053 }, bySource: [], lastIngest: null };
  fetch.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ ok: true, data }) });
  expect(await new RagServiceClient().getMetrics()).toEqual(data);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/rag\/metrics$/),
    expect.objectContaining({ method: 'GET', timeout: 5000 }));
});

test('typed metrics rejects a malformed success instead of synthesizing a corpus', async () => {
  fetch.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ ok: true, data: {} }) });
  await expect(new RagServiceClient().getMetrics()).rejects.toMatchObject({ status: 502 });
});

test('an unavailable metrics request aborts at its deadline without another upstream call', async () => {
  jest.useFakeTimers();
  fetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const outcome = new RagServiceClient().getMetrics().catch(error => error);
  await jest.advanceTimersByTimeAsync(5001);
  expect(await outcome).toMatchObject({ status: 504, code: 'RAG_SERVICE_ERROR_TIMEOUT' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
