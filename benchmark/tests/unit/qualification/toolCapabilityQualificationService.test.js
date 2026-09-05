'use strict';

const ToolCapabilityQualification = require('../../../models/ToolCapabilityQualification');
const service = require('../../../src/services/qualification/toolCapabilityQualificationService');
const fixtures = require('../../../src/services/qualification/toolCallFixtures');

function matches(row, filter) {
  return Object.entries(filter || {}).every(([key, value]) => row?.[key] === value);
}

function queryFor(value) {
  return {
    sort: jest.fn(function sort() { return this; }),
    lean: jest.fn(async () => value)
  };
}

function makeModel() {
  const rows = [];
  return {
    rows,
    async create(input) {
      if (rows.some((row) => row.campaignId === input.campaignId)) {
        const error = new Error('duplicate');
        error.code = 11000;
        throw error;
      }
      const row = structuredClone(input);
      rows.push(row);
      return row;
    },
    findOne(filter) {
      const found = rows
        .filter((row) => matches(row, filter))
        .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0))[0] || null;
      return queryFor(found ? structuredClone(found) : null);
    },
    findOneAndUpdate(filter, update) {
      const row = rows.find((candidate) => matches(candidate, filter));
      if (!row) return queryFor(null);
      if (update.$push) {
        for (const [key, value] of Object.entries(update.$push)) {
          row[key] = row[key] || [];
          row[key].push(structuredClone(value));
        }
      }
      if (update.$inc) {
        for (const [key, value] of Object.entries(update.$inc)) row[key] = (row[key] || 0) + value;
      }
      if (update.$set) Object.assign(row, structuredClone(update.$set));
      return queryFor(structuredClone(row));
    }
  };
}

function identity(overrides = {}) {
  const contract = service.currentEvidenceContract();
  return {
    modelName: 'owner/model:8b',
    hostUrl: 'HTTP://HOST-A:11434/',
    hostId: 'host-a',
    artifactDigest: 'sha256:artifact-a',
    runtimeFingerprint: 'runtime-a',
    protocolVersion: contract.protocolVersion,
    fixtureVersion: contract.fixtureVersion,
    fixtureFingerprint: contract.fixtureFingerprint,
    ...overrides
  };
}

function claim() {
  return {
    batchId: 'toolcall-campaign-a',
    claimGeneration: '11111111-1111-4111-8111-111111111111',
    hostUrl: 'http://host-a:11434',
    claimedAt: '2026-09-04T00:00:00Z'
  };
}

function report(classification = 'ok', pass = classification === 'ok', overrides = {}) {
  const contract = service.currentEvidenceContract();
  return {
    harnessVersion: contract.harnessVersion,
    fixtureVersion: contract.fixtureVersion,
    fixtureFingerprint: contract.fixtureFingerprint,
    artifact: {
      model: 'owner/model:8b',
      host: 'http://host-a:11434',
      hostId: 'host-a',
      digest: 'sha256:artifact-a',
      runtimeFingerprint: 'runtime-a',
      ...(overrides.artifact || {})
    },
    toolCallOutcomes: {
      scenarios: overrides.scenarios || fixtures.SCENARIOS_V1.map((scenario) => ({
        scenarioId: scenario.id,
        classification,
        pass
      }))
    }
  };
}

async function begin(Model, overrides = {}) {
  return service.beginQualification({
    campaignId: 'toolcall-campaign-a',
    ...identity(),
    repetitionsRequested: 3,
    contractFingerprint: 'a'.repeat(64),
    claim: claim(),
    ...overrides
  }, { Model });
}

describe('ToolCapabilityQualification persistence', () => {
  it('declares immutable campaign identity and exact-artifact lookup indexes', () => {
    const indexes = ToolCapabilityQualification.schema.indexes();
    expect(indexes).toEqual(expect.arrayContaining([
      expect.arrayContaining([
        expect.objectContaining({ identityKey: 1, campaignId: 1 }),
        expect.objectContaining({ unique: true })
      ]),
      expect.arrayContaining([
        expect.objectContaining({
          modelName: 1,
          hostUrl: 1,
          hostId: 1,
          artifactDigest: 1,
          runtimeFingerprint: 1,
          protocolVersion: 1,
          fixtureVersion: 1,
          fixtureFingerprint: 1
        })
      ])
    ]));
  });

  it('records bounded repetitions and finalizes all-pass evidence as supported', async () => {
    const Model = makeModel();
    await begin(Model);
    for (let index = 0; index < 3; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await service.recordRepetition('toolcall-campaign-a', identity(), report(), { Model });
    }
    const finalized = await service.finalizeQualification(
      'toolcall-campaign-a',
      identity(),
      { completedAt: '2026-09-04T01:00:00Z', ttlMs: 60_000 },
      { Model }
    );
    expect(finalized).toMatchObject({
      runState: 'finalized',
      outcome: 'supported',
      repetitionsCompleted: 3
    });
    expect(finalized.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    await expect(service.recordRepetition('toolcall-campaign-a', identity(), report(), { Model }))
      .rejects.toMatchObject({ code: 'TOOL_QUALIFICATION_FINALIZED' });
  });

  it('requires repeated explicit no-tool-surface evidence before unsupported', async () => {
    const Model = makeModel();
    await begin(Model);
    for (let index = 0; index < 3; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await service.recordRepetition(
        'toolcall-campaign-a',
        identity(),
        report('unsupported_no_tool_call_surface', false),
        { Model }
      );
    }
    const finalized = await service.finalizeQualification('toolcall-campaign-a', identity(), {}, { Model });
    expect(finalized.outcome).toBe('unsupported');
  });

  it('keeps partial, failed, and cross-identity evidence from becoming negative', async () => {
    const Model = makeModel();
    await begin(Model);
    await service.recordRepetition(
      'toolcall-campaign-a',
      identity(),
      report('contract_violation', false),
      { Model }
    );
    await expect(service.recordRepetition(
      'toolcall-campaign-a',
      identity({ artifactDigest: 'sha256:other' }),
      report(),
      { Model }
    )).rejects.toMatchObject({ code: 'TOOL_QUALIFICATION_IDENTITY_MISMATCH' });
    const finalized = await service.finalizeQualification(
      'toolcall-campaign-a',
      identity(),
      { interrupted: true, failureCode: 'TEST_INTERRUPTION' },
      { Model }
    );
    expect(finalized.outcome).toBe('interrupted');
    await expect(service.resolveQualification(identity(), {
      Model,
      now: new Date('2099-01-01T00:00:00Z')
    })).resolves.toMatchObject({
      state: 'unknown',
      supported: null,
      qualified: false,
      reasons: ['evidence_interrupted']
    });
  });

  it('resolves exact fresh evidence, expiry, drift, and non-qualifying outcomes fail closed', async () => {
    const Model = makeModel();
    await begin(Model);
    for (let index = 0; index < 3; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await service.recordRepetition('toolcall-campaign-a', identity(), report(), { Model });
    }
    await service.finalizeQualification(
      'toolcall-campaign-a',
      identity(),
      { completedAt: '2026-09-04T01:00:00Z', ttlMs: 60_000 },
      { Model }
    );

    await expect(service.resolveQualification(identity(), {
      Model,
      now: new Date('2026-09-04T01:00:30Z')
    })).resolves.toMatchObject({ state: 'supported', supported: true, qualified: true });
    await expect(service.resolveQualification(identity(), {
      Model,
      now: new Date('2026-09-04T01:02:00Z')
    })).resolves.toMatchObject({ state: 'stale', supported: null, reasons: ['evidence_expired'] });
    await expect(service.resolveQualification(identity({ artifactDigest: 'sha256:new' }), {
      Model,
      now: new Date('2026-09-04T01:00:30Z')
    })).resolves.toMatchObject({
      state: 'stale',
      supported: null,
      qualified: false,
      reasons: expect.arrayContaining(['artifact_digest_mismatch']),
      evidence: null
    });
    await expect(service.resolveQualification(identity({ hostUrl: 'http://host-b:11434' }), {
      Model,
      now: new Date('2026-09-04T01:00:30Z')
    })).resolves.toMatchObject({
      state: 'stale',
      supported: null,
      qualified: false,
      reasons: expect.arrayContaining(['host_url_mismatch']),
      evidence: null
    });
  });

  it('refuses duplicate campaign ids and stale fixture contracts', async () => {
    const Model = makeModel();
    await begin(Model);
    await expect(service.recordRepetition(
      'toolcall-campaign-a',
      identity(),
      { ...report(), fixtureFingerprint: 'stale-report-fixture' },
      { Model }
    )).rejects.toMatchObject({ code: 'TOOL_QUALIFICATION_REPORT_CONTRACT_DRIFT' });
    await expect(begin(Model)).rejects.toMatchObject({ code: 'TOOL_QUALIFICATION_ALREADY_EXISTS' });
    await expect(begin(makeModel(), {
      fixtureFingerprint: 'stale-fixture'
    })).rejects.toMatchObject({ code: 'TOOL_QUALIFICATION_CONTRACT_DRIFT' });
  });

  it('rejects partial, duplicate, inconsistent, and cross-artifact repetition reports', async () => {
    const Model = makeModel();
    await begin(Model);
    const canonical = report().toolCallOutcomes.scenarios;
    await expect(service.recordRepetition(
      'toolcall-campaign-a',
      identity(),
      report('ok', true, { scenarios: canonical.slice(0, -1) }),
      { Model }
    )).rejects.toMatchObject({ code: 'TOOL_QUALIFICATION_REPORT_SCOPE_DRIFT' });
    await expect(service.recordRepetition(
      'toolcall-campaign-a',
      identity(),
      report('ok', true, { scenarios: canonical.map((row) => ({ ...row, scenarioId: canonical[0].scenarioId })) }),
      { Model }
    )).rejects.toMatchObject({ code: 'TOOL_QUALIFICATION_REPORT_SCOPE_DRIFT' });
    await expect(service.recordRepetition(
      'toolcall-campaign-a',
      identity(),
      report('contract_violation', true),
      { Model }
    )).rejects.toMatchObject({ code: 'TOOL_QUALIFICATION_REPORT_INVALID' });
    await expect(service.recordRepetition(
      'toolcall-campaign-a',
      identity(),
      report('ok', true, { artifact: { digest: 'sha256:other' } }),
      { Model }
    )).rejects.toMatchObject({ code: 'TOOL_QUALIFICATION_REPORT_IDENTITY_MISMATCH' });
  });

  it('downgrades tampered and prior-schema evidence instead of qualifying it', async () => {
    const tamperedModel = makeModel();
    await begin(tamperedModel);
    for (let index = 0; index < 3; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await service.recordRepetition('toolcall-campaign-a', identity(), report(), { Model: tamperedModel });
    }
    await service.finalizeQualification(
      'toolcall-campaign-a',
      identity(),
      { completedAt: '2026-09-04T01:00:00Z', ttlMs: 60_000 },
      { Model: tamperedModel }
    );
    tamperedModel.rows[0].evidenceDigest = 'b'.repeat(64);
    await expect(service.resolveQualification(identity(), {
      Model: tamperedModel,
      now: new Date('2026-09-04T01:00:30Z')
    })).resolves.toMatchObject({
      state: 'stale',
      supported: null,
      qualified: false,
      reasons: ['evidence_integrity_mismatch']
    });

    const priorSchemaModel = makeModel();
    await begin(priorSchemaModel);
    for (let index = 0; index < 3; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await service.recordRepetition('toolcall-campaign-a', identity(), report(), { Model: priorSchemaModel });
    }
    await service.finalizeQualification(
      'toolcall-campaign-a',
      identity(),
      { completedAt: '2026-09-04T01:00:00Z', ttlMs: 60_000 },
      { Model: priorSchemaModel }
    );
    priorSchemaModel.rows[0].schemaVersion = 'agentx.tool-capability-qualification.v0';
    await expect(service.resolveQualification(identity(), {
      Model: priorSchemaModel,
      now: new Date('2026-09-04T01:00:30Z')
    })).resolves.toMatchObject({
      state: 'stale',
      supported: null,
      qualified: false,
      reasons: expect.arrayContaining(['schema_version_mismatch']),
      evidence: null
    });
  });
});
