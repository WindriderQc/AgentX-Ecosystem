'use strict';

jest.mock('../../models/ChatImage', () => ({ find: jest.fn() }));
jest.mock('node-fetch');
const ChatImage = require('../../models/ChatImage');
const fetch = require('node-fetch');
const { decodeImage, normalizeImageIds, buildVisualMessages } = require('../../src/services/chat/chatImages');
const id = '1234567890abcdef12345678';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkWQAAAAASUVORK5CYII=';

beforeEach(() => {
  jest.clearAllMocks();
  ChatImage.find.mockResolvedValue([{ _id: id, data: Buffer.from(png, 'base64') }]);
  fetch.mockResolvedValue({ ok: true, json: async () => ({ capabilities: ['completion', 'vision'] }) });
});

test('decodes a PNG and rejects non-image content, invalid base64 and oversized input', () => {
  expect(decodeImage(`data:image/png;base64,${png}`)).toEqual({ mimeType: 'image/png', data: Buffer.from(png, 'base64') });
  for (const value of [null, 'https://example.org/image.png', 'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/png;base64,dGV4dA==', `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`]) {
    expect(() => decodeImage(value)).toThrow();
  }
});

test('accepts one image reference and rejects malformed or multiple references', () => {
  expect(normalizeImageIds(undefined)).toEqual([]);
  expect(normalizeImageIds([id.toUpperCase()])).toEqual([id]);
  for (const ids of [null, id, ['../image'], [id, id]]) expect(() => normalizeImageIds(ids)).toThrow();
});

const input = { messages: [], message: 'Explain this', system: 'Be helpful', userId: 'default', host: 'http://localhost:11434', model: 'vision-model' };

test('text-only chat has no image lookup or capability probe', async () => {
  expect(await buildVisualMessages(input)).toEqual([
    { role: 'system', content: 'Be helpful' }, { role: 'user', content: 'Explain this' }
  ]);
  expect(ChatImage.find).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test('places image bytes on the exact current and historical user turns', async () => {
  const result = await buildVisualMessages({ ...input, imageIds: [id], messages: [
    { role: 'user', content: 'Earlier screenshot', imageIds: [id] },
    { role: 'assistant', content: 'Earlier answer' }
  ] });
  expect(result).toEqual([
    { role: 'system', content: 'Be helpful' },
    { role: 'user', content: 'Earlier screenshot', images: [png] },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'Explain this', images: [png] }
  ]);
  expect(ChatImage.find).toHaveBeenCalledWith({ _id: { $in: [id] }, userId: 'default' });
  expect(fetch).toHaveBeenCalledWith('http://localhost:11434/api/show', expect.objectContaining({ body: JSON.stringify({ model: 'vision-model' }) }));
});

test('does not silently discard an image for a text-only model', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ capabilities: ['completion'] }) });
  await expect(buildVisualMessages({ ...input, imageIds: [id] })).rejects.toMatchObject({ code: 'VISION_MODEL_REQUIRED' });
});

test('does not probe a model when the referenced image is missing', async () => {
  ChatImage.find.mockResolvedValue([]);
  await expect(buildVisualMessages({ ...input, imageIds: [id] })).rejects.toMatchObject({ code: 'CHAT_IMAGE_NOT_FOUND' });
  expect(fetch).not.toHaveBeenCalled();
});

test('reports an unavailable capability probe and rejects images on assistant messages', async () => {
  fetch.mockRejectedValue(new Error('offline'));
  await expect(buildVisualMessages({ ...input, imageIds: [id] })).rejects.toMatchObject({ code: 'VISION_CHECK_UNAVAILABLE' });
  await expect(buildVisualMessages({ ...input, messages: [{ role: 'assistant', content: 'x', imageIds: [id] }] })).rejects.toMatchObject({ code: 'CHAT_REQUEST_INVALID' });
});
