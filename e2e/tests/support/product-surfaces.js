'use strict';

const registry = require('../../../config/product-surfaces.json');

const DEFAULT_BASE_URLS = Object.freeze({
  core: 'http://127.0.0.1:3180',
  benchmark: 'http://127.0.0.1:3181',
  rag: 'http://127.0.0.1:3182',
});

const ENVIRONMENT_KEYS = Object.freeze({
  core: 'AGENTX_E2E_CORE_URL',
  benchmark: 'AGENTX_E2E_BENCHMARK_URL',
  rag: 'AGENTX_E2E_RAG_URL',
});

const profile = String(process.env.AGENTX_E2E_PROFILE || 'demo').trim().toLowerCase();
if (!registry.profiles.includes(profile)) {
  throw new Error(`AGENTX_E2E_PROFILE must be one of ${registry.profiles.join(', ')}`);
}

function normalizedBaseUrl(service) {
  const environmentKey = ENVIRONMENT_KEYS[service];
  const value = process.env[environmentKey] || DEFAULT_BASE_URLS[service];
  if (!value) throw new Error(`No browser-gate URL is configured for ${service}`);

  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${environmentKey} must use HTTP or HTTPS`);
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function urlFor(surface) {
  return `${normalizedBaseUrl(surface.service)}${surface.path}`;
}

function budgetFor(surface) {
  const budgetId = surface?.performanceBudget;
  const limits = registry.performanceBudgets?.[budgetId];
  if (!budgetId || !limits) {
    throw new Error(`No valid performance budget is configured for ${surface?.id || 'unknown surface'}`);
  }
  return Object.freeze({ id: budgetId, limits: Object.freeze({ ...limits }) });
}

const allowedOrigins = Object.freeze(registry.services.map((service) => (
  new URL(normalizedBaseUrl(service)).origin
)));

const criticalSurfaces = Object.freeze(registry.surfaces.filter((surface) => (
  surface.critical === true && surface.profiles.includes(profile)
)));

module.exports = {
  allowedOrigins,
  budgetFor,
  criticalSurfaces,
  normalizedBaseUrl,
  profile,
  urlFor,
};
