'use strict';

const express = require('express');
const { startTestHttpHarness } = require('../../helpers/testHttpServer');

jest.mock('../../../models/HostProfile', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/ModelProfile', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/ModelPerformanceProfile', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../src/services/profiler/modelPerformanceProfileService', () => ({
  getRoster: jest.fn(),
  getActiveProfile: jest.fn()
}));
jest.mock('../../../src/services/modelContextProfileService', () => ({
  findContextProfile: jest.fn()
}));
jest.mock('../../../src/services/qualification/toolCapabilityQualificationService', () => ({
  QUALIFICATION_SCHEMA_VERSION: 'agentx.tool-capability-qualification.v1',
  currentEvidenceContract: jest.fn(() => ({
    schemaVersion: 'agentx.tool-capability-qualification.v1',
    protocolVersion: 'ollama.chat.native-tools.v1',
    fixtureVersion: 'toolcall-fixtures.v1',
    fixtureFingerprint: 'fixture-a'
  })),
  resolveQualification: jest.fn()
}));
jest.mock('../../../src/services/profiler/profilerAuthorityReceipt', () => ({
  RECEIPT_VERSION: 2,
  verifyProfilerAuthorityReceipt: jest.fn(() => true)
}));
jest.mock('../../../src/services/profiler/artifactIdentityService', () => ({
  identitiesMatch: jest.fn(() => true),
  resolveArtifactIdentity: jest.fn(async (model, hostId, hostUrl) => ({
    model,
    hostId,
    hostUrl,
    digest: 'sha256:live',
    runtimeFingerprint: 'runtime-live',
    registryQualified: true
  }))
}));

const HostProfile = require('../../../models/HostProfile');
const ModelProfile = require('../../../models/ModelProfile');
const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');
const { verifyProfilerAuthorityReceipt } = require('../../../src/services/profiler/profilerAuthorityReceipt');
const { resolveArtifactIdentity } = require('../../../src/services/profiler/artifactIdentityService');
const contextProfiles = require('../../../src/services/modelContextProfileService');
const toolQualifications = require('../../../src/services/qualification/toolCapabilityQualificationService');
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

let httpHarness;
let api;

beforeAll(async () => {
  httpHarness = await startTestHttpHarness(buildApp());
  api = httpHarness.request;
});

afterAll(async () => {
  await httpHarness?.close();
});

describe('profiler evidence ownership API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    verifyProfilerAuthorityReceipt.mockReturnValue(true);
  });

  it('returns a compact readiness roster with serializable maps', async () => {
    ModelProfile.find.mockReturnValue(queryResult([
      {
        name: 'model-a',
        readiness: new Map([['host-a', {
          stage: 'profiled',
          profileDepth: 'standard',
          benchmarkQualified: true,
          evidenceId: 'evidence-a',
          artifact: { hostUrl: 'http://host-a:11434' }
        }]])
      }
    ]));
    ModelPerformanceProfile.find.mockReturnValue(queryResult([
      { _id: 'evidence-a', artifact: { digest: 'sha256:live' }, profile: { benchmarkQualified: true } }
    ]));

    const response = await api
      .get('/api/profiler/evidence/readiness')
      .expect(200);

    expect(response.body.data.profiles[0]).toMatchObject({
      name: 'model-a',
      readiness: {
        'host-a': {
          stage: 'profiled',
          benchmarkQualified: true,
          stale: false,
          authorityVerified: true,
          authority: {
            contract: 'agentx.profiler-readiness/v2',
            receiptVersion: 2,
            receiptVerified: true,
            liveIdentityVerified: true,
            evidenceQualified: true,
            verified: true
          }
        }
      }
    });
    expect(resolveArtifactIdentity).toHaveBeenCalledWith(
      'model-a',
      'host-a',
      'http://host-a:11434',
      { refresh: true }
    );
  });

  it('fails readiness closed when the v2 receipt or live artifact identity is not verified', async () => {
    ModelProfile.find.mockReturnValue(queryResult([{
      name: 'model-a',
      readiness: new Map([['host-a', {
        stage: 'benchmarked',
        profileDepth: 'full',
        benchmarkQualified: true,
        evidenceId: 'evidence-a',
        artifact: { hostUrl: 'http://host-a:11434' }
      }]])
    }]));
    ModelPerformanceProfile.find.mockReturnValue(queryResult([
      { _id: 'evidence-a', artifact: {}, profile: { benchmarkQualified: true } }
    ]));
    verifyProfilerAuthorityReceipt.mockReturnValue(false);

    const response = await api.get('/api/profiler/evidence/readiness').expect(200);
    expect(response.body.data.profiles[0].readiness['host-a']).toMatchObject({
      benchmarkQualified: false,
      stale: true,
      staleReason: 'authority_receipt_invalid',
      authorityVerified: false,
      authority: { verified: false, reason: 'authority_receipt_invalid' }
    });
    expect(resolveArtifactIdentity).not.toHaveBeenCalled();
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
      readiness: new Map([['host-a', {
        stage: 'profiled',
        profileDepth: 'standard',
        benchmarkQualified: true,
        evidenceId: 'evidence-a',
        artifact: { hostUrl: 'http://host-a:11434' }
      }]]),
      thinkingProfiles: new Map()
    }));
    ModelPerformanceProfile.findOne.mockReturnValue(queryResult({
      _id: 'evidence-a',
      artifact: { digest: 'sha256:live' },
      profile: { benchmarkQualified: true }
    }));

    const response = await api
      .get('/api/profiler/evidence/inference/owner%2Fmodel%3A8b')
      .query({ hostUrl: 'http://host-a:11434' })
      .expect(200);

    expect(response.body.data).toMatchObject({
      hostProfile: { hostId: 'host-a' },
      modelProfile: {
        name: 'owner/model:8b',
        capabilities: { tools: true },
        readiness: {
          'host-a': {
            stage: 'profiled',
            authorityVerified: true,
            authority: { contract: 'agentx.profiler-readiness/v2', verified: true }
          }
        }
      },
      toolQualification: {
        state: 'unknown',
        supported: null,
        qualified: false,
        reasons: ['artifact_identity_required']
      }
    });
    expect(toolQualifications.resolveQualification).not.toHaveBeenCalled();
  });

  it('returns only the exact-artifact tool qualification selected by Benchmark', async () => {
    HostProfile.findOne.mockReturnValue(queryResult({
      hostId: 'host-a',
      hostUrl: 'http://host-a:11434'
    }));
    ModelProfile.findOne.mockReturnValue(queryResult(null));
    toolQualifications.resolveQualification.mockResolvedValue({
      contract: 'agentx.tool-capability-qualification.v1',
      state: 'supported',
      supported: true,
      qualified: true,
      reasons: [],
      evidence: { campaignId: 'campaign-a', artifactDigest: 'sha256:a' }
    });

    const response = await api
      .get('/api/profiler/evidence/inference/owner%2Fmodel%3A8b')
      .query({
        hostUrl: 'http://host-a:11434',
        hostId: 'host-a',
        artifactDigest: 'sha256:a',
        runtimeFingerprint: 'runtime-a'
      })
      .expect(200);

    expect(toolQualifications.resolveQualification).toHaveBeenCalledWith({
      modelName: 'owner/model:8b',
      hostUrl: 'http://host-a:11434',
      hostId: 'host-a',
      artifactDigest: 'sha256:a',
      runtimeFingerprint: 'runtime-a'
    });
    expect(response.body.data.toolQualification).toMatchObject({
      state: 'supported',
      supported: true,
      evidence: { campaignId: 'campaign-a' }
    });
  });

  it('returns only the exact-artifact context profile selected by Benchmark', async () => {
    contextProfiles.findContextProfile.mockResolvedValue({ verifiedMaxContext: 65536 });

    const response = await api
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
