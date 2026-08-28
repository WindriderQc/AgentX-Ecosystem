'use strict';

const {
  buildIntakeRecord,
  scanIntake,
  gatherCandidates,
  formatIntakeTable
} = require('../../../src/services/benchmark/intakeScanner');

const TEST_HOSTS_VRAM = { small: 12288, medium: 16303, large: 49152 };

describe('buildIntakeRecord', () => {
  it('builds a full candidate-intake record reusing the fit math', () => {
    const rec = buildIntakeRecord(
      { id: 'qwen2.5:7b-instruct-q5_K_M', downloads: 250000 },
      { hostsVram: TEST_HOSTS_VRAM, numCtx: 8192 }
    );
    expect(rec).toMatchObject({
      model: 'qwen2.5:7b-instruct-q5_K_M',
      source: 'huggingface:qwen2.5:7b-instruct-q5_K_M',
      params: 7,
      moe: false,
      expectedLane: null,
      profileStatus: 'pending',
      benchmarkStatus: 'pending',
      decision: 'pending'
    });
    expect(rec.suggestedHost).toBe('small');
    expect(rec.vramFitByHost.small).toBeTruthy();
    expect(rec.priority).toBe('high');
  });

  it('detects MoE active params and uses them for fit', () => {
    const rec = buildIntakeRecord(
      { id: 'qwen3.6:35b-a3b-q4_K_M', downloads: 5000 },
      { hostsVram: TEST_HOSTS_VRAM, numCtx: 8192 }
    );
    expect(rec.moe).toBe(true);
    expect(rec.activeParams).toBe(3);
    expect(rec.params).toBe(35);
    // 3B active fits even the small host.
    expect(rec.suggestedHost).toBe('small');
  });

  it('marks a model that fits no host as low priority with null host', () => {
    const rec = buildIntakeRecord(
      { id: 'behemoth:180b-q8_0', downloads: 999999 },
      { hostsVram: TEST_HOSTS_VRAM, numCtx: 8192 }
    );
    expect(rec.suggestedHost).toBeNull();
    expect(rec.priority).toBe('low'); // popularity cannot save an un-fittable model
  });

  it('falls back to a hosts override', () => {
    const rec = buildIntakeRecord({ id: 'qwen:32b-q4_K_M' }, { hostsVram: { only: 49152 }, numCtx: 8192 });
    expect(rec.suggestedHost).toBe('only');
  });
});

describe('scanIntake', () => {
  it('sorts records by priority (high → low)', () => {
    const out = scanIntake({
      models: [
        { id: 'small-niche:7b-q4_K_M', downloads: 10 },        // low
        { id: 'popular:8b-q4_K_M', downloads: 500000 },        // high
        { id: 'midpop:9b-q4_K_M', downloads: 20000 }           // medium
      ]
    });
    expect(out.map((r) => r.priority)).toEqual(['high', 'medium', 'low']);
  });
});

describe('gatherCandidates', () => {
  it('fetches across families with an injected fetch, dedups, and prioritizes', async () => {
    const fetchFamily = jest.fn(async (family) => {
      if (family === 'qwen') return [{ id: 'qwen:7b-q4_K_M', downloads: 500000 }, { id: 'dup:8b-q4_K_M', downloads: 5 }];
      if (family === 'gemma') return [{ id: 'gemma:2b-q4_K_M', downloads: 40000 }, { id: 'dup:8b-q4_K_M', downloads: 5 }];
      return [];
    });
    const records = await gatherCandidates({ families: ['qwen', 'gemma'], limit: 5, fetchFamily });
    expect(fetchFamily).toHaveBeenCalledTimes(2);
    expect(records.map((r) => r.model)).toEqual(['qwen:7b-q4_K_M', 'gemma:2b-q4_K_M', 'dup:8b-q4_K_M']); // deduped + priority sorted
  });

  it('skips a family whose fetch fails and still returns the rest', async () => {
    const warns = [];
    const fetchFamily = jest.fn(async (family) => {
      if (family === 'bad') throw new Error('network down');
      return [{ id: 'ok:7b-q4_K_M', downloads: 100 }];
    });
    const records = await gatherCandidates({ families: ['bad', 'good'], fetchFamily, onWarn: (m) => warns.push(m) });
    expect(records.map((r) => r.model)).toEqual(['ok:7b-q4_K_M']);
    expect(warns[0]).toMatch(/network down/);
  });

  it('throws without a fetch dependency', async () => {
    await expect(gatherCandidates({ families: ['x'] })).rejects.toThrow(/fetchFamily/);
  });
});

describe('formatIntakeTable', () => {
  it('renders a markdown table with the key columns', () => {
    const md = formatIntakeTable(scanIntake({ models: [{ id: 'gemma2:9b-q4_K_M', downloads: 200000 }] }));
    expect(md).toMatch(/\| Priority \| Model \| Lane \| Host \|/);
    expect(md).toMatch(/`gemma2:9b-q4_K_M`/);
    expect(md).toMatch(/\| — \| — \|/);
  });
});
