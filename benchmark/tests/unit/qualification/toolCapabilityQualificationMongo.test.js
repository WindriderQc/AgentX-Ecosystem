'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const ToolCapabilityQualification = require('../../../models/ToolCapabilityQualification');
const service = require('../../../src/services/qualification/toolCapabilityQualificationService');
const fixtures = require('../../../src/services/qualification/toolCallFixtures');

jest.setTimeout(30_000);

let mongoServer;

function identity() {
  const contract = service.currentEvidenceContract();
  return {
    modelName: 'owner/model:8b',
    hostUrl: 'http://host-a:11434',
    hostId: 'host-a',
    artifactDigest: 'sha256:a',
    runtimeFingerprint: 'runtime-a',
    protocolVersion: contract.protocolVersion,
    fixtureVersion: contract.fixtureVersion,
    fixtureFingerprint: contract.fixtureFingerprint
  };
}

function report() {
  const contract = service.currentEvidenceContract();
  return {
    harnessVersion: contract.harnessVersion,
    fixtureVersion: contract.fixtureVersion,
    fixtureFingerprint: contract.fixtureFingerprint,
    artifact: {
      model: 'owner/model:8b',
      host: 'http://host-a:11434',
      hostId: 'host-a',
      digest: 'sha256:a',
      runtimeFingerprint: 'runtime-a'
    },
    toolCallOutcomes: {
      scenarios: fixtures.SCENARIOS_V1.map((scenario) => ({
        scenarioId: scenario.id,
        classification: 'ok',
        pass: true
      }))
    }
  };
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await ToolCapabilityQualification.syncIndexes();
});

afterEach(async () => {
  await ToolCapabilityQualification.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

describe('ToolCapabilityQualification Mongo boundary', () => {
  it('persists, finalizes, resolves, and preserves immutable identity', async () => {
    const input = {
      campaignId: 'toolcall-mongo-a',
      ...identity(),
      repetitionsRequested: 3,
      contractFingerprint: 'a'.repeat(64),
      claim: {
        batchId: 'toolcall-mongo-a',
        claimGeneration: '11111111-1111-4111-8111-111111111111',
        hostUrl: 'http://host-a:11434'
      }
    };
    await service.beginQualification(input);
    for (let index = 0; index < 3; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await service.recordRepetition(input.campaignId, identity(), report());
    }
    const finalized = await service.finalizeQualification(
      input.campaignId,
      identity(),
      { completedAt: '2026-09-04T01:00:00Z', ttlMs: 60_000 }
    );
    expect(finalized).toMatchObject({ outcome: 'supported', repetitionsCompleted: 3 });

    const resolved = await service.resolveQualification(identity(), {
      now: new Date('2026-09-04T01:00:30Z')
    });
    expect(resolved).toMatchObject({
      state: 'supported',
      supported: true,
      qualified: true,
      evidence: { campaignId: input.campaignId, artifactDigest: 'sha256:a' }
    });

    await ToolCapabilityQualification.updateOne(
      { campaignId: input.campaignId },
      { $set: { artifactDigest: 'sha256:attempted-overwrite' } }
    );
    const stored = await ToolCapabilityQualification.findOne({ campaignId: input.campaignId }).lean();
    expect(stored.artifactDigest).toBe('sha256:a');
    await expect(service.beginQualification(input))
      .rejects.toMatchObject({ code: 'TOOL_QUALIFICATION_ALREADY_EXISTS' });
  });
});
