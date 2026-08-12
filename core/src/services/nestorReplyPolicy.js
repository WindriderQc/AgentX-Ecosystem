'use strict';

const INTERNAL_BLOCK_TAGS = ['think', 'analysis', 'reasoning'];
const OUTPUT_LIMIT_REASONS = new Set([
  'length',
  'max_tokens',
  'max_output_tokens',
  'token_limit'
]);
const PRESENTATION_LABEL = /^(?:state|status|decision|action|next|verified|facts?|inference|unknowns?|[eé]tat|statut|d[eé]cision|suite|v[eé]rifi[eé]|faits?|inf[eé]rence|inconnus?)\s*:\s*/iu;
const INTERNAL_LINE = /^\s*(?:internal\s+(?:analysis|reasoning|notes?)|hidden\s+(?:analysis|reasoning)|analyse\s+interne|raisonnement\s+interne|notes?\s+internes?)\s*:/iu;

function sanitizeNestorReply(value) {
  let text = String(value || '').replace(/\r\n?/g, '\n');
  const exactSignal = text.trim();
  if (/^\[\[NESTOR_ESCALATE:[a-z0-9][a-z0-9_-]{0,47}\]\]$/iu.test(exactSignal)) {
    return exactSignal;
  }
  for (const tag of INTERNAL_BLOCK_TAGS) {
    const block = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:<\\/${tag}>|$)`, 'giu');
    text = text.replace(block, '');
  }
  text = text
    .replace(/<\/?(?:final|answer)\b[^>]*>/giu, '')
    .replace(/\[\[NESTOR_ESCALATE:[^\]]*\]\]/giu, '')
    .split('\n')
    .filter((line) => !INTERNAL_LINE.test(line))
    .join('\n')
    .replace(/^\s*(?:assistant(?:_final)?|final answer|r[eé]ponse finale)\s*:\s*/iu, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

function toSpeakableNestorText(value) {
  let text = sanitizeNestorReply(value);
  if (!text || /^\[\[NESTOR_ESCALATE:/iu.test(text)) return '';
  text = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/^\s{0,3}(?:#{1,6}|[-*+] |\d+[.)] )\s*/gmu, '')
    .replace(/[*_~]/g, '')
    .trim();

  const label = text.match(PRESENTATION_LABEL);
  if (label) text = text.slice(label[0].length).trim();
  return text.replace(/\s+/g, ' ').trim();
}

function extractCompletionMeta(data) {
  const source = data?.data && typeof data.data === 'object' ? data.data : data;
  const stats = source?.stats || data?.stats || null;
  const reason = source?.done_reason
    || source?.stop_reason
    || source?.finish_reason
    || stats?.completion?.reason
    || null;
  const tokens = source?.eval_count
    ?? stats?.usage?.completionTokens
    ?? null;
  return {
    reason: reason == null ? null : String(reason).trim().toLowerCase(),
    tokens: Number.isFinite(Number(tokens)) ? Number(tokens) : null
  };
}

function completionWasLimited(outcome, maximumTokens) {
  const reason = String(outcome?.completionReason || '').trim().toLowerCase();
  if (OUTPUT_LIMIT_REASONS.has(reason)) return true;
  const tokens = Number(outcome?.completionTokens);
  const maximum = Number(maximumTokens);
  return Number.isFinite(tokens) && Number.isFinite(maximum) && maximum > 0 && tokens >= maximum;
}

module.exports = {
  sanitizeNestorReply,
  toSpeakableNestorText,
  extractCompletionMeta,
  completionWasLimited,
  OUTPUT_LIMIT_REASONS
};
