'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fixture() {
  const track = { stop: jest.fn(), getSettings: jest.fn(() => ({ displaySurface: 'monitor' })) };
  const video = { play: jest.fn(async () => {}), pause: jest.fn(), readyState: 2, videoWidth: 3840, videoHeight: 2160 };
  const drawImage = jest.fn();
  const canvas = { getContext: () => ({ drawImage }), toDataURL: () => 'data:image/jpeg;base64,/9j/AA==' };
  const mediaDevices = { getDisplayMedia: jest.fn(async () => ({ getTracks: () => [track], getVideoTracks: () => [track] })) };
  const fetch = jest.fn(async () => ({ ok: true, json: async () => ({ data: { id: '1234567890abcdef12345678' } }) }));
  const context = {
    document: { createElement: name => name === 'video' ? video : canvas },
    navigator: { mediaDevices }, fetch, setTimeout, clearTimeout
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/chat/chat-screen-capture.js'), 'utf8')
    .replace(/export /g, '');
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.captureScreen = captureScreen; this.uploadScreenshot = uploadScreenshot;`, context);
  return { ...context, track, video, canvas, drawImage, mediaDevices };
}

test('captures a single frame without audio, scales it and stops sharing before returning', async () => {
  const ctx = fixture();
  expect(await ctx.captureScreen()).toEqual({ dataUrl: 'data:image/jpeg;base64,/9j/AA==', source: 'monitor' });
  expect(ctx.mediaDevices.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false, monitorTypeSurfaces: 'include', selfBrowserSurface: 'include' });
  expect([ctx.canvas.width, ctx.canvas.height]).toEqual([1920, 1080]);
  expect(ctx.drawImage).toHaveBeenCalledWith(ctx.video, 0, 0, 1920, 1080);
  expect(ctx.track.stop).toHaveBeenCalledTimes(1);
  expect(ctx.video.srcObject).toBeNull();
  expect(ctx.fetch).not.toHaveBeenCalled();
});

test.each(['monitor', 'window', 'browser', undefined])('reports the actual chosen surface %s without claiming it is a monitor', async surface => {
  const ctx = fixture();
  ctx.track.getSettings.mockReturnValue({ displaySurface: surface });
  expect((await ctx.captureScreen()).source).toBe(surface || 'unknown');
});

test.each(['play', 'draw'])('stops every track when %s fails', async stage => {
  const ctx = fixture();
  if (stage === 'play') ctx.video.play.mockRejectedValue(new Error('frame failed'));
  else ctx.drawImage.mockImplementation(() => { throw new Error('frame failed'); });
  await expect(ctx.captureScreen()).rejects.toThrow('frame failed');
  expect(ctx.track.stop).toHaveBeenCalledTimes(1);
  expect(ctx.video.srcObject).toBeNull();
});

test('preserves user cancellation and reports unsupported browsers', async () => {
  const ctx = fixture();
  ctx.mediaDevices.getDisplayMedia.mockRejectedValue(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
  await expect(ctx.captureScreen()).rejects.toMatchObject({ name: 'NotAllowedError' });
  await expect(ctx.captureScreen({})).rejects.toThrow('paste or attach');
  expect(ctx.fetch).not.toHaveBeenCalled();
});

test('uploads only at send time and reuses the reference on retry', async () => {
  const ctx = fixture();
  const draft = { dataUrl: 'data:image/jpeg;base64,/9j/AA==' };
  const first = await ctx.uploadScreenshot(draft);
  expect(await ctx.uploadScreenshot(draft)).toEqual(first);
  expect(ctx.fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(ctx.fetch.mock.calls[0][1].body)).toEqual({ dataUrl: draft.dataUrl });
});

test('keeps the draft when upload fails', async () => {
  const ctx = fixture();
  ctx.fetch.mockResolvedValue({ ok: false, json: async () => ({ message: 'Storage unavailable' }) });
  const draft = { dataUrl: 'data:image/jpeg;base64,/9j/AA==' };
  await expect(ctx.uploadScreenshot(draft)).rejects.toThrow('Storage unavailable');
  expect(draft.imageId).toBeUndefined();
});
