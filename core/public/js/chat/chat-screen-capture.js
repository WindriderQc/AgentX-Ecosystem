/** One-shot screen capture. Draft bytes stay in this tab until Send. */
const MAX_EDGE = 1920;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function imageDataUrl(source, width, height) {
  if (!width || !height) throw new Error('The selected screen has no image yet. Try again.');
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
  if (dataUrl.length * 0.75 > MAX_IMAGE_BYTES) throw new Error('This image is too large. Capture a smaller area.');
  return dataUrl;
}

export async function captureScreen(mediaDevices = navigator.mediaDevices) {
  if (!mediaDevices?.getDisplayMedia) {
    throw new Error('Screen capture needs HTTPS and a supported desktop browser. You can also paste or attach a screenshot.');
  }
  let stream;
  let video;
  let timer;
  try {
    // Let the user choose a monitor, window or tab, including this tab.
    stream = await mediaDevices.getDisplayMedia({
      video: true, audio: false, monitorTypeSurfaces: 'include', selfBrowserSurface: 'include'
    });
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await Promise.race([
      (async () => {
        await video.play();
        if (video.requestVideoFrameCallback) {
          await new Promise(resolve => video.requestVideoFrameCallback(resolve));
        } else if (video.readyState < 2) {
          await new Promise((resolve, reject) => {
            video.onloadeddata = resolve;
            video.onerror = reject;
          });
        }
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No screen frame received. Try again.')), 10000); })
    ]);
    return {
      dataUrl: imageDataUrl(video, video.videoWidth, video.videoHeight),
      source: stream.getVideoTracks?.()[0]?.getSettings?.().displaySurface || 'unknown'
    };
  } finally {
    clearTimeout(timer);
    stream?.getTracks().forEach(track => track.stop());
    if (video) { video.pause(); video.srcObject = null; }
  }
}

export function initScreenCapture({ state, elements, helpers }) {
  const button = document.getElementById('captureScreenBtn');
  const fileInput = document.getElementById('screenshotFile');
  const preview = document.getElementById('screenshotPreview');
  const image = document.getElementById('screenshotPreviewImage');
  const label = document.getElementById('screenshotPreviewLabel');
  const sourceLabels = { monitor: 'Entire screen attached', window: 'Window attached', browser: 'Browser tab attached' };
  let revision = 0;
  let busy = false;
  state.screenshotDraft = null;

  const show = capture => {
    state.screenshotDraft = typeof capture === 'string' ? { dataUrl: capture } : capture;
    image.src = state.screenshotDraft.dataUrl;
    label.textContent = sourceLabels[state.screenshotDraft.source] || 'Screenshot attached';
    preview.hidden = false;
    helpers.setFeedback(`${label.textContent}. Add your question, then send to a model with vision.`, 'muted');
  };
  helpers.clearScreenshot = () => {
    revision += 1;
    state.screenshotDraft = null;
    image.removeAttribute('src');
    preview.hidden = true;
  };
  helpers.editScreenshot = imageId => {
    helpers.clearScreenshot();
    if (imageId) {
      state.screenshotDraft = { imageId };
      label.textContent = 'Screenshot attached';
      image.src = `/api/chat/images/${encodeURIComponent(imageId)}`;
      preview.hidden = false;
    }
  };
  document.getElementById('removeScreenshotBtn').addEventListener('click', helpers.clearScreenshot);

  async function acquire(read) {
    if (busy || state.sending) return;
    busy = true;
    button.disabled = true;
    const current = revision;
    try {
      const capture = await read();
      // A capture that finishes after Send, New chat or navigation is stale.
      if (revision === current && !state.sending) show(capture);
    } catch (error) {
      if (error.name !== 'NotAllowedError' && revision === current) {
        helpers.setFeedback(error.message || 'Could not capture this screen.', 'error');
      }
    } finally {
      busy = false;
      button.disabled = false;
    }
  }

  button.addEventListener('click', () => acquire(() => captureScreen()));
  document.getElementById('attachScreenshotBtn').addEventListener('click', () => fileInput.click());
  const readFile = async file => {
    if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      throw new Error('Choose a PNG, JPEG or WebP screenshot.');
    }
    const bitmap = await createImageBitmap(file);
    try { return imageDataUrl(bitmap, bitmap.width, bitmap.height); }
    finally { bitmap.close(); }
  };
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (file) void acquire(() => readFile(file));
  });
  elements.messageInput.addEventListener('paste', event => {
    const item = Array.from(event.clipboardData?.items || []).find(entry => entry.type.startsWith('image/'));
    if (!item) return;
    event.preventDefault();
    void acquire(() => readFile(item.getAsFile()));
  });
}

export async function uploadScreenshot(draft) {
  if (!draft) return [];
  if (draft.imageId) return [draft.imageId];
  const response = await fetch('/api/chat/images', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'include', body: JSON.stringify({ dataUrl: draft.dataUrl })
  });
  const result = await response.json();
  if (!response.ok || !result.data?.id) throw new Error(result.message || 'Could not attach the screenshot.');
  draft.imageId = result.data.id;
  return [draft.imageId];
}
