'use strict';

const { boundedConcurrency } = require('../../src/utils/boundedConcurrency');

describe('boundedConcurrency', () => {
  it('returns empty array for empty input', async () => {
    const result = await boundedConcurrency([], async (x) => x, 4);
    expect(result).toEqual([]);
  });

  it('returns empty array for non-array input', async () => {
    expect(await boundedConcurrency(null, async (x) => x, 4)).toEqual([]);
    expect(await boundedConcurrency(undefined, async (x) => x, 4)).toEqual([]);
  });

  it('preserves order regardless of completion time', async () => {
    const items = [100, 10, 50, 5, 30];
    const result = await boundedConcurrency(items, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return { ms, i };
    }, 2);
    expect(result.map((r) => r.i)).toEqual([0, 1, 2, 3, 4]);
    expect(result.map((r) => r.ms)).toEqual([100, 10, 50, 5, 30]);
  });

  it('caps concurrent executions at the limit', async () => {
    let inFlight = 0;
    let maxSeen = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await boundedConcurrency(items, async () => {
      inFlight++;
      maxSeen = Math.max(maxSeen, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
    }, 3);
    expect(maxSeen).toBeLessThanOrEqual(3);
    expect(maxSeen).toBeGreaterThan(0);
  });

  it('clamps limit to at least 1', async () => {
    const result = await boundedConcurrency([1, 2, 3], async (x) => x * 2, 0);
    expect(result).toEqual([2, 4, 6]);
  });

  it('clamps limit to array length (no empty workers)', async () => {
    const result = await boundedConcurrency([1, 2], async (x) => x * 3, 100);
    expect(result).toEqual([3, 6]);
  });

  it('propagates task rejections', async () => {
    const items = [1, 2, 3];
    await expect(
      boundedConcurrency(items, async (x) => {
        if (x === 2) throw new Error('boom');
        return x;
      }, 2)
    ).rejects.toThrow('boom');
  });
});
