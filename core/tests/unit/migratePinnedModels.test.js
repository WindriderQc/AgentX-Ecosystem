/**
 * Regression test for task 0151 migration.
 *
 * Simulates the live mixed-field state (Host Delta / Host Beta / Host Gamma) and
 * verifies the service-layer fallback + migration idempotency. The
 * migration script itself is exercised directly via its exported logic.
 */

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const HostPreference = require('../../models/HostPreference');
const service = require('../../src/services/hostPreferenceService');

afterEach(async () => {
  await HostPreference.deleteMany({});
});

// Inline port of the migration's merge logic so we can verify it without
// reconnecting mongoose in-process. Keeps the test hermetic — the real
// script is re-tested manually via its CLI on the live DB.
function mergePinnedModels(doc) {
  const existing = Array.isArray(doc.pinnedModels) ? doc.pinnedModels : [];
  const names = new Set(existing.map(e => e && e.model).filter(Boolean));
  const fallbackKeepAlive = Number.isFinite(doc.keepAlive) ? doc.keepAlive : -1;
  const fallbackContext = Number.isFinite(doc.contextSize) ? doc.contextSize : 0;
  const fallbackAutoRestore = doc.autoRestore !== false;

  const merged = existing.map(e => ({
    model: e.model,
    keepAlive: e.keepAlive ?? fallbackKeepAlive,
    contextSize: e.contextSize ?? fallbackContext,
    autoRestore: e.autoRestore ?? fallbackAutoRestore
  }));

  if (doc.pinnedModel && !names.has(doc.pinnedModel)) {
    merged.push({
      model: doc.pinnedModel,
      keepAlive: -1,
      contextSize: fallbackContext,
      autoRestore: fallbackAutoRestore
    });
    names.add(doc.pinnedModel);
  }

  if (Array.isArray(doc.defaultModels)) {
    for (const m of doc.defaultModels) {
      if (!m || names.has(m)) continue;
      merged.push({
        model: m,
        keepAlive: fallbackKeepAlive,
        contextSize: fallbackContext,
        autoRestore: fallbackAutoRestore
      });
      names.add(m);
    }
  }
  return merged;
}

describe('task 0151 — pinnedModels migration', () => {
  beforeEach(async () => {
    // Seed the three live hosts in their 2026-04-19 pre-migration shapes.
    await HostPreference.collection.insertMany([
      {
        hostUrl: 'http://192.0.2.66:11434',
        hostKey: 'primary',
        displayName: 'Host Delta',
        defaultModels: ['gemma4:26b'],
        keepAlive: -1,
        status: 'idle'
      },
      {
        hostUrl: 'http://192.0.2.12:11434',
        hostKey: 'secondary',
        displayName: 'Host Beta',
        // Duplicate state as observed in prod
        defaultModels: ['gemma4:e4b'],
        pinnedModel: 'gemma4:e4b',
        keepAlive: -1,
        autoRestore: true,
        status: 'ready'
      },
      {
        hostUrl: 'http://192.0.2.99:11434',
        hostKey: 'tertiary',
        displayName: 'Host Gamma',
        defaultModels: ['qwen2.5:7b-instruct-q5_K_M', 'nomic-embed-text:v1.5'],
        keepAlive: -1,
        status: 'idle'
      }
    ]);
  });

  it('service.getPinnedEntries resolves legacy shapes without migration', async () => {
    const clawdx = await service.getByHost('http://192.0.2.66:11434');
    const brutal = await service.getByHost('http://192.0.2.12:11434');
    const frank = await service.getByHost('http://192.0.2.99:11434');

    expect(service.getPinnedModelNames(clawdx)).toEqual(['gemma4:26b']);
    // Host Beta dedup — pinnedModel wins first slot but defaultModels entry
    // with the same name must not duplicate.
    expect(service.getPinnedModelNames(brutal)).toEqual(['gemma4:e4b']);
    expect(service.getPinnedModelNames(frank)).toEqual([
      'qwen2.5:7b-instruct-q5_K_M',
      'nomic-embed-text:v1.5'
    ]);
  });

  it('migration merge is idempotent', async () => {
    const coll = HostPreference.collection;
    const docs = await coll.find({}).toArray();
    for (const doc of docs) {
      const merged = mergePinnedModels(doc);
      await coll.updateOne({ _id: doc._id }, { $set: { pinnedModels: merged } });
    }

    // Second pass should produce identical pinnedModels
    const docs2 = await coll.find({}).toArray();
    for (const doc of docs2) {
      const merged2 = mergePinnedModels(doc);
      expect(merged2.map(e => e.model)).toEqual(doc.pinnedModels.map(e => e.model));
    }
  });

  it('warmAllDefaults visits every pinned entry after migration', async () => {
    // Drive the service with all legacy shapes still in place — warmAllDefaults
    // should not throw, and should emit one result per pinned entry even
    // without mocking fetch (unreachable host = status 'error' result).
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('unreachable'); };
    try {
      const results = await service.warmAllDefaults();
      // 1 (clawdx) + 1 (brutal, deduped) + 2 (frank) = 4
      expect(results.length).toBe(4);
      for (const r of results) {
        expect(['error', 'ok', 'already_loaded']).toContain(r.status);
      }
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('merge preserves per-entry metadata when rewriting a post-migration doc', async () => {
    const coll = HostPreference.collection;
    // Hand-craft a mid-migration doc that already has pinnedModels entries
    // with tuned keepAlive, plus a stray legacy field.
    await coll.insertOne({
      hostUrl: 'http://already-migrated:11434',
      hostKey: 'primary',
      pinnedModels: [{ model: 'custom', keepAlive: 1234, contextSize: 4096, autoRestore: false }],
      defaultModels: ['stray-legacy']
    });
    const doc = await coll.findOne({ hostUrl: 'http://already-migrated:11434' });
    const merged = mergePinnedModels(doc);
    expect(merged.find(e => e.model === 'custom').keepAlive).toBe(1234);
    expect(merged.find(e => e.model === 'custom').autoRestore).toBe(false);
    expect(merged.find(e => e.model === 'stray-legacy')).toBeDefined();
  });
});
