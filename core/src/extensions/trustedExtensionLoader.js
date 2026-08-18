'use strict';

const fs = require('fs');
const path = require('path');

const EXTENSION_ENV = 'AGENTX_EXTENSION_MODULES';
const TRUSTED_EXTENSION_CONTRACT_VERSION = 2;
const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function parseExtensionModules(raw = '') {
  const value = String(raw || '').trim();
  if (!value) return [];

  if (!value.startsWith('[')) return [value];

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${EXTENSION_ENV} must be a JSON array of absolute module paths: ${error.message}`);
  }

  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`${EXTENSION_ENV} must be a JSON array of non-empty module paths.`);
  }
  return parsed.map((entry) => entry.trim());
}

function normalizeManifest(exported, modulePath) {
  if (!exported || typeof exported !== 'object' || Array.isArray(exported)) {
    throw new Error(`Trusted extension ${modulePath} must export a manifest object.`);
  }

  const id = String(exported.id || '');
  if (!IDENTIFIER.test(id)) {
    throw new Error(`Trusted extension ${modulePath} has an invalid id; use lowercase letters, numbers, and hyphens.`);
  }

  const version = String(exported.version || '');
  if (!VERSION.test(version)) {
    throw new Error(`Trusted extension ${id} must declare a semantic version.`);
  }
  if (typeof exported.register !== 'function') {
    throw new Error(`Trusted extension ${id} must export register(api).`);
  }
  if (exported.register.constructor?.name === 'AsyncFunction') {
    throw new Error(`Trusted extension ${id} register(api) must be synchronous.`);
  }

  const capabilities = exported.capabilities === undefined ? [] : exported.capabilities;
  if (!Array.isArray(capabilities)
    || capabilities.some((entry) => !IDENTIFIER.test(String(entry || '')))) {
    throw new Error(`Trusted extension ${id} has an invalid capability id.`);
  }

  return Object.freeze({
    id,
    version,
    capabilities: Object.freeze([...new Set(capabilities)]),
    register: exported.register
  });
}

function resolveConfiguredModule(configuredPath) {
  if (!path.isAbsolute(configuredPath)) {
    throw new Error(`${EXTENSION_ENV} entries must be absolute paths: ${configuredPath}`);
  }

  const modulePath = fs.realpathSync(configuredPath);
  const stat = fs.statSync(modulePath);
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error(`Trusted extension path must resolve to a file or directory: ${configuredPath}`);
  }

  return {
    modulePath,
    extensionRoot: stat.isDirectory() ? modulePath : path.dirname(modulePath)
  };
}

function loadTrustedExtensions({
  app,
  express,
  mongoose,
  logger,
  profile,
  standardJsonParser,
  conversationLifecycle,
  runtimeServices,
  security,
  env = process.env,
  requireModule = require
}) {
  const configured = parseExtensionModules(env[EXTENSION_ENV]);
  if (configured.length === 0) return Object.freeze([]);

  if (profile !== 'full') {
    logger?.warn?.('Trusted extensions are configured but disabled outside the full profile');
    return Object.freeze([]);
  }

  if (!runtimeServices
    || runtimeServices.contractVersion !== 1
    || typeof runtimeServices.inference?.execute !== 'function'
    || typeof runtimeServices.routing?.getEffectiveSnapshot !== 'function') {
    throw new Error('Trusted extension runtimeServices contract v1 is unavailable or invalid.');
  }
  if (!security
    || security.contractVersion !== 1
    || typeof security.requireOperatorAccess !== 'function'
    || typeof security.requireOperatorUiAccess !== 'function') {
    throw new Error('Trusted extension security contract v1 is unavailable or invalid.');
  }

  const seenPaths = new Set();
  const seenIds = new Set();
  const seenCapabilities = new Set();
  const loaded = [];

  for (const configuredPath of configured) {
    const { modulePath, extensionRoot } = resolveConfiguredModule(configuredPath);
    if (seenPaths.has(modulePath)) {
      throw new Error(`Trusted extension module is configured twice: ${modulePath}`);
    }

    const manifest = normalizeManifest(requireModule(modulePath), modulePath);
    if (seenIds.has(manifest.id)) {
      throw new Error(`Duplicate trusted extension id: ${manifest.id}`);
    }
    for (const capability of manifest.capabilities) {
      if (seenCapabilities.has(capability)) {
        throw new Error(`Trusted extension capability is owned twice: ${capability}`);
      }
    }

    const api = Object.freeze({
      contractVersion: TRUSTED_EXTENSION_CONTRACT_VERSION,
      app,
      express,
      mongoose,
      logger,
      profile,
      standardJsonParser,
      conversationLifecycle,
      runtimeServices,
      security,
      extensionRoot
    });
    const result = manifest.register(api);
    if (result && typeof result.then === 'function') {
      throw new Error(`Trusted extension ${manifest.id} register(api) must be synchronous.`);
    }

    seenPaths.add(modulePath);
    seenIds.add(manifest.id);
    for (const capability of manifest.capabilities) seenCapabilities.add(capability);

    loaded.push(Object.freeze({
      id: manifest.id,
      version: manifest.version,
      capabilities: manifest.capabilities
    }));
    logger?.info?.(`Loaded trusted extension: ${manifest.id}@${manifest.version}`);
  }

  return Object.freeze(loaded);
}

module.exports = {
  EXTENSION_ENV,
  TRUSTED_EXTENSION_CONTRACT_VERSION,
  parseExtensionModules,
  normalizeManifest,
  resolveConfiguredModule,
  loadTrustedExtensions
};
