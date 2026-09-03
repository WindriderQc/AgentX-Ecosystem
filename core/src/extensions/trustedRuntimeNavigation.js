'use strict';

const MAX_RUNTIME_NAV_ITEMS = 8;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const ICON_PATTERN = /^fa-[a-z0-9][a-z0-9-]{0,47}$/;

function normalizeTrustedRuntimeNavItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const id = String(value.id || '').trim();
  const label = String(value.label || '').trim();
  const href = String(value.href || '').trim();
  const icon = String(value.icon || '').trim();

  if (!ID_PATTERN.test(id) || !label || label.length > 40 || /[\u0000-\u001f\u007f]/.test(label) || !ICON_PATTERN.test(icon)) return null;
  if (!href.startsWith('/api/') || href.startsWith('//') || /[\u0000-\u0020\\]/.test(href)) return null;

  let parsed;
  try {
    parsed = new URL(href, 'http://agentx.invalid');
  } catch {
    return null;
  }
  if (parsed.origin !== 'http://agentx.invalid' || !parsed.pathname.startsWith('/api/')) return null;

  return Object.freeze({ id, label, href: `${parsed.pathname}${parsed.search}`, icon });
}

function normalizeTrustedRuntimeNavItems(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const seen = new Set();
  const items = [];
  for (const candidate of value) {
    const item = normalizeTrustedRuntimeNavItem(candidate);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
    if (items.length === MAX_RUNTIME_NAV_ITEMS) break;
  }
  return Object.freeze(items);
}

module.exports = {
  MAX_RUNTIME_NAV_ITEMS,
  normalizeTrustedRuntimeNavItem,
  normalizeTrustedRuntimeNavItems,
};
