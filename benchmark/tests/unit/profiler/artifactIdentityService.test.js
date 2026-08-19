'use strict';

jest.mock('../../../src/clients/coreApiClient', () => ({ getModelRegistryByName: jest.fn() }));
jest.mock('../../../src/services/benchmark/modelDigestService', () => ({ getModelDigest: jest.fn() }));
jest.mock('../../../src/services/profiler/hostProfileService', () => ({ getById: jest.fn() }));

const { getModelRegistryByName } = require('../../../src/clients/coreApiClient');
const { getModelDigest } = require('../../../src/services/benchmark/modelDigestService');
const hostProfiles = require('../../../src/services/profiler/hostProfileService');
const { resolveArtifactIdentity } = require('../../../src/services/profiler/artifactIdentityService');

const HOST_URL = 'http://host-a:11434';

describe('profiler artifact identity service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getModelDigest.mockResolvedValue('sha256:exact');
    hostProfiles.getById.mockResolvedValue({
      hostId: 'host-a',
      hostUrl: HOST_URL,
      gpu: { model: 'GPU', vramTotalMiB: 24576 },
      ollama: { version: '1.0.0', backend: 'cuda' }
    });
    getModelRegistryByName.mockResolvedValue({
      _id: 'registry-a',
      modelName: 'owner/model:8b-q4',
      installations: [{
        hostUrl: HOST_URL,
        digest: 'sha256:exact',
        status: 'active',
        isActive: true
      }]
    });
  });

  it('qualifies the exact tag against the host installation digest', async () => {
    const identity = await resolveArtifactIdentity('owner/model:8b-q4', 'host-a', `${HOST_URL}/`);
    expect(getModelRegistryByName).toHaveBeenCalledWith('owner/model:8b-q4', { host: HOST_URL });
    expect(identity).toMatchObject({
      model: 'owner/model:8b-q4',
      hostId: 'host-a',
      hostUrl: HOST_URL,
      digest: 'sha256:exact',
      registryDigest: 'sha256:exact',
      registryQualified: true
    });
    expect(identity.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not borrow registry identity from a different namespace', async () => {
    getModelRegistryByName.mockResolvedValue({
      modelName: 'ax/owner/model:8b-q4',
      installations: [{ hostUrl: HOST_URL, digest: 'sha256:exact', isActive: true }]
    });

    await expect(resolveArtifactIdentity('owner/model:8b-q4', 'host-a', HOST_URL))
      .rejects.toThrow(/registry is missing or stale/i);
  });

  it('rejects registry digest drift', async () => {
    getModelRegistryByName.mockResolvedValue({
      modelName: 'owner/model:8b-q4',
      installations: [{ hostUrl: HOST_URL, digest: 'sha256:old', isActive: true }]
    });

    await expect(resolveArtifactIdentity('owner/model:8b-q4', 'host-a', HOST_URL))
      .rejects.toThrow(/registry is missing or stale/i);
  });
});
