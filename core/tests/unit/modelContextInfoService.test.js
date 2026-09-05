'use strict';

jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

jest.mock('../../models/ModelRegistry', () => ({
  findOne: jest.fn()
}));

jest.mock('../../models/HostPreference', () => ({
  findOne: jest.fn()
}));

jest.mock('../../src/helpers/ollamaUtils', () => ({
  resolveTarget: jest.fn((t) => t)
}));

const ModelRegistry = require('../../models/ModelRegistry');
const ModelContextProfile = { findOne: jest.fn() };
const HostPreference = require('../../models/HostPreference');
const svc = require('../../src/services/modelContextInfoService');

const exactArtifact = {
  model: 'ax/qwen3.5:9b',
  hostId: 'host-alpha',
  hostUrl: 'http://host:11434',
  digest: 'sha256:artifact-one',
  runtimeFingerprint: 'runtime-one',
  registryQualified: true,
  identityQualified: true
};

function mockRegistry(entry) {
  const chain = {
    select: jest.fn(() => chain),
    lean: jest.fn(() => Promise.resolve(entry || null))
  };
  ModelRegistry.findOne.mockReturnValue(chain);
}

function mockProfile(profile) {
  const chain = {
    select: jest.fn(() => chain),
    lean: jest.fn(() => Promise.resolve(profile || null))
  };
  ModelContextProfile.findOne.mockReturnValue(chain);
}

function mockHostPreference(pref) {
  const chain = {
    select: jest.fn(() => chain),
    lean: jest.fn(() => Promise.resolve(pref || null))
  };
  HostPreference.findOne.mockReturnValue(chain);
}

function makeFetch(responseShape, ok = true) {
  return jest.fn().mockResolvedValue({
    ok,
    json: async () => responseShape
  });
}

describe('modelContextInfoService', () => {
  beforeEach(() => {
    svc._clearCache();
    jest.clearAllMocks();
    mockProfile(null);
    mockHostPreference(null);
  });

  it('uses Modelfile PARAMETER num_ctx when Ollama returns it', async () => {
    svc._setFetch(makeFetch({
      parameters: 'num_ctx 131072\nstop <|im_end|>\ntemperature 0.7',
      model_info: { 'gemma4.context_length': 131072 }
    }));
    const info = await svc.getContextInfo('gemma4:26b', 'http://host:11434');
    expect(info.num_ctx).toBe(131072);
    expect(info.source).toBe('modelfile');
    expect(info.maxContextLength).toBe(131072);
  });

  it('does not reuse a legacy registry context value without exact artifact evidence', async () => {
    svc._setFetch(makeFetch({
      parameters: 'stop <|im_end|>',
      model_info: {}
    }));
    mockRegistry({
      contextTest: { status: 'completed', testedNumCtx: 32768 },
      executionDefaults: { num_ctx: 8192 }
    });
    const info = await svc.getContextInfo('qwen2.5:7b', 'http://host:11434');
    expect(info.num_ctx).toBeNull();
    expect(info.source).toBe('unresolved');
  });

  it('uses a matching HostPreference pin before Modelfile context', async () => {
    svc._setFetch(makeFetch({
      parameters: 'num_ctx 157696',
      model_info: { 'qwen.context_length': 262144 }
    }));
    mockHostPreference({
      displayName: 'Host Beta',
      pinnedModels: [
        { model: 'ax/qwen3.5:9b', contextSize: 131072 }
      ]
    });
    mockProfile({
      modelName: 'ax/qwen3.5:9b',
      verifiedMaxContext: 120000,
      verifiedInputTokens: 100000
    });

    const info = await svc.getContextInfo('ax/qwen3.5:9b', 'http://192.0.2.12:11434', {
      artifactIdentity: {
        ...exactArtifact,
        hostUrl: 'http://192.0.2.12:11434'
      },
      deps: { ModelContextProfile }
    });

    expect(info).toEqual(expect.objectContaining({
      num_ctx: 131072,
      source: 'host_preference_pin',
      pinnedModel: 'ax/qwen3.5:9b',
      hostDisplayName: 'Host Beta',
      verifiedMaxContext: 120000,
      verifiedInputTokens: 100000,
      maxContextLength: 262144
    }));
  });

  it('uses a context profile only for the qualified exact artifact', async () => {
    const profiledAt = new Date('2026-06-16T00:00:00Z');
    svc._setFetch(makeFetch({
      parameters: 'stop <|im_end|>',
      model_info: { 'qwen.context_length': 262144 }
    }));
    mockProfile({
      modelName: 'ax/qwen3.5:9b',
      maxVerifiedContext: 237568,
      verifiedMaxContext: 237568,
      recommendedInteractiveContext: 65536,
      recommendedDocumentContext: 131072,
      recommendationStatus: 'verified',
      recommendationEvidenceVersion: 'context-probe-degradation-v3',
      revalidationRequired: false,
      verifiedInputTokens: 190000,
      lastValidatedAt: profiledAt
    });
    mockRegistry({
      contextTest: { status: 'completed', testedNumCtx: 32768 },
      executionDefaults: { num_ctx: 8192 }
    });

    const info = await svc.getContextInfo('ax/qwen3.5:9b', 'http://host:11434', {
      artifactIdentity: exactArtifact,
      deps: { ModelContextProfile }
    });

    expect(info).toEqual(expect.objectContaining({
      num_ctx: 65536,
      source: 'model_context_profile_interactive',
      verifiedMaxContext: 237568,
      maxVerifiedContext: 237568,
      recommendedInteractiveContext: 65536,
      recommendedDocumentContext: 131072,
      verifiedInputTokens: 190000,
      profiledAt,
      matchedName: 'ax/qwen3.5:9b',
      maxContextLength: 262144
    }));
    expect(ModelContextProfile.findOne).toHaveBeenCalledWith(expect.objectContaining({
      modelName: { $in: ['ax/qwen3.5:9b'] },
      hostUrl: 'http://host:11434',
      artifactDigest: 'sha256:artifact-one',
      runtimeFingerprint: 'runtime-one',
      stale: { $ne: true }
    }));
  });

  it('ignores generated registry defaults when no runtime context evidence exists', async () => {
    svc._setFetch(makeFetch({ parameters: '' }));
    mockRegistry({
      contextTest: { status: 'pending' },
      executionDefaults: { num_ctx: 16384 }
    });
    const info = await svc.getContextInfo('model-x', 'http://host:11434');
    expect(info.num_ctx).toBeNull();
    expect(info.source).toBe('unresolved');
  });

  it('uses model_capacity from /api/show model_info when nothing else', async () => {
    svc._setFetch(makeFetch({
      parameters: '',
      model_info: { 'qwen.context_length': 65536 }
    }));
    mockRegistry(null);
    const info = await svc.getContextInfo('unknown:1b', 'http://host:11434', { workload: 'capacity' });
    expect(info.num_ctx).toBe(65536);
    expect(info.source).toBe('model_capacity');
  });

  it('keeps a legacy 262K value as historical capacity but never a runtime recommendation', async () => {
    svc._setFetch(makeFetch({ parameters: '', model_info: {} }));
    mockProfile({
      modelName: 'ornith:latest',
      recommendedContext: 262144,
      verifiedMaxContext: 262144,
      recommendedInteractiveContext: 262144,
      recommendedDocumentContext: 262144,
      recommendationStatus: 'verified',
      recommendationEvidenceVersion: 'context-probe-degradation-v2',
      revalidationRequired: false,
      stale: false
    });

    const info = await svc.getContextInfo('ornith:latest', 'http://host:11434', {
      artifactIdentity: exactArtifact,
      deps: { ModelContextProfile }
    });

    expect(info).toMatchObject({
      num_ctx: null,
      source: 'unresolved',
      maxVerifiedContext: 262144,
      recommendationStatus: 'unknown',
      revalidationRequired: true
    });
    expect(info.recommendedInteractiveContext).toBeUndefined();
    expect(info.recommendedDocumentContext).toBeUndefined();
  });

  it('returns unresolved when everything fails', async () => {
    svc._setFetch(makeFetch({}, false));
    mockRegistry(null);
    const info = await svc.getContextInfo('ghost:1b', 'http://host:11434');
    expect(info.num_ctx).toBeNull();
    expect(info.source).toBe('unresolved');
  });

  it('does not resolve profiled context without a host-bound artifact identity', async () => {
    svc._setFetch(jest.fn()); // should not be called
    mockRegistry({
      contextTest: { status: 'completed', testedNumCtx: 24576 }
    });
    const info = await svc.getContextInfo('model-y');
    expect(info.num_ctx).toBeNull();
    expect(info.source).toBe('unresolved');
  });

  it('caches results per (host, model) for the TTL', async () => {
    const fetchMock = makeFetch({
      parameters: 'num_ctx 131072',
      model_info: {}
    });
    svc._setFetch(fetchMock);
    const first = await svc.getContextInfo('m', 'http://h');
    const second = await svc.getContextInfo('m', 'http://h');
    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when model is missing', async () => {
    await expect(svc.getContextInfo('')).rejects.toThrow('model is required');
  });
});
