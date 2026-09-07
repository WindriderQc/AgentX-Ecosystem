process.env.AGENTX_PROFILE = 'demo';
const { startTestHttpHarness } = require('../helpers/testHttpServer');

jest.mock('../../src/services/runtimeCoordinationService', () => ({
  ...jest.requireActual('../../src/services/runtimeCoordinationService'),
  acquireWorkload: jest.fn(async () => ({ acquired: true, admissionId: 'demo-admission' }))
}));
const coordination = require('../../src/services/runtimeCoordinationService');
const { app } = require('../../src/app');

describe('default demo supports Benchmark without operator controls', () => {
  let http;
  beforeAll(async () => {
    http = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
  });
  afterAll(async () => { await http?.close(); });

  test('dispatches a Benchmark reservation to the existing Core owner', async () => {
    const body = {
      requestId: 'benchmark:demo-run', workloadId: 'demo-run', kind: 'benchmark',
      batchId: 'demo-run', hosts: ['http://127.0.0.1:11434'], ttlMs: 60000
    };
    const response = await http.request.post('/api/nerve-center/workload-admissions').send(body);
    expect(response.status).toBe(200);
    expect(response.body.data.acquired).toBe(true);
    expect(coordination.acquireWorkload).toHaveBeenCalledWith(expect.objectContaining({
      workloadId: 'demo-run', kind: 'benchmark', hosts: body.hosts, ttl: 60000
    }));
  });

  test.each(['/api/nerve-center/ecosystem', '/api/nerve-center/routing', '/nerve-center'])
  ('keeps the operator surface hidden: %s', async path => {
    const response = await http.request.get(path);
    expect(response.status).toBe(404);
  });

  test('still rejects manual host swaps', async () => {
    const host = encodeURIComponent('http://127.0.0.1:11434');
    const response = await http.request.post(`/api/nerve-center/host-preferences/${host}/swap`).send({});
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('AGENTX_DEMO_SURFACE_DISABLED');
  });
});
