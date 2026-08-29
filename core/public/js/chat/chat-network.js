const DEFAULT_UI_DEADLINE_MS = 6000;

export async function fetchWithDeadline(url, options = {}, timeoutMs = DEFAULT_UI_DEADLINE_MS) {
  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_UI_DEADLINE_MS;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const requestOptions = { ...options };
  if (controller && !requestOptions.signal) requestOptions.signal = controller.signal;

  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller) controller.abort();
      const error = new Error(`Request timed out after ${duration}ms`);
      error.code = 'UI_REQUEST_TIMEOUT';
      reject(error);
    }, duration);
  });

  try {
    return await Promise.race([fetch(url, requestOptions), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export { DEFAULT_UI_DEADLINE_MS };
