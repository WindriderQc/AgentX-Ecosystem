'use strict';

const fs = require('fs');
const path = require('path');

const EXTENSION_ENV = 'AGENTX_EXTENSION_MODULES';
const EXTENSION_ID = /^[a-z][a-z0-9-]{0,63}$/;
const CAPABILITY_ID = /^[a-z][a-z0-9-]{0,63}$/;

function parseExtensionModules(raw = '') {
  const value = String(raw || '').trim();
  if (!value) return [];

  if (value.startsWith('[')) {
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

  return [value];
}

function normalizeManifest(exported, modulePath) {
  const manifest = typeof exported === 'function'
    ? { id: path.basename(modulePath), register: exported }
    : exported;

  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`Extension ${modulePath} must export a register function or manifest object.`);
  }
  if (!EXTENSION_ID.test(String(manifest.id || ''))) {
    throw new Error(`Extension ${modulePath} has an invalid id; use lowercase letters, numbers, and hyphens.`);
  }
  if (typeof manifest.register !== 'function') {
    throw new Error(`Extension ${manifest.id} must export register(api).`);
  }

  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  if (capabilities.some((entry) => !CAPABILITY_ID.test(String(entry || '')))) {
    throw new Error(`Extension ${manifest.id} has an invalid capability id.`);
  }

  return {
    id: manifest.id,
    version: String(manifest.version || '0.0.0'),
    capabilities: [...new Set(capabilities)],
    register: manifest.register
  };
}

function loadAgentXExtensions({
  app,
  express,
  mongoose,
  logger,
  profile,
  standardJsonParser,
  env = process.env,
  requireModule = require
}) {
  const configured = parseExtensionModules(env[EXTENSION_ENV]);
  if (configured.length === 0) return [];

  if (profile !== 'full') {
    logger?.warn?.('Agent X extensions are configured but disabled outside the full profile');
    return [];
  }

  const seenIds = new Set();
  const seenCapabilities = new Set();
  const loaded = [];

  for (const configuredPath of configured) {
    if (!path.isAbsolute(configuredPath)) {
      throw new Error(`${EXTENSION_ENV} entries must be absolute paths: ${configuredPath}`);
    }
    const modulePath = fs.realpathSync(configuredPath);
    const extensionRoot = fs.statSync(modulePath).isDirectory()
      ? modulePath
      : path.dirname(modulePath);
    const manifest = normalizeManifest(requireModule(modulePath), modulePath);

    if (seenIds.has(manifest.id)) throw new Error(`Duplicate Agent X extension id: ${manifest.id}`);
    for (const capability of manifest.capabilities) {
      if (seenCapabilities.has(capability)) {
        throw new Error(`Agent X extension capability is owned twice: ${capability}`);
      }
      seenCapabilities.add(capability);
    }

    const result = manifest.register(Object.freeze({
      app,
      express,
      mongoose,
      logger,
      profile,
      standardJsonParser,
      extensionRoot
    }));
    if (result && typeof result.then === 'function') {
      throw new Error(`Extension ${manifest.id} register(api) must be synchronous.`);
    }

    seenIds.add(manifest.id);
    loaded.push(Object.freeze({
      id: manifest.id,
      version: manifest.version,
      capabilities: Object.freeze([...manifest.capabilities])
    }));
    logger?.info?.(`Loaded Agent X extension: ${manifest.id}@${manifest.version}`);
  }

  return Object.freeze(loaded);
}

function extensionOwnsCapability(extensions, capability) {
  return extensions.some((extension) => extension.capabilities.includes(capability));
}

module.exports = {
  EXTENSION_ENV,
  parseExtensionModules,
  loadAgentXExtensions,
  extensionOwnsCapability
};
