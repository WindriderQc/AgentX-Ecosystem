const {
  createCorePublicUrlsResolver,
  getPublicUrls,
  mergePublicUrls,
} = require('../../../shared/browserPublicUrls');

describe('browser public URL authority', () => {
  test('normalizes explicit environment values and standalone defaults', () => {
    expect(getPublicUrls({
      CORE_PUBLIC_URL: 'https://core.example/',
      BENCHMARK_PUBLIC_URL: 'http://bench.example:8444///',
    })).toEqual({
      core: 'https://core.example',
      benchmark: 'http://bench.example:8444',
      rag: 'http://localhost:3082',
    });
  });

  test('Core publicUrls replace standalone fallbacks without erasing missing values', () => {
    expect(mergePublicUrls(
      { core: 'http://localhost:3080', benchmark: 'http://localhost:3081' },
      { core: 'https://core.example/', benchmark: 'http://bench.example:8444/' }
    )).toMatchObject({
      core: 'https://core.example',
      benchmark: 'http://bench.example:8444',
      rag: 'http://localhost:3082',
    });
  });

  test('composed services resolve the canonical contract from Core config', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        publicUrls: {
          core: 'https://192.0.2.99/',
          benchmark: 'http://bench.lan:4081/',
          rag: 'http://rag.lan:4082/',
        },
      }),
    });
    const resolve = createCorePublicUrlsResolver({
      coreServiceUrl: 'http://core:3080/',
      fetchImpl,
      env: {},
    });

    await expect(resolve()).resolves.toMatchObject({
      core: 'https://192.0.2.99',
      benchmark: 'http://bench.lan:4081',
      rag: 'http://rag.lan:4082',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://core:3080/api/config',
      expect.objectContaining({ headers: { Accept: 'application/json' } })
    );
  });
});
