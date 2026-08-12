const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS = 1600;
const MAX_MEMORY_CHUNKS = 6;

function clip(text, maxChars) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= maxChars) return value;
  return value.slice(0, Math.max(0, maxChars - 3)) + '...';
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((turn) => turn && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string')
    .slice(-MAX_HISTORY_MESSAGES)
    .map((turn) => ({
      role: turn.role,
      content: clip(turn.content, MAX_HISTORY_CHARS)
    }))
    .filter((turn) => turn.content);
}

function memoryText(result) {
  if (!result || typeof result !== 'object') return '';
  return result.text
    || result.content
    || result.chunk?.text
    || result.payload?.text
    || result.metadata?.text
    || '';
}

function buildMemorySection(memoryResults) {
  const chunks = Array.isArray(memoryResults) ? memoryResults.slice(0, MAX_MEMORY_CHUNKS) : [];
  const lines = chunks
    .map((result) => clip(memoryText(result), 500))
    .filter(Boolean);

  if (!lines.length) return '';
  return [
    'Relevant memory:',
    ...lines.map((line) => `- ${line}`)
  ].join('\n');
}

function buildSafetySection(safety) {
  if (!safety || !Array.isArray(safety.flagIds) || safety.flagIds.length === 0) {
    return 'Safety flags for this turn: none.';
  }
  const lines = [
    `Safety flags for this turn: ${safety.flagIds.join(', ')}.`,
    `Requires attention: ${safety.requiresAttention ? 'yes' : 'no'}.`
  ];
  if (safety.deterministicEscalation) {
    lines.push('Deterministic escalation is active: do not continue normal roleplay or casual banter.');
  }
  return lines.join('\n');
}

async function buildVoicePersonaMessages({
  pack,
  mode,
  prompt,
  promptSource,
  promptConfig,
  scopeId,
  memoryResults,
  safety,
  history,
  userText
}) {
  const memorySection = buildMemorySection(memoryResults);
  const systemParts = [
    prompt,
    mode?.systemSuffix || '',
    `Persona pack: ${pack.id}. Mode: ${mode?.id || pack.defaultMode}. Memory scope: ${scopeId || pack.defaultScopeId || 'default'}.`,
    `Prompt source: ${promptSource}${promptConfig ? ` (${promptConfig.name} v${promptConfig.version})` : ''}.`,
    buildSafetySection(safety),
    memorySection,
    'Reply for spoken use. Keep normal replies concise. Do not mention internal trace ids, audit storage, model routing, or safety flags unless the user asks about the system itself.'
  ].filter(Boolean);

  return [
    { role: 'system', content: systemParts.join('\n\n') },
    ...sanitizeHistory(history),
    { role: 'user', content: String(userText || '').trim() }
  ];
}

function extractReplyText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload.reply?.text,
    payload.reply,
    payload.message?.content,
    payload.response?.text,
    payload.response,
    payload.assistant?.text,
    payload.text,
    payload.data?.reply?.text,
    payload.data?.message?.content,
    payload.data?.text
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object') return JSON.stringify(value);
  }
  return '';
}

module.exports = {
  MAX_HISTORY_MESSAGES,
  buildVoicePersonaMessages,
  buildMemorySection,
  buildSafetySection,
  extractReplyText,
  sanitizeHistory,
  _memoryText: memoryText
};
