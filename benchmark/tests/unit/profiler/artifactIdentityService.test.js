'use strict';

jest.mock('../../../src/clients/coreApiClient', () => ({ getModelRegistryByName: jest.fn() }));
jest.mock('../../../src/services/benchmark/modelDigestService', () => ({ getModelDigest: jest.fn() }));
jest.mock('../../../src/services/profiler/hostProfileService', () => ({ getById: jest.fn() }));
jest.mock('../../../src/clients/ollamaClient', () => ({
  getVersion: jest.fn(),
  listModels: jest.fn(),
  listRunning: jest.fn()
}));

const { getModelRegistryByName } = require('../../../src/clients/coreApiClient');
const { getModelDigest } = require('../../../src/services/benchmark/modelDigestService');
const hostProfiles = require('../../../src/services/profiler/hostProfileService');
const ollama = require('../../../src/clients/ollamaClient');
const {
  resolveArtifactIdentity,
  resolveRuntimeArtifactReceipt,
  runtimeReceiptMatchesProfile
} = require('../../../src/services/profiler/artifactIdentityService');

const HOST_URL = 'http://host-a:11434';
const RAW_DIGEST = 'a'.repeat(64);
const EXACT_DIGEST = `sha256:${RAW_DIGEST}`;

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

  it('publishes a fresh canonical runtime receipt entirely from live server evidence', async () => {
    getModelDigest.mockResolvedValue(RAW_DIGEST);
    getModelRegistryByName.mockResolvedValue({
      _id: 'registry-a',
      modelName: 'owner/model:8b-q4',
      installations: [{ hostUrl: HOST_URL, digest: EXACT_DIGEST, status: 'active', isActive: true }]
    });
    ollama.listModels.mockResolvedValue({
      models: [{ name: 'owner/model:8b-q4', digest: RAW_DIGEST, size: 9_000_000_000 }]
    });
    ollama.listRunning.mockResolvedValue({
      models: [{
        name: 'owner/model:8b-q4',
        digest: RAW_DIGEST,
        size: 8_500_000_000,
        size_vram: 8_500_000_000,
        context_length: 32_768
      }]
    });
    ollama.getVersion.mockResolvedValue({ version: '0.11.10' });

    const receipt = await resolveRuntimeArtifactReceipt(
      'owner/model:8b-q4',
      'host-a',
      HOST_URL,
      { observedAt: '2026-09-04T18:00:00.000Z' }
    );

    expect(receipt).toMatchObject({
      contract: 'agentx.runtime-artifact-identity/v1',
      model: 'owner/model:8b-q4',
      tag: 'owner/model:8b-q4',
      hostId: 'host-a',
      hostUrl: HOST_URL,
      digest: EXACT_DIGEST,
      artifactSize: 9_000_000_000,
      residentSize: 8_500_000_000,
      sizeVram: 8_500_000_000,
      fullVram: true,
      contextLength: 32_768,
      runtimeVersion: '0.11.10',
      freshness: { state: 'fresh', observedAt: '2026-09-04T18:00:00.000Z' },
      provenance: { authority: 'agentx-product-benchmark', mode: 'live_server_observation' }
    });
    expect(receipt.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.receiptId).toMatch(/^[a-f0-9]{64}$/);
    expect(runtimeReceiptMatchesProfile(receipt, {
      modelName: 'owner/model:8b-q4',
      hostId: 'host-a',
      artifact: {
        model: 'owner/model:8b-q4',
        hostId: 'host-a',
        hostUrl: HOST_URL,
        digest: EXACT_DIGEST
      },
      profile: { recommendedInteractiveContext: 32_768 }
    }, { now: '2026-09-04T18:00:15.000Z' })).toBe(true);
  });

  it('rejects an old resident blob after the installed tag is repointed', async () => {
    getModelDigest.mockResolvedValue(EXACT_DIGEST);
    getModelRegistryByName.mockResolvedValue({
      modelName: 'owner/model:8b-q4',
      installations: [{ hostUrl: HOST_URL, digest: EXACT_DIGEST, isActive: true }]
    });
    ollama.listModels.mockResolvedValue({
      models: [{ name: 'owner/model:8b-q4', digest: EXACT_DIGEST, size: 9_000_000_000 }]
    });
    ollama.listRunning.mockResolvedValue({
      models: [{
        name: 'owner/model:8b-q4', digest: `sha256:${'b'.repeat(64)}`,
        size: 8_500_000_000, size_vram: 8_500_000_000, context_length: 32_768
      }]
    });
    ollama.getVersion.mockResolvedValue({ version: '0.11.10' });

    await expect(resolveRuntimeArtifactReceipt('owner/model:8b-q4', 'host-a', HOST_URL))
      .rejects.toThrow(/resident runtime.*same digest/i);
  });

  it('fails closed when residency cannot prove live VRAM and context', async () => {
    getModelDigest.mockResolvedValue(EXACT_DIGEST);
    getModelRegistryByName.mockResolvedValue({
      modelName: 'owner/model:8b-q4',
      installations: [{ hostUrl: HOST_URL, digest: EXACT_DIGEST, isActive: true }]
    });
    ollama.listModels.mockResolvedValue({
      models: [{ name: 'owner/model:8b-q4', digest: EXACT_DIGEST, size: 9_000_000_000 }]
    });
    ollama.listRunning.mockResolvedValue({ models: [] });
    ollama.getVersion.mockResolvedValue({ version: '0.11.10' });

    await expect(resolveRuntimeArtifactReceipt('owner/model:8b-q4', 'host-a', HOST_URL))
      .rejects.toThrow(/not resident/i);
  });
});
