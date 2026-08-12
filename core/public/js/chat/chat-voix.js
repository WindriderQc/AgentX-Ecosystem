/**
 * Chat VoiX helper — frontend proxy helpers for /api/voix/*
 */

async function parseJson(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function voixRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    },
    ...options
  });
  const payload = await parseJson(response);

  if (!response.ok) {
    throw new Error(payload?.message || `VoiX request failed (${response.status})`);
  }

  return payload?.data ?? payload;
}

function getNestedValue(input, path) {
  return path.split('.').reduce((value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    return value[key];
  }, input);
}

function pickFirst(input, paths) {
  for (const path of paths) {
    const value = getNestedValue(input, path);
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return null;
}

export function extractVoixSessionId(payload) {
  return pickFirst(payload, [
    'session_id',
    'sessionId',
    'session.id',
    'session.session_id',
    'data.session_id',
    'data.sessionId'
  ]);
}

export function extractVoixReplyText(payload) {
  const value = pickFirst(payload, [
    'reply.text',
    'reply',
    'response.text',
    'response',
    'assistant.text',
    'text'
  ]);

  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
  return value;
}

export function extractVoixTranscript(payload) {
  const value = pickFirst(payload, [
    'transcript',
    'result.transcript',
    'speech.transcript',
    'recognized_text',
    'text'
  ]);

  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
  return value;
}

export function formatVoixTimings(payload) {
  const timingKeys = [
    ['timings.total_ms', 'total'],
    ['timings.stt_ms', 'stt'],
    ['timings.tts_ms', 'tts'],
    ['timings.llm_ms', 'llm'],
    ['metrics.latency_ms', 'latency'],
    ['metrics.total_ms', 'total'],
    ['elapsed_ms', 'elapsed'],
    ['duration_ms', 'duration'],
    ['latency_ms', 'latency']
  ];

  const parts = timingKeys
    .map(([path, label]) => {
      const value = pickFirst(payload, [path]);
      return Number.isFinite(Number(value)) ? `${label}: ${Number(value)}ms` : null;
    })
    .filter(Boolean);

  return parts.length ? parts.join(' | ') : 'No timing metadata';
}

export function summarizeVoixDevices(payload) {
  if (Array.isArray(payload)) {
    if (!payload.length) return 'No devices reported';
    return payload
      .slice(0, 4)
      .map((item) => item.name || item.label || item.id || 'device')
      .join(', ');
  }

  if (payload && typeof payload === 'object') {
    const arrayEntry = Object.values(payload).find((value) => Array.isArray(value));
    if (Array.isArray(arrayEntry) && arrayEntry.length) {
      return arrayEntry
        .slice(0, 4)
        .map((item) => item.name || item.label || item.id || 'device')
        .join(', ');
    }

    const keys = Object.keys(payload);
    if (keys.length) {
      return keys.join(', ');
    }
  }

  return 'No devices reported';
}

export function summarizeVoixHealth(payload) {
  const status = pickFirst(payload, ['status', 'state', 'health']) || 'unknown';
  const version = pickFirst(payload, ['version', 'service.version']);
  return version ? `${status} (v${version})` : status;
}

export function stringifyVoixResult(payload) {
  return JSON.stringify(payload || {}, null, 2);
}

export function fetchVoixHealth() {
  return voixRequest('/api/voix/health');
}

export function fetchVoixDevices() {
  return voixRequest('/api/voix/devices');
}

export function fetchVoixSettings() {
  return voixRequest('/api/voix/settings');
}

export function runVoixTtsSmoke(body = {}) {
  return voixRequest('/api/voix/diagnostics/tts-smoke', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

export function runVoixFullSmoke(body = {}) {
  return voixRequest('/api/voix/diagnostics/smoke', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

export function createVoixSession(body = {}) {
  return voixRequest('/api/voix/sessions', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

export function sendVoixTextTurn(body = {}) {
  return voixRequest('/api/voix/sessions/text-turn', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

export async function transcribeVoixAudio(blob, { language, model } = {}) {
  const formData = new FormData();
  formData.append('audio', blob, 'recording.webm');
  if (language) formData.append('language', language);
  if (model) formData.append('model', model);

  const response = await fetch('/api/voix/transcribe', {
    method: 'POST',
    credentials: 'include',
    body: formData
  });
  const payload = await parseJson(response);
  if (!response.ok) {
    throw new Error(payload?.message || `VoiX transcription failed (${response.status})`);
  }
  return payload?.data ?? payload;
}

export async function synthesizeVoixAudio(text, { voice, responseFormat } = {}) {
  const response = await fetch('/api/voix/synthesize', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: voice || '', response_format: responseFormat || undefined })
  });
  if (!response.ok) {
    const payload = await parseJson(response);
    throw new Error(payload?.message || `VoiX synthesis failed (${response.status})`);
  }
  return response.blob();
}
