'use strict';

/**
 * Exclusive Ollama model handoff primitives.
 *
 * The caller owns hostGate.acquireExclusive() before prepareExclusiveModel is
 * invoked. That ownership lets this service release an idle resident pin
 * without racing another model's inference. Pin configuration is preserved;
 * the normal reconciler restores it after the exclusive caller releases.
 */

const HostPreference = require('../../models/HostPreference');
const hostGate = require('./hostGate');
const logger = require('../../config/logger');
const { pinNamesMatch } = require('./hostPinPrimitives');

async function fetchRunningModels(hostUrl) {
  const response = await fetch(`${hostUrl}/api/ps`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Ollama model inventory returned HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.models)) throw new Error('Ollama model inventory is malformed');
  return body.models;
}

async function unloadModel(hostUrl, model) {
  try {
    const response = await fetch(`${hostUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) {
      const text = await response.text();
      return { host: hostUrl, model, status: 'error', error: text };
    }
    await response.text();
    return { host: hostUrl, model, status: 'ok' };
  } catch (err) {
    return { host: hostUrl, model, status: 'error', error: err.message };
  }
}

async function prepareExclusiveModel(hostUrl, model) {
  let runningModelInfos;
  try {
    runningModelInfos = await fetchRunningModels(hostUrl);
  } catch (error) {
    return { host: hostUrl, model, status: 'error', error: error.message, unloaded: [] };
  }
  const runningModels = runningModelInfos.map(entry => entry.name || entry.model).filter(Boolean);
  const unloaded = [];

  for (const loaded of runningModels) {
    if (pinNamesMatch(loaded, model)) continue;
    if (hostGate.inFlightFor(hostUrl, loaded) > 0) {
      return { host: hostUrl, model, status: 'busy', unloaded, blockingModel: loaded };
    }
    const result = await unloadModel(hostUrl, loaded);
    if (result.status !== 'ok') {
      return { host: hostUrl, model, status: 'error', error: result.error, unloaded };
    }
    unloaded.push(loaded);
  }

  if (unloaded.length > 0) {
    await HostPreference.findOneAndUpdate(
      { hostUrl },
      { $set: { status: 'swapping', loadedModel: null, loadedModels: [] } }
    );
    logger.info(`[HostPreference] Prepared exclusive model handoff to ${model} on ${hostUrl}`, { unloaded });
  }
  return { host: hostUrl, model, status: 'ready', unloaded };
}

module.exports = { unloadModel, prepareExclusiveModel };
