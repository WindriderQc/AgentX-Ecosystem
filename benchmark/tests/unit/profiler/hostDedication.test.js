'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

const HostProfile = require('../../../models/HostProfile');
const hostProfileService = require('../../../src/services/profiler/hostProfileService');
const { detectDedicated } = hostProfileService;

afterEach(async () => {
  await HostProfile.deleteMany({});
});

// ── Task 1: Schema tests ──────────────────────────────────────────

describe('HostProfile dedicated subdocument', () => {
  const baseProfile = {
    hostId: 'ded-test',
    hostUrl: 'http://192.0.2.66:11434',
  };

  it('accepts a dedicated subdocument with model, expiresAt, vramUsedMiB, detectedAt', async () => {
    const now = new Date();
    const profile = await HostProfile.create({
      ...baseProfile,
      dedicated: {
        model: 'llama3.2:3b',
        expiresAt: new Date('2099-01-01T00:00:00Z'),
        vramUsedMiB: 4096,
        detectedAt: now,
      },
    });

    expect(profile.dedicated).toBeDefined();
    expect(profile.dedicated.model).toBe('llama3.2:3b');
    expect(profile.dedicated.expiresAt).toEqual(new Date('2099-01-01T00:00:00Z'));
    expect(profile.dedicated.vramUsedMiB).toBe(4096);
    expect(profile.dedicated.detectedAt).toEqual(now);
  });

  it('allows dedicated to be null (no dedicated fields set)', async () => {
    const profile = await HostProfile.create({
      ...baseProfile,
      hostId: 'ded-null-test',
    });

    // Mongoose initializes subdocuments as empty objects; verify no model is set
    expect(profile.dedicated?.model).toBeUndefined();
    expect(profile.dedicated?.expiresAt).toBeUndefined();
    expect(profile.dedicated?.vramUsedMiB).toBeUndefined();
    expect(profile.dedicated?.detectedAt).toBeUndefined();
  });

  it('persists and retrieves dedicated:null via findOne', async () => {
    await HostProfile.create({
      ...baseProfile,
      hostId: 'ded-persist-test',
    });

    const found = await HostProfile.findOne({ hostId: 'ded-persist-test' }).lean();
    // When stored without values, lean() returns no dedicated key or null
    expect(found.dedicated?.model).toBeUndefined();
  });

  it('replaces a legacy dedicated:null value without writing conflicting dot paths', async () => {
    await HostProfile.collection.insertOne({
      hostId: 'legacy-null-dedicated',
      hostUrl: 'http://192.0.2.99:11434',
      dedicated: null
    });
    const detectedAt = new Date();

    const updated = await hostProfileService.upsert({
      hostId: 'legacy-null-dedicated',
      dedicated: {
        model: 'ax/gemma4:e4b',
        expiresAt: new Date('2099-01-01T00:00:00Z'),
        vramUsedMiB: 8192,
        detectedAt
      }
    });

    expect(updated.dedicated.model).toBe('ax/gemma4:e4b');
    expect(updated.dedicated.detectedAt).toEqual(detectedAt);
  });

  it('unsets dedicated state so a later detection can be persisted safely', async () => {
    await HostProfile.create({
      ...baseProfile,
      hostId: 'dedicated-clear-test',
      dedicated: { model: 'old:model', detectedAt: new Date() }
    });

    await hostProfileService.upsert({ hostId: 'dedicated-clear-test', dedicated: null });
    const cleared = await HostProfile.findOne({ hostId: 'dedicated-clear-test' }).lean();
    expect(cleared.dedicated).toBeUndefined();

    const updated = await hostProfileService.upsert({
      hostId: 'dedicated-clear-test',
      dedicated: { model: 'new:model', detectedAt: new Date() }
    });
    expect(updated.dedicated.model).toBe('new:model');
  });
});

// ── Task 2A: detectDedicated() pure function tests ─────────────────

describe('detectDedicated()', () => {
  const ONE_YEAR_FROM_NOW = new Date(Date.now() + 366 * 24 * 60 * 60 * 1000);
  const FIVE_MINUTES_FROM_NOW = new Date(Date.now() + 5 * 60 * 1000);

  it('detects a pinned model when expires_at is >1 year away', () => {
    const psData = {
      models: [
        {
          name: 'llama3.2:3b',
          expires_at: ONE_YEAR_FROM_NOW.toISOString(),
          size_vram: 4096 * 1024 * 1024, // 4096 MiB
        },
      ],
    };

    const result = detectDedicated(psData);

    expect(result).not.toBeNull();
    expect(result.model).toBe('llama3.2:3b');
    expect(result.expiresAt).toEqual(ONE_YEAR_FROM_NOW);
    expect(result.vramUsedMiB).toBe(4096);
    expect(result.detectedAt).toBeInstanceOf(Date);
  });

  it('returns null when no model has far-future expires_at (e.g. 5 min from now)', () => {
    const psData = {
      models: [
        {
          name: 'mistral:7b',
          expires_at: FIVE_MINUTES_FROM_NOW.toISOString(),
          size_vram: 8192 * 1024 * 1024,
        },
      ],
    };

    const result = detectDedicated(psData);
    expect(result).toBeNull();
  });

  it('returns null when models array is empty', () => {
    const result = detectDedicated({ models: [] });
    expect(result).toBeNull();
  });

  it('returns null when psData is null', () => {
    const result = detectDedicated(null);
    expect(result).toBeNull();
  });

  it('returns null when psData is undefined', () => {
    const result = detectDedicated(undefined);
    expect(result).toBeNull();
  });

  it('returns null when psData has no models key', () => {
    const result = detectDedicated({});
    expect(result).toBeNull();
  });

  it('picks the first pinned model if multiple exist', () => {
    const psData = {
      models: [
        {
          name: 'qwen2:7b',
          expires_at: ONE_YEAR_FROM_NOW.toISOString(),
          size_vram: 7000 * 1024 * 1024,
        },
        {
          name: 'llama3.2:3b',
          expires_at: ONE_YEAR_FROM_NOW.toISOString(),
          size_vram: 4096 * 1024 * 1024,
        },
      ],
    };

    const result = detectDedicated(psData);
    expect(result.model).toBe('qwen2:7b');
  });
});

// ── Task 2B: checkStatus() integration with detectDedicated() ──────

describe('checkStatus() dedicated integration', () => {
  let originalFetch;
  const service = require('../../../src/services/profiler/hostProfileService');

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns dedicated:null when host is offline', async () => {
    global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await service.checkStatus('http://192.0.2.99:11434');

    expect(result.status).toBe('offline');
    expect(result.dedicated).toBeNull();
  });

  it('returns dedicated:null when /api/tags is not ok', async () => {
    global.fetch.mockResolvedValue({ ok: false });

    const result = await service.checkStatus('http://192.0.2.12:11434');

    expect(result.status).toBe('offline');
    expect(result.dedicated).toBeNull();
  });

  it('returns dedicated:null when /api/ps fails but /api/tags succeeds', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ models: [{ name: 'llama3.2:3b' }] }),
      })
      .mockRejectedValueOnce(new Error('ps failed'));

    const result = await service.checkStatus('http://192.0.2.66:11434');

    expect(result.status).toBe('online');
    expect(result.dedicated).toBeNull();
  });

  it('returns dedicated data when /api/ps shows a pinned model', async () => {
    const farFuture = new Date(Date.now() + 366 * 24 * 60 * 60 * 1000);

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ models: [{ name: 'llama3.2:3b' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({
          models: [
            {
              name: 'llama3.2:3b',
              expires_at: farFuture.toISOString(),
              size_vram: 4096 * 1024 * 1024,
            },
          ],
        }),
      });

    const result = await service.checkStatus('http://192.0.2.66:11434');

    expect(result.status).toBe('online');
    expect(result.dedicated).not.toBeNull();
    expect(result.dedicated.model).toBe('llama3.2:3b');
    expect(result.dedicated.vramUsedMiB).toBe(4096);
  });

  it('returns dedicated:null when /api/ps returns not ok', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ models: [{ name: 'llama3.2:3b' }] }),
      })
      .mockResolvedValueOnce({ ok: false });

    const result = await service.checkStatus('http://192.0.2.66:11434');

    expect(result.status).toBe('online');
    expect(result.dedicated).toBeNull();
  });
});

// ── Task 4: releaseModel export test ─────────────────────────────────

describe('releaseModel', () => {
  it('is exported as a function', () => {
    const hostProfileService = require('../../../src/services/profiler/hostProfileService');
    expect(typeof hostProfileService.releaseModel).toBe('function');
  });
});

// ── Task 5: isDedicatedConflict() ─────────────────────────────────────

describe('isDedicatedConflict', () => {
  const hostProfileService = require('../../../src/services/profiler/hostProfileService');

  it('returns true when host is dedicated to a different model', () => {
    const host = { dedicated: { model: 'qwen3-30b:latest' } };
    expect(hostProfileService.isDedicatedConflict(host, 'llama3:8b')).toBe(true);
  });

  it('returns false when requesting the pinned model', () => {
    const host = { dedicated: { model: 'qwen3-30b:latest' } };
    expect(hostProfileService.isDedicatedConflict(host, 'qwen3-30b:latest')).toBe(false);
  });

  it('returns false when host is not dedicated', () => {
    const host = { dedicated: null };
    expect(hostProfileService.isDedicatedConflict(host, 'llama3:8b')).toBe(false);
  });

  it('returns false when dedicated field is missing', () => {
    const host = {};
    expect(hostProfileService.isDedicatedConflict(host, 'llama3:8b')).toBe(false);
  });
});
