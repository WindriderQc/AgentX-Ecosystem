'use strict';

const { normalizeModelTag } = require('../../../shared/modelNames');

function normalizeModelName(name) {
  return normalizeModelTag(name);
}

function modelNameIdentityKey(name) {
  return normalizeModelName(name).toLowerCase();
}

function modelsMatch(a, b) {
  if (!a || !b) return false;
  const na = normalizeModelName(a);
  const nb = normalizeModelName(b);
  if (!na || !nb) return false;
  const ka = modelNameIdentityKey(na);
  const kb = modelNameIdentityKey(nb);
  return ka === kb;
}

function modelLookupNames(name) {
  const raw = String(name || '').trim().replace(/:latest$/i, '');
  if (!raw) return [];
  return [raw];
}

module.exports = {
  normalizeModelName,
  modelNameIdentityKey,
  modelsMatch,
  modelLookupNames
};
