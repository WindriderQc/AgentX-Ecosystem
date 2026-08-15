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

describe('read-only product ingestion contract', () => {
  it('publishes the bounded import policy without a host mount', async () => {
    const response = await request(buildApp()).get('/api/rag/ingestion/policy').expect(200);

    expect(response.body.data).toMatchObject({
      source: { containerRoot: '/data/imports', mountMode: 'none' },
      ingestion: {
        approvedRoots: ['/data/imports'],
        allowedExtensions: ['md', 'txt']
      }
    });
    expect(response.body.data).not.toHaveProperty('projection');
  });
});
