'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../../models/HostProfile', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/ModelProfile', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../src/services/profiler/modelPerformanceProfileService', () => ({
  getRoster: jest.fn(),
  getActiveProfile: jest.fn()
}));
jest.mock('../../../src/services/modelContextProfileService', () => ({
  findContextProfile: jest.fn()
}));

const HostProfile = require('../../../models/HostProfile');
const ModelProfile = require('../../../models/ModelProfile');
const contextProfiles = require('../../../src/services/modelContextProfileService');
const evidenceRouter = require('../../../routes/profiler/evidence');

function queryResult(value) {
  const query = {
    select: jest.fn(() => query),
    lean: jest.fn(async () => value)
  };
  return query;
}

function buildApp() {
  const app = express();
  app.use('/api/profiler/evidence', evidenceRouter);
  return app;
}

describe('profiler evidence ownership API', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns a compact readiness roster with serializable maps', async () => {
    ModelProfile.find.mockReturnValue(queryResult([
      { name: 'model-a', readiness: new Map([['host-a', { stage: 'profiled' }]]) }
    ]));

    const response = await request(buildApp())
      .get('/api/profiler/evidence/readiness')
      .expect(200);

    expect(response.body.data.profiles).toEqual([
      { name: 'model-a', readiness: { 'host-a': { stage: 'profiled' } } }
    ]);
  });

  it('returns host and capability evidence without exposing Benchmark models to Core', async () => {
    HostProfile.findOne.mockReturnValue(queryResult({
      hostId: 'host-a',
      hostUrl: 'http://host-a:11434',
      displayName: 'Host A'
    }));
    ModelProfile.findOne.mockReturnValue(queryResult({
      name: 'owner/model:8b',
      capabilities: { tools: true },
      readiness: new Map([['host-a', { stage: 'profiled' }]]),
      thinkingProfiles: new Map()
    }));

    const response = await request(buildApp())
      .get('/api/profiler/evidence/inference/owner%2Fmodel%3A8b')
      .query({ hostUrl: 'http://host-a:11434' })
      .expect(200);

    expect(response.body.data).toMatchObject({
      hostProfile: { hostId: 'host-a' },
      modelProfile: {
        name: 'owner/model:8b',
        capabilities: { tools: true },
        readiness: { 'host-a': { stage: 'profiled' } }
      }
    });
  });

  it('returns only the exact-artifact context profile selected by Benchmark', async () => {
    contextProfiles.findContextProfile.mockResolvedValue({ verifiedMaxContext: 65536 });

    const response = await request(buildApp())
      .get('/api/profiler/evidence/context/model-a')
      .query({
        hostUrl: 'http://host-a:11434',
        artifactDigest: 'sha256:a',
        runtimeFingerprint: 'runtime-a'
      })
      .expect(200);

    expect(response.body.data.contextProfile).toEqual({ verifiedMaxContext: 65536 });
    expect(contextProfiles.findContextProfile).toHaveBeenCalledWith(
      'model-a',
      'http://host-a:11434',
      { digest: 'sha256:a', runtimeFingerprint: 'runtime-a' }
    );
  });
});
