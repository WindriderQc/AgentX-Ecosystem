/**
 * Unit Tests for Host Preference Service
 */

// Mock logger to suppress output during tests
jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const mockObservePinRestoreFailure = jest.fn(async () => ({ emitted: 1, matched: 1 }));
jest.mock('../../src/services/laneObservabilityService', () => ({
  observePinRestoreFailure: (...args) => mockObservePinRestoreFailure(...args)
}));

const HostPreference = require('../../models/HostPreference');
const service = require('../../src/services/hostPreferenceService');

afterEach(async () => {
  await HostPreference.deleteMany({});
});

describe('hostPreferenceService', () => {
  describe('host identity normalization', () => {
    let originalEnv;

    beforeEach(() => {
      originalEnv = { ...process.env };
      process.env.OLLAMA_HOST = 'http://primary:11434';
      process.env.OLLAMA_HOST_NAME = 'Host Alpha';
      process.env.OLLAMA_HOST_2 = 'http://secondary:11434';
      process.env.OLLAMA_HOST_2_NAME = 'Host Beta';
      process.env.OLLAMA_HOST_3 = 'http://tertiary:11434';
      process.env.OLLAMA_HOST_3_NAME = 'Host Gamma';
      delete process.env.OLLAMA_HOST_SECONDARY;
      delete process.env.OLLAMA_HOST_TERTIARY;
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('renders a configured host with its canonical hostKey and preserves drift metadata', () => {
      const normalized = service.normalizeHostPreferenceIdentity({
        hostUrl: 'http://tertiary:11434',
        hostKey: 'primary',
        displayName: 'Host Gamma'
      });

      expect(normalized.hostKey).toBe('tertiary');
      expect(normalized.persistedHostKey).toBe('primary');
      expect(normalized.configuredHostKey).toBe('tertiary');
      expect(normalized.hostKeyDrift).toEqual(expect.objectContaining({
        type: 'host_key_mismatch',
        persisted: 'primary',
        configured: 'tertiary'
      }));
    });

    it('detects duplicate persisted host keys while active configured keys stay unique', () => {
      const drift = service.detectHostPreferenceIdentityDrift([
        { hostUrl: 'http://primary:11434', hostKey: 'primary', displayName: 'Host Alpha' },
        { hostUrl: 'http://secondary:11434', hostKey: 'secondary', displayName: 'Host Beta' },
        { hostUrl: 'http://tertiary:11434', hostKey: 'primary', displayName: 'Host Gamma' }
      ]);

      expect(drift.mismatches).toHaveLength(1);
      expect(drift.duplicatePersistedHostKeys).toEqual([
        expect.objectContaining({ hostKey: 'primary', count: 2 })
      ]);
      expect(drift.duplicateActiveHostKeys).toEqual([]);
      expect(drift.hasDrift).toBe(true);
    });

    it('normalizes configured hostKey on preference writes', async () => {
      const pref = await service.updatePreference('http://tertiary:11434', {
        hostKey: 'primary',
        displayName: 'Host Gamma'
      });

      expect(pref.hostKey).toBe('tertiary');
    });
  });

  describe('getAll / getByHost', () => {
    it('should return empty array when no preferences exist', async () => {
      const all = await service.getAll();
      expect(all).toEqual([]);
    });

    it('should return all preferences', async () => {
      await HostPreference.create({ hostUrl: 'http://host1:11434', hostKey: 'primary', pinnedModels: [{ model: 'm1' }] });
      await HostPreference.create({ hostUrl: 'http://host2:11434', hostKey: 'secondary', pinnedModels: [{ model: 'm2' }] });
      const all = await service.getAll();
      expect(all).toHaveLength(2);
    });

    it('should get preference by hostUrl', async () => {
      await HostPreference.create({ hostUrl: 'http://host1:11434', hostKey: 'primary', pinnedModels: [{ model: 'm1' }] });
      const pref = await service.getByHost('http://host1:11434');
      expect(service.getPinnedModelNames(pref)).toEqual(['m1']);
    });

    it('should return null for unknown host', async () => {
      const pref = await service.getByHost('http://unknown:11434');
      expect(pref).toBeNull();
    });
  });

  describe('updatePreference', () => {
    it('should upsert a new preference', async () => {
      const pref = await service.updatePreference('http://host1:11434', {
        hostKey: 'primary',
        pinnedModels: [{ model: 'model-a' }],
        vramTotalMiB: 24576
      });
      expect(pref.hostUrl).toBe('http://host1:11434');
      expect(service.getPinnedModelNames(pref)).toEqual(['model-a']);
      expect(pref.vramTotalMiB).toBe(24576);
    });

    it('should update an existing preference', async () => {
      await service.updatePreference('http://host1:11434', { hostKey: 'primary', pinnedModels: [{ model: 'old' }] });
      const updated = await service.updatePreference('http://host1:11434', { pinnedModels: [{ model: 'new' }] });
      expect(service.getPinnedModelNames(updated)).toEqual(['new']);
    });
  });

  describe('warmDefaultModel', () => {
    it('should return error result when host is unreachable', async () => {
      const result = await service.warmDefaultModel('http://127.0.0.1:99999', 'test-model');
      expect(result.status).toBe('error');
      expect(result.host).toBe('http://127.0.0.1:99999');
      expect(result.model).toBe('test-model');
    });

    it('uses a bounded non-streaming one-token generate warmup with configured context', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn(async () => ({
        ok: true,
        text: async () => '{}'
      }));

      try {
        const result = await service.warmDefaultModel('http://warm-host:11434', 'gemma4:26b', {
          keepAlive: -1,
          contextSize: 65536
        });

        expect(result.status).toBe('ok');
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, options] = global.fetch.mock.calls[0];
        expect(url).toBe('http://warm-host:11434/api/generate');
        const payload = JSON.parse(options.body);
        expect(payload).toEqual({
          model: 'gemma4:26b',
          prompt: 'warmup',
          stream: false,
          keep_alive: -1,
          options: {
            num_predict: 1,
            num_ctx: 65536
          }
        });
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('uses the embeddings endpoint for embedding-only warmup', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn(async () => ({
        ok: true,
        text: async () => JSON.stringify({ embedding: [0] })
      }));

      try {
        const result = await service.warmDefaultModel('http://warm-host:11434', 'nomic-embed-text:v1.5', {
          keepAlive: -1
        });

        expect(result.status).toBe('ok');
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, options] = global.fetch.mock.calls[0];
        expect(url).toBe('http://warm-host:11434/api/embeddings');
        const payload = JSON.parse(options.body);
        expect(payload).toEqual({
          model: 'nomic-embed-text:v1.5',
          prompt: 'warmup',
          keep_alive: -1
        });
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('warmHost does not treat a namespaced artifact as satisfying a bare pin', async () => {
      const originalFetch = global.fetch;
      const hostUrl = 'http://adapted-host:11434';
      await HostPreference.create({
        hostUrl,
        hostKey: 'primary',
        pinnedModels: [{ model: 'gemma4:26b', keepAlive: -1 }],
        status: 'idle'
      });

      global.fetch = jest.fn(async (url) => {
        if (typeof url === 'string' && url.endsWith('/api/ps')) {
          return {
            ok: true,
            json: async () => ({
              models: [{ name: 'ax/gemma4:26b' }]
            })
          };
        }
        return {
          ok: true,
          text: async () => '{}'
        };
      });

      try {
        const result = await service.warmHost(hostUrl);
        expect(result[0].status).toBe('ok');
        const generateCalls = global.fetch.mock.calls.filter(
          c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
        );
        expect(generateCalls).toHaveLength(1);
        expect(JSON.parse(generateCalls[0][1].body)).toMatchObject({
          model: 'gemma4:26b'
        });
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('warmHost warms generative pins before embedding pins to preserve both', async () => {
      const originalFetch = global.fetch;
      const hostUrl = 'http://mixed-host:11434';
      await HostPreference.create({
        hostUrl,
        hostKey: 'secondary',
        pinnedModels: [
          { model: 'ax/qwen2.5:7b-instruct-q5_K_M', keepAlive: -1 },
          { model: 'nomic-embed-text:v1.5', keepAlive: -1 }
        ],
        status: 'idle'
      });

      global.fetch = jest.fn(async (url) => {
        if (typeof url === 'string' && url.endsWith('/api/ps')) {
          return { ok: true, json: async () => ({ models: [] }) };
        }
        return { ok: true, text: async () => '{}' };
      });

      try {
        const result = await service.warmHost(hostUrl);
        expect(result.map(r => r.model)).toEqual([
          'ax/qwen2.5:7b-instruct-q5_K_M',
          'nomic-embed-text:v1.5'
        ]);
        const warmCalls = global.fetch.mock.calls
          .map(c => c[0])
          .filter(url => typeof url === 'string' && !url.endsWith('/api/ps'));
        expect(warmCalls).toEqual([
          'http://mixed-host:11434/api/generate',
          'http://mixed-host:11434/api/embeddings'
        ]);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('warmHost reloads a loaded pin when the resident context differs from contextSize', async () => {
      const originalFetch = global.fetch;
      const hostUrl = 'http://ctx-mismatch-host:11434';
      await HostPreference.create({
        hostUrl,
        hostKey: 'primary',
        pinnedModels: [{ model: 'gemma4:26b', keepAlive: -1, contextSize: 65536 }],
        status: 'ready'
      });

      global.fetch = jest.fn(async (url) => {
        if (typeof url === 'string' && url.endsWith('/api/ps')) {
          return {
            ok: true,
            json: async () => ({
              models: [{ name: 'ax/gemma4:26b', context_length: 32768 }]
            })
          };
        }
        return {
          ok: true,
          text: async () => '{}'
        };
      });

      try {
        const result = await service.warmHost(hostUrl);
        expect(result[0].status).toBe('ok');
        const generateCalls = global.fetch.mock.calls.filter(
          c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
        );
        expect(generateCalls).toHaveLength(1);
        const payload = JSON.parse(generateCalls[0][1].body);
        expect(payload.model).toBe('gemma4:26b');
        expect(payload.stream).toBe(false);
        expect(payload.options).toEqual({ num_predict: 1, num_ctx: 65536 });
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('warmHost refreshes a loaded infinite pin that only has a short TTL', async () => {
      const originalFetch = global.fetch;
      const hostUrl = 'http://ttl-mismatch-host:11434';
      await HostPreference.create({
        hostUrl,
        hostKey: 'secondary',
        pinnedModels: [{ model: 'nomic-embed-text:v1.5', keepAlive: -1 }],
        status: 'ready'
      });

      global.fetch = jest.fn(async (url) => {
        if (typeof url === 'string' && url.endsWith('/api/ps')) {
          return {
            ok: true,
            json: async () => ({
              models: [{
                name: 'nomic-embed-text:v1.5',
                expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
              }]
            })
          };
        }
        return {
          ok: true,
          text: async () => JSON.stringify({ embedding: [0] })
        };
      });

      try {
        const result = await service.warmHost(hostUrl);
        expect(result[0].status).toBe('ok');
        const embeddingCalls = global.fetch.mock.calls.filter(
          c => typeof c[0] === 'string' && c[0].endsWith('/api/embeddings')
        );
        expect(embeddingCalls).toHaveLength(1);
        expect(JSON.parse(embeddingCalls[0][1].body)).toMatchObject({
          model: 'nomic-embed-text:v1.5',
          keep_alive: -1
        });
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('restorePinnedModels does not skip a stale restoring state when the pin is absent', async () => {
      const originalFetch = global.fetch;
      const hostUrl = 'http://stale-restore-host:11434';
      await HostPreference.create({
        hostUrl,
        hostKey: 'primary',
        pinnedModels: [{ model: 'gemma4:26b', keepAlive: -1, contextSize: 65536 }],
        status: 'restoring'
      });

      let psCalls = 0;
      global.fetch = jest.fn(async (url) => {
        if (typeof url === 'string' && url.endsWith('/api/ps')) {
          psCalls += 1;
          return {
            ok: true,
            json: async () => ({
              models: psCalls === 1 ? [] : [{ name: 'gemma4:26b', context_length: 65536 }]
            })
          };
        }
        return {
          ok: true,
          text: async () => '{}'
        };
      });

      try {
        const result = await service.restorePinnedModels(hostUrl);
        expect(result.status).toBe('ready');
        expect(result.verified).toBe(true);
        const generateCalls = global.fetch.mock.calls.filter(
          c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
        );
        expect(generateCalls).toHaveLength(1);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('emits safe observability when a pin restore fails', async () => {
      const hostUrl = 'http://no-pin-host:11434';
      mockObservePinRestoreFailure.mockClear();
      await HostPreference.create({ hostUrl, hostKey: 'secondary', pinnedModels: [] });

      const result = await service.restorePinnedModels(hostUrl);

      expect(result).toEqual(expect.objectContaining({ status: 'error' }));
      expect(mockObservePinRestoreFailure).toHaveBeenCalledWith(expect.objectContaining({
        host: hostUrl,
        source: 'host-preference-service'
      }));
    });
  });

  describe('legacy-doc fallback (pre-0151 shape)', () => {
    // Ensures a doc written in the pre-0151 shape still resolves pinned
    // entries correctly. Simulates the migration not having run yet.
    it('merges defaultModels + pinnedModel into pinned entries', async () => {
      // Insert raw via driver so we bypass mongoose schema field mapping
      await HostPreference.collection.insertOne({
        hostUrl: 'http://legacy:11434',
        hostKey: 'primary',
        defaultModels: ['m-default'],
        pinnedModel: 'm-pin',
        keepAlive: 300,
        contextSize: 8192,
        autoRestore: true,
        status: 'idle'
      });

      const pref = await service.getByHost('http://legacy:11434');
      const entries = service.getPinnedEntries(pref);
      expect(entries.length).toBe(2);
      // pinnedModel comes first (that's the priority in the fallback)
      expect(entries[0].model).toBe('m-pin');
      expect(entries[0].keepAlive).toBe(-1); // pinnedModel semantics
      expect(entries[1].model).toBe('m-default');
      expect(entries[1].keepAlive).toBe(300);
      expect(entries[1].contextSize).toBe(8192);
    });
  });

  describe('pinning', () => {
    const HOST_URL = 'http://host1:11434';

    beforeEach(async () => {
      await HostPreference.create({
        hostUrl: HOST_URL,
        hostKey: 'primary',
        pinnedModels: [],
        status: 'idle'
      });
    });

    describe('setPinnedModel', () => {
      it('should set pinnedModels and status on host preference', async () => {
        const result = await service.setPinnedModel(HOST_URL, 'gemma4:26b');
        expect(service.getPinnedModelNames(result)).toEqual(['gemma4:26b']);
        expect(result.status).toBe('restoring');
      });

      it('should set status to ready if model is already loaded', async () => {
        await HostPreference.findOneAndUpdate({ hostUrl: HOST_URL }, { loadedModel: 'gemma4:26b' });
        const result = await service.setPinnedModel(HOST_URL, 'gemma4:26b');
        expect(service.getPrimaryPinnedModel(result)).toBe('gemma4:26b');
        expect(result.status).toBe('ready');
      });
    });

    describe('clearPinnedModel', () => {
      it('should empty pinnedModels and set status to idle', async () => {
        await HostPreference.findOneAndUpdate({ hostUrl: HOST_URL }, { pinnedModels: [{ model: 'gemma4:26b' }], status: 'ready' });
        const result = await service.clearPinnedModel(HOST_URL);
        expect(result.pinnedModels).toEqual([]);
        expect(result.status).toBe('idle');
      });
    });

    describe('addPinnedModel / removePinnedModel', () => {
      it('should append a new entry without overwriting existing entries', async () => {
        await service.setPinnedModel(HOST_URL, 'first');
        const after = await service.addPinnedModel(HOST_URL, 'second', { keepAlive: 300 });
        const names = service.getPinnedModelNames(after);
        expect(names).toContain('first');
        expect(names).toContain('second');
      });

      it('should be idempotent when adding an already-pinned model', async () => {
        await service.setPinnedModel(HOST_URL, 'only');
        await service.addPinnedModel(HOST_URL, 'only');
        const pref = await service.getByHost(HOST_URL);
        expect(service.getPinnedModelNames(pref)).toEqual(['only']);
      });

      it('should remove an entry by model name', async () => {
        await service.setPinnedModel(HOST_URL, 'a');
        await service.addPinnedModel(HOST_URL, 'b');
        const after = await service.removePinnedModel(HOST_URL, 'a');
        expect(service.getPinnedModelNames(after)).toEqual(['b']);
      });
    });

    describe('getPinStatus', () => {
      it('should return pin status for a host', async () => {
        await HostPreference.findOneAndUpdate({ hostUrl: HOST_URL }, {
          pinnedModels: [{ model: 'gemma4:26b', autoRestore: true }],
          loadedModel: 'gemma4:26b',
          status: 'ready'
        });
        const status = await service.getPinStatus(HOST_URL);
        expect(status.loadedModel).toBe('gemma4:26b');
        expect(status.status).toBe('ready');
        expect(status.pinnedModels).toHaveLength(1);
        expect(status.pinnedModels[0].model).toBe('gemma4:26b');
        expect(status.pinnedModels[0].autoRestore).toBe(true);
      });

      it('should return empty pinnedModels when no entries configured', async () => {
        const status = await service.getPinStatus(HOST_URL);
        expect(status.pinnedModels).toEqual([]);
        expect(status.status).toBe('idle');
      });
    });

    describe('updateLoadedModel', () => {
      it('should update loadedModel and set status to ready if it matches primary pin', async () => {
        await HostPreference.findOneAndUpdate({ hostUrl: HOST_URL }, {
          pinnedModels: [{ model: 'gemma4:26b' }],
          status: 'restoring'
        });
        const result = await service.updateLoadedModel(HOST_URL, 'gemma4:26b');
        expect(result.loadedModel).toBe('gemma4:26b');
        expect(result.status).toBe('ready');
      });

      it('should keep status as-is if loaded model does not match pin', async () => {
        await HostPreference.findOneAndUpdate({ hostUrl: HOST_URL }, {
          pinnedModels: [{ model: 'gemma4:26b' }],
          status: 'ready'
        });
        const result = await service.updateLoadedModel(HOST_URL, 'qwen3-coder:30b');
        expect(result.loadedModel).toBe('qwen3-coder:30b');
      });
    });
  });

  // Task 0183 — claim-lifecycle describes (claimBenchmark / releaseBenchmarkClaim /
  // claim-respecting pin paths / listBenchmarkClaims) were moved to
  // tests/unit/benchmarkClaimService.test.js when the lifecycle was extracted
  // out of hostPreferenceService.

  // Task 0176 — pin auto-restore grace period.
  //
  // The reconciler used to warm the pin on the very first tick that observed
  // a displacement. With 0176 it stamps `pinFirstDisplacedAt` and waits for
  // `PIN_RESTORE_GRACE_MS` (default 120s) to elapse before warming. Tests
  // drive the grace window to small ms-level values via setPinRestoreGraceMs
  // so the four timing scenarios run in-memory.
  //
  // The host is unreachable in tests (port 11434 has no listener), so
  // `fetch` is mocked per-test to return a controlled `/api/ps` payload.
  describe('pin auto-restore grace period (0176)', () => {
    const HOST_URL = 'http://grace-host:11434';
    const PIN_MODEL = 'gemma4:26b';
    const OTHER_MODEL = 'qwen3.6:27b';
    const originalFetch = global.fetch;
    const originalGrace = service.getPinRestoreGraceMs();

    function mockPs(loadedModelNames) {
      // Returns a stub /api/ps response with the given loaded models.
      // Anything else fails (we don't want the warm path to actually fire
      // a real warmDefaultModel that hits a port).
      global.fetch = jest.fn(async (url) => {
        if (typeof url === 'string' && url.endsWith('/api/ps')) {
          return {
            ok: true,
            json: async () => ({
              models: loadedModelNames.map(name => (typeof name === 'string' ? { name } : name))
            })
          };
        }
        // /api/generate (warmup) — return ok so the reconciler thinks the
        // warm succeeded and clears the grace stamp.
        return {
          ok: true,
          text: async () => '{}'
        };
      });
    }

    beforeEach(async () => {
      await HostPreference.create({
        hostUrl: HOST_URL,
        hostKey: 'primary',
        pinnedModels: [{ model: PIN_MODEL, autoRestore: true, keepAlive: -1 }],
        status: 'ready'
      });
    });

    afterEach(() => {
      global.fetch = originalFetch;
      service.setPinRestoreGraceMs(originalGrace);
    });

    it('scenario 1 — pin loaded: no grace stamp, no warm', async () => {
      service.setPinRestoreGraceMs(60_000);
      mockPs([PIN_MODEL]);
      await service.checkAndReloadDefaults();
      const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      expect(after.pinFirstDisplacedAt).toBeFalsy();
      // Status should be 'ready' since the pin is loaded
      expect(after.status).toBe('ready');
    });

    it('scenario 2 — pin first displaced: stamps pinFirstDisplacedAt, no warm', async () => {
      service.setPinRestoreGraceMs(60_000);
      mockPs([OTHER_MODEL]);
      const before = Date.now();
      await service.checkAndReloadDefaults();
      const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      expect(after.pinFirstDisplacedAt).toBeTruthy();
      const stampedAt = new Date(after.pinFirstDisplacedAt).getTime();
      expect(stampedAt).toBeGreaterThanOrEqual(before - 100);
      expect(stampedAt).toBeLessThanOrEqual(Date.now() + 100);
      // Status must NOT have flipped to 'restoring' — we're still in grace
      expect(after.status).not.toBe('restoring');
      // Pin was not warmed — the only fetch call should be /api/ps
      const generateCalls = global.fetch.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
      );
      expect(generateCalls).toHaveLength(0);
    });

    it('scenario 3 — pin still in grace: no warm, stamp preserved', async () => {
      service.setPinRestoreGraceMs(60_000);
      // Pre-stamp a recent displacement (5s ago — well within 60s grace)
      const stampedAt = new Date(Date.now() - 5_000);
      await HostPreference.findOneAndUpdate(
        { hostUrl: HOST_URL },
        { $set: { pinFirstDisplacedAt: stampedAt } }
      );
      mockPs([OTHER_MODEL]);
      await service.checkAndReloadDefaults();
      const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      // Stamp must be preserved — the same value we stamped
      expect(after.pinFirstDisplacedAt).toBeTruthy();
      expect(new Date(after.pinFirstDisplacedAt).getTime()).toBe(stampedAt.getTime());
      // No warm call
      const generateCalls = global.fetch.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
      );
      expect(generateCalls).toHaveLength(0);
    });

    it('scenario 4 — pin grace elapsed: warms and clears the stamp', async () => {
      service.setPinRestoreGraceMs(50);
      // Pre-stamp a displacement 1s ago — far past the 50ms grace
      await HostPreference.findOneAndUpdate(
        { hostUrl: HOST_URL },
        { $set: { pinFirstDisplacedAt: new Date(Date.now() - 1_000) } }
      );
      mockPs([OTHER_MODEL]);
      await service.checkAndReloadDefaults();
      const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      // Warm fired — there should be a /api/generate call
      const generateCalls = global.fetch.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
      );
      expect(generateCalls.length).toBeGreaterThanOrEqual(1);
      // Stamp must have been cleared after the successful warm
      expect(after.pinFirstDisplacedAt).toBeFalsy();
    });

    it('clears stamp when displacement resolves before grace elapses', async () => {
      service.setPinRestoreGraceMs(60_000);
      // Pre-stamp a displacement (e.g. from a prior tick)
      await HostPreference.findOneAndUpdate(
        { hostUrl: HOST_URL },
        { $set: { pinFirstDisplacedAt: new Date(Date.now() - 5_000) } }
      );
      // Pin is back this tick (someone reloaded it externally)
      mockPs([PIN_MODEL]);
      await service.checkAndReloadDefaults();
      const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      expect(after.pinFirstDisplacedAt).toBeFalsy();
    });

    it('claim short-circuits before the grace check fires (defense in depth)', async () => {
      service.setPinRestoreGraceMs(50);
      // Active claim — reconciler must skip BEFORE touching the grace
      // logic, even though the grace would otherwise have fired.
      await HostPreference.findOneAndUpdate(
        { hostUrl: HOST_URL },
        {
          $set: {
            status: 'benchmarking',
            benchmarkClaim: {
              batchId: 'batch-x',
              prevStatus: 'ready',
              claimedAt: new Date(),
              estimatedDurationMs: 60_000
            }
          }
        }
      );
      mockPs([OTHER_MODEL]);
      await service.checkAndReloadDefaults();
      const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      // Grace stamp must NOT have been set — claim short-circuited first
      expect(after.pinFirstDisplacedAt).toBeFalsy();
      // No warm call
      const generateCalls = global.fetch.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
      );
      expect(generateCalls).toHaveLength(0);
      // Status remained 'benchmarking'
      expect(after.status).toBe('benchmarking');
    });

    it('treats a loaded pin with the wrong context as displaced', async () => {
      service.setPinRestoreGraceMs(60_000);
      await HostPreference.findOneAndUpdate(
        { hostUrl: HOST_URL },
        {
          $set: {
            pinnedModels: [{ model: PIN_MODEL, autoRestore: true, keepAlive: -1, contextSize: 65536 }]
          }
        }
      );

      mockPs([{ name: PIN_MODEL, context_length: 32768 }]);
      await service.checkAndReloadDefaults();
      const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      expect(after.pinFirstDisplacedAt).toBeTruthy();

      const generateCalls = global.fetch.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
      );
      expect(generateCalls).toHaveLength(0);
    });
  });

  describe('loadedModels array (multi-model hosts)', () => {
    const HOST_URL = 'http://multi-host:11434';

    it('getPinStatus falls back to scalar loadedModel when array is empty', async () => {
      await HostPreference.create({
        hostUrl: HOST_URL,
        hostKey: 'primary',
        pinnedModels: [{ model: 'qwen2.5:7b' }],
        loadedModel: 'qwen2.5:7b'
        // loadedModels omitted → default []
      });
      const status = await service.getPinStatus(HOST_URL);
      expect(status.loadedModel).toBe('qwen2.5:7b');
      expect(status.loadedModels).toEqual(['qwen2.5:7b']);
    });

    it('getPinStatus returns the full loadedModels array when set', async () => {
      await HostPreference.create({
        hostUrl: HOST_URL,
        hostKey: 'primary',
        pinnedModels: [{ model: 'qwen2.5:7b' }, { model: 'nomic-embed-text:v1.5' }],
        loadedModel: 'qwen2.5:7b',
        loadedModels: ['qwen2.5:7b', 'nomic-embed-text:v1.5']
      });
      const status = await service.getPinStatus(HOST_URL);
      expect(status.loadedModels).toEqual(['qwen2.5:7b', 'nomic-embed-text:v1.5']);
    });

    it('persists loadedModels as an array of strings', async () => {
      const doc = await HostPreference.create({
        hostUrl: HOST_URL,
        hostKey: 'primary',
        pinnedModels: [],
        loadedModels: ['a', 'b', 'c']
      });
      const round = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      expect(round.loadedModels).toEqual(['a', 'b', 'c']);
      expect(doc.loadedModels.length).toBe(3);
    });
  });

  describe('warmDefaultModel embedding pins (0508)', () => {
    const HOST_URL = 'http://embed-host:11434';

    afterEach(() => {
      if (global.fetch && global.fetch.mockRestore) global.fetch.mockRestore();
    });

    it('warms a bge pin via the embeddings endpoint, never generate', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => '{}' });
      const result = await service.warmDefaultModel(HOST_URL, 'qllama/bge-m3:f16', { keepAlive: -1, contextSize: 0 });
      expect(result.status).toBe('ok');
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = global.fetch.mock.calls[0];
      expect(url).toBe(`${HOST_URL}/api/embeddings`);
      expect(url).not.toContain('/api/generate');
      const payload = JSON.parse(init.body);
      expect(payload.model).toBe('qllama/bge-m3:f16');
      // 0508: keep_alive -1 must pass through so the pin actually sticks
      // instead of expiring on Ollama's 5-minute default.
      expect(payload.keep_alive).toBe(-1);
    });

    it('keeps the seconds-string form for positive embedding keep-alives', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => '{}' });
      await service.warmDefaultModel(HOST_URL, 'nomic-embed-text:v1.5', { keepAlive: 31536000 });
      const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(payload.keep_alive).toBe('31536000s');
    });

    it('still warms generative models via generate with raw keep_alive', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => '{}' });
      await service.warmDefaultModel(HOST_URL, 'ax/gemma4:26b-a4b-it-qat', { keepAlive: -1, contextSize: 83558 });
      const [url, init] = global.fetch.mock.calls[0];
      expect(url).toBe(`${HOST_URL}/api/generate`);
      const payload = JSON.parse(init.body);
      expect(payload.keep_alive).toBe(-1);
      expect(payload.options.num_ctx).toBe(83558);
    });
  });
});
