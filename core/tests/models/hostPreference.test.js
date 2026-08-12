'use strict';
const mongoose = require('mongoose');
const HostPreference = require('../../models/HostPreference');

beforeAll(async () => {
  await HostPreference.syncIndexes();
});

afterEach(async () => {
  await HostPreference.deleteMany({});
});

describe('HostPreference Model', () => {
  it('should create a valid preference with all fields', async () => {
    const pref = await HostPreference.create({
      hostUrl: 'http://192.0.2.99:11434',
      hostKey: 'primary',
      displayName: 'Host Gamma',
      pinnedModels: [{
        model: 'qwen3-2507-30b-long-48k',
        keepAlive: -1,
        contextSize: 0,
        autoRestore: true
      }],
      maxConcurrentModels: 1,
      vramTotalMiB: 49152,
      vramReservedMiB: 512,
      gpu: { model: '2x RTX 3090', computeCapability: '8.6', driver: '570.86' },
      tags: ['inference']
    });

    expect(pref.hostUrl).toBe('http://192.0.2.99:11434');
    expect(pref.hostKey).toBe('primary');
    expect(pref.pinnedModels).toHaveLength(1);
    expect(pref.pinnedModels[0].model).toBe('qwen3-2507-30b-long-48k');
    expect(pref.pinnedModels[0].keepAlive).toBe(-1);
    expect(pref.pinnedModels[0].autoRestore).toBe(true);
    expect(pref.maxConcurrentModels).toBe(1);
    expect(pref.vramTotalMiB).toBe(49152);
    expect(pref.gpu.model).toBe('2x RTX 3090');
  });

  it('should enforce unique hostUrl', async () => {
    await HostPreference.create({ hostUrl: 'http://192.0.2.99:11434', hostKey: 'primary' });
    await expect(
      HostPreference.create({ hostUrl: 'http://192.0.2.99:11434', hostKey: 'primary' })
    ).rejects.toThrow(/duplicate key/);
  });

  it('should apply defaults', async () => {
    const pref = await HostPreference.create({ hostUrl: 'http://192.0.2.66:11434', hostKey: 'tertiary' });
    expect(pref.pinnedModels).toEqual([]);
    expect(pref.maxConcurrentModels).toBe(1);
    expect(pref.vramReservedMiB).toBe(0);
    expect(pref.tags).toEqual([]);
  });

  it('should default pinnedModels to an empty array', async () => {
    const pref = await HostPreference.create({
      hostUrl: 'http://192.0.2.99:11434',
      hostKey: 'primary'
    });
    expect(Array.isArray(pref.pinnedModels)).toBe(true);
    expect(pref.pinnedModels).toHaveLength(0);
  });

  it('should accept a single-entry pinnedModels array', async () => {
    const pref = await HostPreference.create({
      hostUrl: 'http://192.0.2.99:11434',
      hostKey: 'primary',
      pinnedModels: [{ model: 'gemma4:26b' }]
    });
    expect(pref.pinnedModels).toHaveLength(1);
    expect(pref.pinnedModels[0].model).toBe('gemma4:26b');
    // Per-entry defaults
    expect(pref.pinnedModels[0].keepAlive).toBe(-1);
    expect(pref.pinnedModels[0].contextSize).toBe(0);
    expect(pref.pinnedModels[0].autoRestore).toBe(true);
  });

  it('should accept multi-entry pinnedModels', async () => {
    const pref = await HostPreference.create({
      hostUrl: 'http://192.0.2.99:11434',
      hostKey: 'primary',
      pinnedModels: [
        { model: 'qwen2.5:7b-instruct-q5_K_M', keepAlive: -1 },
        { model: 'nomic-embed-text:v1.5', keepAlive: 300, autoRestore: false }
      ]
    });
    expect(pref.pinnedModels).toHaveLength(2);
    expect(pref.pinnedModels[1].keepAlive).toBe(300);
    expect(pref.pinnedModels[1].autoRestore).toBe(false);
  });

  it('should accept loadedModel and status fields', async () => {
    const pref = await HostPreference.create({
      hostUrl: 'http://192.0.2.99:11434',
      hostKey: 'primary',
      pinnedModels: [{ model: 'gemma4:26b' }],
      loadedModel: 'gemma4:26b',
      status: 'ready'
    });
    expect(pref.loadedModel).toBe('gemma4:26b');
    expect(pref.status).toBe('ready');
  });

  it('should default status to idle', async () => {
    const pref = await HostPreference.create({
      hostUrl: 'http://192.0.2.99:11434',
      hostKey: 'primary'
    });
    expect(pref.status).toBe('idle');
  });

  it('should reject invalid status values', async () => {
    await expect(HostPreference.create({
      hostUrl: 'http://192.0.2.99:11434',
      hostKey: 'primary',
      status: 'invalid'
    })).rejects.toThrow(/validation/i);
  });

  it('should require hostUrl and hostKey', async () => {
    await expect(HostPreference.create({})).rejects.toThrow(/validation/i);
    await expect(HostPreference.create({ hostUrl: 'http://x' })).rejects.toThrow(/validation/i);
  });

  it('should silently drop legacy defaultModels/pinnedModel fields (schema is strict post-0157)', async () => {
    // Task 0157 flipped the HostPreference schema to strict:true after the
    // hostpreferences collection finished migrating to pinnedModels[]. Stale
    // writes that still carry legacy field names must not throw but must not
    // persist the unknown fields either — Mongoose silently drops them.
    const pref = await HostPreference.create({
      hostUrl: 'http://legacy:11434',
      hostKey: 'primary',
      // eslint-disable-next-line no-unused-vars
      defaultModels: ['legacy-m'],
      pinnedModel: 'legacy-pin'
    });
    expect(pref.hostUrl).toBe('http://legacy:11434');
    // Legacy fields are not on the typed mongoose doc.
    expect(pref.defaultModels).toBeUndefined();
    expect(pref.pinnedModel).toBeUndefined();

    // Confirm via a raw read that nothing snuck into the document either.
    const raw = await HostPreference.collection.findOne({ hostUrl: 'http://legacy:11434' });
    expect(raw.defaultModels).toBeUndefined();
    expect(raw.pinnedModel).toBeUndefined();
  });
});
