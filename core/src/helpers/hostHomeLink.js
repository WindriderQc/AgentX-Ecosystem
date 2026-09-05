'use strict';

const DEFAULT_HOST_HOME_LABEL = 'Back to host';
const MAX_HOST_HOME_LABEL_LENGTH = 80;

function normalizeHostHomePath(value) {
  const candidate = String(value || '').trim();
  if (!candidate.startsWith('/')
    || candidate.startsWith('//')
    || candidate.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(candidate)) {
    return '';
  }
  return candidate;
}

function normalizeHostHomeLabel(value) {
  return String(value || DEFAULT_HOST_HOME_LABEL)
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_HOST_HOME_LABEL_LENGTH) || DEFAULT_HOST_HOME_LABEL;
}

function getHostHomeLink(env = process.env) {
  const url = normalizeHostHomePath(env.AGENTX_HOST_HOME_URL);
  if (!url) return null;
  return {
    url,
    label: normalizeHostHomeLabel(env.AGENTX_HOST_HOME_LABEL),
  };
}

module.exports = {
  DEFAULT_HOST_HOME_LABEL,
  MAX_HOST_HOME_LABEL_LENGTH,
  getHostHomeLink,
  normalizeHostHomeLabel,
  normalizeHostHomePath,
};
