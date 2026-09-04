'use strict';

const path = require('node:path');
const fixture = require('../../../test/fixtures/benchmark-claim-release-v1.json');
const hostPreferenceService = require('../../src/services/hostPreferenceService');

describe('benchmark claim release v1 shared fixture', () => {
  test('contains the three cross-repository contract cases', () => {
    expect(fixture.contract).toBe('agentx.benchmark-claim-release-fixtures/v1');
    expect(fixture.cases.map(entry => entry.name)).toEqual([
      'finite_resident_live',
      'finite_resident_expired',
      'explicit_exclusion_refused_by_aiops'
    ]);
    expect(path.basename(require.resolve('../../../test/fixtures/benchmark-claim-release-v1.json')))
      .toBe('benchmark-claim-release-v1.json');
  });

  test.each(fixture.cases)('$name has recomputable snapshot identities and a complete exact receipt', (entry) => {
    const acquire = entry.acquireSnapshot;
    const receipt = entry.releaseReceipt;
    expect(hostPreferenceService.benchmarkRuntimeSnapshotIdentity(acquire)).toBe(acquire.identityDigest);
    expect(receipt.snapshot.identityDigest).toBe(acquire.identityDigest);
    expect(receipt.verification.snapshotIdentity).toBe(receipt.snapshot.appliedIdentityDigest);
    expect(receipt.snapshot.residentCount).toBe(receipt.snapshot.residents.length);
    expect(receipt.verification).toMatchObject({
      status: 'ready', ready: true, verified: true, degraded: false, mode: 'exact_runtime_snapshot'
    });
    expect(receipt.state).toMatchObject({ claimCleared: true, finalizerCleared: true });
    expect(Number.isFinite(Date.parse(receipt.releasedAt))).toBe(true);
  });

  test('keeps natural expiry distinct from an explicit exclusion', () => {
    const expired = fixture.cases.find(entry => entry.name === 'finite_resident_expired');
    const excluded = fixture.cases.find(entry => entry.name === 'explicit_exclusion_refused_by_aiops');
    expect(expired.releaseReceipt.snapshot).toMatchObject({
      excludedModels: [], expiredModels: ['fixture-expired:latest']
    });
    expect(expired.wrapperExpected).toBe(true);
    expect(excluded.releaseReceipt.snapshot).toMatchObject({
      excludedModels: ['fixture-excluded:latest'], expiredModels: []
    });
    expect(excluded.wrapperExpected).toBe(false);
  });
});
