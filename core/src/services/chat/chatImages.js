'use strict';

const ChatImage = require('../../../models/ChatImage');
const fetch = require('node-fetch');

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function imageError(message, statusCode = 400, code = 'CHAT_REQUEST_INVALID') {
  return Object.assign(new Error(message), { statusCode, code });
}

function normalizeImageIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1
      || value.some(id => typeof id !== 'string' || !/^[a-f0-9]{24}$/i.test(id))) {
    throw imageError('Attach one screenshot per message.');
  }
  return value.map(id => id.toLowerCase());
}

function decodeImage(dataUrl) {
  const match = typeof dataUrl === 'string'
    && /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    throw imageError('Use a PNG or JPEG image no larger than 2 MiB.');
  }
  const data = Buffer.from(match[2], 'base64');
  const validSignature = match[1] === 'png'
    ? data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (!validSignature || !data.length || data.length > MAX_IMAGE_BYTES
      || data.toString('base64') !== match[2]) {
    throw imageError('The screenshot is not a valid PNG or JPEG image.');
  }
  return { mimeType: `image/${match[1]}`, data };
}

async function loadImages(imageIds, userId) {
  const ids = [...new Set(imageIds)];
  if (!ids.length) return new Map();
  const images = await ChatImage.find({ _id: { $in: ids }, userId });
  const byId = new Map(images.map(image => [String(image._id), image]));
  if (ids.some(id => !byId.has(id))) {
    throw imageError('A screenshot is no longer available. Attach it again.', 400, 'CHAT_IMAGE_NOT_FOUND');
  }
  return byId;
}

async function buildVisualMessages({ messages, imageIds, message, system, userId, host, model }) {
  const currentIds = normalizeImageIds(imageIds);
  const history = messages.map(entry => {
    const ids = normalizeImageIds(entry.imageIds);
    if (ids.length && entry.role !== 'user') throw imageError('Only user messages can contain screenshots.');
    return { role: entry.role, content: entry.content, imageIds: ids };
  });
  const turns = [...history, { role: 'user', content: message.trim(), imageIds: currentIds }];
  const byId = await loadImages(turns.flatMap(turn => turn.imageIds), userId);
  if (byId.size) {
    // Ask the selected runtime about this exact model, without loading it or
    // silently replacing a visual request with text-only inference.
    let details;
    try {
      const response = await fetch(`${host}/api/show`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }), timeout: 10000
      });
      if (!response.ok) throw new Error('Model information unavailable');
      details = await response.json();
    } catch {
      throw imageError('Could not check image support for the selected model. Try again.', 503, 'VISION_CHECK_UNAVAILABLE');
    }
    if (!details.capabilities?.includes('vision')) {
      throw imageError('This conversation contains a screenshot. Choose a model with vision in Manual controls, then retry.', 400, 'VISION_MODEL_REQUIRED');
    }
  }
  return [
    { role: 'system', content: system },
    ...turns.map(({ role, content, imageIds: ids }) => ({
      role, content,
      ...(ids.length ? { images: ids.map(id => byId.get(id).data.toString('base64')) } : {})
    }))
  ];
}

module.exports = { decodeImage, normalizeImageIds, loadImages, buildVisualMessages };
