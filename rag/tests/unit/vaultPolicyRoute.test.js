jest.mock('mongoose', () => ({
  connection: { readyState: 1 },
  Schema: class { constructor() {} index() {} },
  model: jest.fn(() => ({ create: jest.fn().mockResolvedValue({}) }))
}));

jest.mock('../../src/services/ingestWorker', () => ({
  runIngestScan: jest.fn(),
  getConfiguredRoots: jest.fn().mockReturnValue(['/data/imports']),
  isPathUnderRoot: jest.fn(() => true)
}));

const express = require('express');
const request = require('supertest');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/rag', require('../../routes/rag'));
  return app;
}

describe('read-only product filesystem contract', () => {
  it('publishes the bounded import policy without a host mount', async () => {
    const response = await request(buildApp()).get('/api/rag/vault/policy').expect(200);

    expect(response.body.data).toMatchObject({
      vault: { containerRoot: '/data/imports', mountMode: 'none' },
      ingestion: {
        approvedRoots: ['/data/imports'],
        allowedExtensions: ['md', 'txt']
      },
      projection: { mode: 'disabled', writeToVault: false, direction: 'none' }
    });
  });

  it('keeps the legacy vault index endpoint disabled', async () => {
    const response = await request(buildApp()).get('/api/rag/vault/index').expect(200);

    expect(response.body.data.writeToVault).toBe(false);
    expect(response.body.data.mode).toBe('disabled');
    expect(response.body.data.entries).toEqual([]);
  });
});
