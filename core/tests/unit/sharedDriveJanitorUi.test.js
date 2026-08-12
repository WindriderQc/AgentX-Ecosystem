'use strict';

const fs = require('fs');
const path = require('path');
const sharedDriveUi = require('../../public/js/shared-drive-janitor.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

describe('Shared Drives Janitor policy gate', () => {
  it('keeps null and invalid policy choices unselected', () => {
    expect(sharedDriveUi.policySelections({
      duplicateSurvivor: null,
      backupRetention: 'unknown',
      generatedCache: undefined,
    })).toEqual({
      duplicateSurvivor: '',
      backupRetention: '',
      generatedCache: '',
    });
    expect(sharedDriveUi.policyComplete({})).toBe(false);
    expect(() => sharedDriveUi.buildPolicyRequest({})).toThrow(/three shared-drive policy decisions/i);
  });

  it('creates a persistence payload only after explicit confirmation', () => {
    const selections = {
      duplicateSurvivor: 'canonical_active',
      backupRetention: 'immutable_archive',
      generatedCache: 'review_rebuildable',
    };
    const declined = jest.fn(() => false);
    expect(sharedDriveUi.confirmPolicyRequest(selections, declined, 'test-operator')).toBeNull();
    expect(declined).toHaveBeenCalledTimes(1);

    const accepted = jest.fn(() => true);
    expect(sharedDriveUi.confirmPolicyRequest(selections, accepted, 'test-operator')).toEqual({
      confirm: true,
      updated_by: 'test-operator',
      policy: {
        version: 1,
        duplicateSurvivor: 'canonical_active',
        backupRetention: 'immutable_archive',
        generatedCache: 'review_rebuildable',
        maintenanceAuthorization: 'explicit_per_action',
      },
    });
    expect(accepted).toHaveBeenCalledTimes(1);
  });
});

describe('Shared Drives Janitor evidence view model', () => {
  const report = {
    generatedAt: '2026-07-18T01:16:12.863Z',
    status: 'awaiting_policy',
    decisions_required: [{ field: 'duplicateSurvivor' }],
    policyDecisionSupport: {
      mode: 'aggregate-read-only-decision-support',
      basis: {
        verifiedGroups: 275,
        verifiedFiles: 1133,
        provenSavingsBytes: 23654740458,
        unverifiedCandidatesExcluded: true,
        candidateBytesIncluded: false,
      },
      duplicateSurvivor: {
        choices: [
          {
            value: 'canonical_active',
            description: 'Prefer a non-backup, non-cache location.',
            selectedStorageRoles: [
              { storageRole: 'media_asset', verifiedGroups: 176 },
              { storageRole: 'generated_cache', verifiedGroups: 37 },
            ],
          },
          {
            value: 'newest',
            description: 'Prefer the greatest indexed modification time.',
            selectedStorageRoles: [{ storageRole: 'media_asset', verifiedGroups: 180 }],
          },
          {
            value: 'oldest',
            description: 'Prefer the smallest indexed modification time.',
            selectedStorageRoles: [{ storageRole: 'media_asset', verifiedGroups: 146 }],
          },
        ],
        groupsWithIdenticalMtime: 73,
        selectionDifferences: {
          canonicalVsNewest: 171,
          canonicalVsOldest: 170,
          newestVsOldest: 202,
        },
        maximumGroupsWithDifferentSelection: 202,
        selectedValue: null,
        recommendedValue: null,
      },
      backupRetention: {
        verifiedGroups: 61,
        provenSavingsBytes: 3191929525,
        choices: [
          { value: 'immutable_archive', description: 'Keep backup groups outside proposals.' },
          { value: 'disaster_recovery', description: 'Retain backup groups for recovery.' },
          { value: 'staging', description: 'Admit backup groups to explicit review.' },
        ],
        selectedValue: null,
        recommendedValue: null,
      },
      generatedCache: {
        verifiedGroups: 37,
        provenSavingsBytes: 706436063,
        choices: [
          { value: 'preserve', description: 'Keep cache groups outside proposals.' },
          { value: 'review_rebuildable', description: 'Admit rebuildable caches to review.' },
        ],
        selectedValue: null,
        recommendedValue: null,
      },
      overlap: { verifiedGroups: 11, provenSavingsBytes: 123132839 },
      safety: {
        policyPersisted: false,
        proposalsCreated: 0,
        approvalRequested: false,
        executionAuthorized: false,
        sharedDriveMutations: 0,
      },
    },
    evidence: {
      verifiedDuplicatesAreLowerBound: true,
      verifiedDuplicateGroups: 198,
      verifiedDuplicateFiles: 405,
      provenSavingsBytes: 15818791783,
      duplicateCandidates: {
        groups: 25339,
        files: 50000,
        candidateBytes: 123456789,
        filesToHash: 42000,
        bytesToHash: 98234567,
        candidateBytesAreNotSavings: true,
      },
      metadataFirst: {
        status: 'measured',
        indexedFiles: 268567,
        indexedBytes: 2517160287176,
        canonicalRoots: 2,
        organizationReviewAvailable: true,
        exactDuplicateProofRequired: true,
        filesystemMutationAllowed: false,
        signals: ['classification', 'extension', 'timestamp', 'storage_role', 'mirror_correlation'],
      },
      verificationQueue: {
        status: 'prioritized',
        ordering: ['potential_duplicate_bytes_desc', 'file_size_desc'],
        groups: 25339,
        files: 50000,
        potentialDuplicateBytes: 123456789,
        filesToHash: 42000,
        bytesToHash: 98234567,
        potentialDuplicateBytesAreNotSavings: true,
        exactDuplicateProofRequired: true,
        filesystemMutationAllowed: false,
      },
      verificationOutlook: {
        status: 'measured',
        filesToHash: 42000,
        bytesToHash: 98234567,
        latestCompletedCycle: {
          hashedFiles: 500,
          hashedBytes: 2000000,
          durationSeconds: 120,
          estimatedComparableCyclesLowerBound: 85,
        },
        configuredCapacity: {
          maxFiles: 1000,
          maxBytes: 10 * 1024 ** 3,
          estimatedCyclesLowerBound: 42,
        },
      },
      oversizedUnhashedCandidates: {
        status: 'measured',
        evidence: 'same-size-candidates-above-latest-root-hash-budget',
        groups: 0,
        files: 0,
        bytesToHash: 0,
        bytesAreNotSavings: true,
        fileIdentityIncluded: false,
        filesystemMutationAllowed: false,
      },
      hashingLimits: [{ root: '/mnt/datalake', hashMaxBytes: 10 * 1024 ** 3 }],
      perRoot: [{
        root: '/mnt/datalake',
        totalFiles: 220737,
        totalBytes: 351590000000,
        unclassifiedFiles: 13357,
        missingExtensionUnresolvedFiles: 1159,
        missingExtensionContentKnownFiles: 2,
        missingExtensionContentUnknownFiles: 1157,
        timestampReviewFiles: 5909,
      }],
    },
    maintenance: {
      proposals: [],
      executableActions: [],
    },
    safety: {
      sharedDriveMutations: 0,
      approvalEndpointsCalled: false,
      deleteMoveArchiveExecuted: false,
    },
    comparison: {
      status: 'compared',
      previousReportId: 'previous-report',
      previousGeneratedAt: '2026-07-17T01:16:12.863Z',
      organization: {
        status: 'compared',
        reason: null,
        counts: { new: 2, improved: 3, worsened: 1, unchanged: 5, resolved: 4 },
        totals: {
          current: 11,
          previous: 13,
          union: 15,
          currentAccountedFor: 11,
          previousAccountedFor: 13,
        },
        topChanges: [{
          id: 'metadata-extension-rule:mnt-datalake:smc',
          change: 'improved',
          filesystemMutationAllowed: false,
        }],
      },
    },
    organizationStrategy: {
      workItems: [{
        id: 'metadata-extension-rule:mnt-datalake:smc',
        rank: 1,
        priority: 'high',
        root: '/mnt/datalake',
        title: 'Review suspect timestamps in bckup',
        evidence: { files: 5909, bytes: 42 },
        filesystemMutationAllowed: false,
      }],
    },
  };

  it('separates proven savings from same-size candidates and exposes no executable actions', () => {
    const model = sharedDriveUi.buildViewModel(report);
    expect(model.verifiedGroups).toBe(198);
    expect(model.provenSavingsBytes).toBe(15818791783);
    expect(model.candidateGroups).toBe(25339);
    expect(model.candidateBytesAreNotSavings).toBe(true);
    expect(model.filesToHash).toBe(42000);
    expect(model.bytesToHash).toBe(98234567);
    expect(model.verificationOutlook).toMatchObject({
      status: 'measured',
      filesToHash: 42000,
      bytesToHash: 98234567,
      cycle: { hashedFiles: 500, hashedBytes: 2000000, durationSeconds: 120 },
      capacity: { maxFiles: 1000, maxBytes: 10 * 1024 ** 3 },
    });
    expect(model.oversizedUnhashedCandidates).toEqual({
      status: 'measured',
      groups: 0,
      files: 0,
      bytesToHash: 0,
      bytesAreNotSavings: true,
      note: 'Aggregate canonical-portfolio evidence only; bytes-to-hash are not savings.',
    });
    expect(model.executableActionCount).toBe(0);
    expect(model.sharedDriveMutations).toBe(0);
    expect(model.roots[0]).toMatchObject({
      missingExtensionUnresolvedFiles: 1159,
      missingExtensionContentKnownFiles: 2,
      missingExtensionContentUnknownFiles: 1157,
    });
    expect(model.workItems[0].filesystemMutationAllowed).toBe(false);
    expect(model.organizationProgress).toMatchObject({
      status: 'compared',
      previous: '2026-07-17T01:16:12.863Z',
      counts: { new: 2, improved: 3, worsened: 1, unchanged: 5, resolved: 4 },
      totals: { current: 11, previous: 13, currentAccountedFor: 11, previousAccountedFor: 13 },
    });
    expect(model.organizationProgress.note).toMatch(/aggregate indexed-evidence changes only/i);
    expect(model.policyDecisionSupport).toMatchObject({
      available: true,
      verifiedGroups: 275,
      verifiedFiles: 1133,
      backup: { verifiedGroups: 61, provenSavingsBytes: 3191929525 },
      generatedCache: { verifiedGroups: 37, provenSavingsBytes: 706436063 },
      overlap: { verifiedGroups: 11, provenSavingsBytes: 123132839 },
      survivor: {
        groupsWithIdenticalMtime: 73,
        maximumGroupsWithDifferentSelection: 202,
        selectionDifferences: {
          canonicalVsNewest: 171,
          canonicalVsOldest: 170,
          newestVsOldest: 202,
        },
      },
    });
    expect(model.policyDecisionSupport.survivor.choices[0]).toEqual({
      value: 'canonical_active',
      description: 'Prefer a non-backup, non-cache location.',
      selectedStorageRoles: [
        { storageRole: 'media_asset', verifiedGroups: 176 },
        { storageRole: 'generated_cache', verifiedGroups: 37 },
      ],
    });
    expect(model.policyDecisionSupport.note).toMatch(/not authorization or a reclaimable-space plan/i);
  });

  it('fails closed when decision support is absent or violates its safety contract', () => {
    expect(sharedDriveUi.buildPolicyDecisionSupportViewModel({})).toMatchObject({
      available: false,
      verifiedGroups: 0,
    });

    const unsafe = JSON.parse(JSON.stringify(report));
    unsafe.policyDecisionSupport.duplicateSurvivor.recommendedValue = 'canonical_active';
    expect(sharedDriveUi.buildPolicyDecisionSupportViewModel(unsafe)).toMatchObject({
      available: false,
      reason: expect.stringMatching(/failed its safety contract/i),
    });

    const candidatesIncluded = JSON.parse(JSON.stringify(report));
    candidatesIncluded.policyDecisionSupport.basis.candidateBytesIncluded = true;
    expect(sharedDriveUi.buildPolicyDecisionSupportViewModel(candidatesIncluded).available).toBe(false);
  });

  it('states group progress and the individual-file hashing ceiling exactly', () => {
    expect(sharedDriveUi.hashingLimitMessage(
      report.evidence.hashingLimits[0],
    )).toBe('/mnt/datalake: duplicate groups >10 GiB can progress when each individual file fits budget; one individual unhashed file >10 GiB remains unverified until cap raised.');
  });

  it('shows measured verification workload but fails closed on incomplete pace evidence', () => {
    const measured = sharedDriveUi.verificationOutlookViewModel(
      report.evidence.verificationOutlook,
      report.evidence.duplicateCandidates,
    );
    expect(sharedDriveUi.verificationOutlookMessage(measured)).toMatch(
      /Verification backlog: 42.+not-current candidate file\(s\)/,
    );
    expect(sharedDriveUi.verificationOutlookMessage(measured)).toContain('Not a calendar ETA.');

    const unavailable = sharedDriveUi.verificationOutlookViewModel(
      { status: 'measured', latestCompletedCycle: {} },
      report.evidence.duplicateCandidates,
    );
    expect(unavailable).toMatchObject({
      status: 'unavailable',
      note: expect.stringMatching(/do not infer a rate or ETA/i),
    });

    const mismatched = sharedDriveUi.verificationOutlookViewModel(
      { ...report.evidence.verificationOutlook, bytesToHash: 1 },
      report.evidence.duplicateCandidates,
    );
    expect(mismatched.status).toBe('unavailable');
  });

  it('separates immediate metadata organization evidence from targeted SHA-256 proof', () => {
    const metadata = sharedDriveUi.metadataFirstViewModel(report.evidence.metadataFirst);
    expect(metadata).toMatchObject({
      status: 'measured', indexedFiles: 268567, canonicalRoots: 2
    });
    expect(sharedDriveUi.metadataFirstMessage(metadata)).toMatch(/organization evidence is ready now/i);
    expect(sharedDriveUi.metadataFirstMessage(metadata)).toMatch(/does not prove duplicates/i);

    const queue = sharedDriveUi.verificationQueueViewModel(
      report.evidence.verificationQueue,
      report.evidence.duplicateCandidates,
    );
    expect(queue).toMatchObject({
      status: 'prioritized', groups: 25339, potentialDuplicateBytes: 123456789
    });
    expect(sharedDriveUi.verificationQueueMessage(queue)).toMatch(/not savings/i);
    expect(sharedDriveUi.verificationQueueMessage(queue)).toMatch(/explicit per-action approval/i);

    const unsafe = sharedDriveUi.verificationQueueViewModel({
      ...report.evidence.verificationQueue,
      ordering: ['file_size_desc', 'potential_duplicate_bytes_desc'],
    }, report.evidence.duplicateCandidates);
    expect(unsafe.status).toBe('unavailable');
  });

  it('falls back conservatively for older unsplit reports and conserves the visible total', () => {
    const legacy = JSON.parse(JSON.stringify(report));
    delete legacy.evidence.perRoot[0].missingExtensionContentKnownFiles;
    delete legacy.evidence.perRoot[0].missingExtensionContentUnknownFiles;

    const root = sharedDriveUi.buildViewModel(legacy).roots[0];

    expect(root.missingExtensionContentKnownFiles).toBe(0);
    expect(root.missingExtensionContentUnknownFiles).toBe(1159);
    expect(
      root.missingExtensionContentKnownFiles + root.missingExtensionContentUnknownFiles,
    ).toBe(root.missingExtensionUnresolvedFiles);
  });

  it('distinguishes measured zero, positive, and unavailable oversized evidence', () => {
    const measuredZero = sharedDriveUi.oversizedHashEvidenceViewModel(
      report.evidence.oversizedUnhashedCandidates,
    );
    expect(sharedDriveUi.oversizedHashEvidenceMessage(measuredZero)).toBe(
      'Measured zero: 0 same-size candidate group(s) contain 0 individually oversized unhashed file(s), representing 0 B still to hash (not savings).',
    );

    const positive = sharedDriveUi.oversizedHashEvidenceViewModel({
      ...report.evidence.oversizedUnhashedCandidates,
      groups: 2,
      files: 3,
      bytesToHash: 24 * 1024 ** 3,
    });
    expect(sharedDriveUi.oversizedHashEvidenceMessage(positive)).toBe(
      'Measured: 2 same-size candidate group(s) contain 3 individually oversized unhashed file(s), representing 24 GiB still to hash (not savings).',
    );

    const missing = sharedDriveUi.oversizedHashEvidenceViewModel({ status: 'unavailable' });
    expect(missing).toMatchObject({
      status: 'unavailable', groups: null, files: null, bytesToHash: null,
    });
    expect(sharedDriveUi.oversizedHashEvidenceMessage(missing)).toBe(
      'Portfolio oversized-file measurement unavailable; do not infer zero.',
    );

    const unsafe = sharedDriveUi.oversizedHashEvidenceViewModel({
      ...report.evidence.oversizedUnhashedCandidates,
      groups: 1,
      files: 1,
      bytesToHash: 12,
      fileIdentityIncluded: true,
    });
    expect(unsafe.status).toBe('unavailable');
  });

  it('labels missing organization history as a baseline without inferring progress', () => {
    const legacy = JSON.parse(JSON.stringify(report));
    delete legacy.comparison.organization;

    expect(sharedDriveUi.organizationProgressViewModel(legacy)).toMatchObject({
      status: 'baseline',
      reason: 'organization_comparison_unavailable',
      counts: null,
      topChanges: [],
      note: expect.stringMatching(/no organization improvement, regression, or resolution is inferred/i),
    });
  });

  it('fails closed when organization conservation totals are inconsistent', () => {
    const inconsistent = JSON.parse(JSON.stringify(report));
    inconsistent.comparison.organization.totals.currentAccountedFor = 10;

    expect(sharedDriveUi.organizationProgressViewModel(inconsistent)).toMatchObject({
      status: 'baseline',
      reason: 'organization_comparison_invalid',
      counts: null,
      totals: null,
    });
  });
});

describe('Shared Drives Janitor OpenClaw automation evidence', () => {
  const exactJob = {
    id: sharedDriveUi.JANITOR_AUTOMATION_ID,
    name: 'renamed-job',
    enabled: true,
    agentId: 'leadx',
    schedule: { kind: 'cron', expr: '0 3 * * 0', tz: 'America/Toronto' },
    lastRunStatus: 'ok',
    consecutiveErrors: 0,
    lastRunAtMs: 1784322227891,
    nextRunAtMs: 1784444400000,
    lastDiagnosticSummary: 'Read-only assessment completed.',
  };

  const snapshot = jobs => ({
    schedules: { openclawCron: { available: true, jobs } },
  });

  it('prefers the exact job id and falls back to the stable job name', () => {
    const nameMatch = { id: 'other', name: sharedDriveUi.JANITOR_AUTOMATION_NAME };
    expect(sharedDriveUi.findJanitorAutomation(snapshot([nameMatch, exactJob]))).toBe(exactJob);
    expect(sharedDriveUi.findJanitorAutomation(snapshot([nameMatch]))).toBe(nameMatch);
  });

  it('normalizes healthy cron evidence without exposing control actions', () => {
    expect(sharedDriveUi.buildAutomationViewModel(snapshot([exactJob]))).toEqual({
      available: true,
      found: true,
      healthy: true,
      enabled: true,
      stateLabel: 'Healthy',
      status: 'ok',
      owner: 'leadx',
      schedule: '0 3 * * 0 (America/Toronto)',
      lastRunAtMs: 1784322227891,
      nextRunAtMs: 1784444400000,
      consecutiveErrors: 0,
      diagnostic: 'Read-only assessment completed.',
    });
  });

  it('fails closed for error, missing-job, and unavailable snapshot states', () => {
    const errored = sharedDriveUi.buildAutomationViewModel(snapshot([{
      ...exactJob,
      lastRunStatus: 'error',
      consecutiveErrors: 2,
      lastError: 'scan failed',
      lastDiagnosticSummary: null,
    }]));
    expect(errored).toMatchObject({ available: true, healthy: false, stateLabel: 'Error', consecutiveErrors: 2 });
    expect(errored.diagnostic).toBe('scan failed');

    expect(sharedDriveUi.buildAutomationViewModel(snapshot([]))).toMatchObject({
      available: false,
      found: false,
      healthy: false,
      stateLabel: 'Job not found',
    });
    expect(sharedDriveUi.buildAutomationViewModel({})).toMatchObject({
      available: false,
      healthy: false,
      stateLabel: 'Snapshot unavailable',
    });
  });

  it('reads the ecosystem snapshot from Core without routing through the Data proxy', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'success', data: { schedules: {} } }),
    });

    await expect(sharedDriveUi.fetchCoreJson(
      fetchImpl,
      '/api/nerve-center/ecosystem',
    )).resolves.toMatchObject({ status: 'success' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/nerve-center/ecosystem', {
      headers: { 'Content-Type': 'application/json' },
    });
  });
});

describe('Shared Drives Janitor route surface', () => {
  it('includes the review asset and contains no maintenance action endpoint', () => {
    const app = read('core/src/app.js');
    const template = read('core/views/pages/data-toolbox.ejs');
    const client = read('core/public/js/shared-drive-janitor.js');

    expect(app).toContain('<script src="/js/shared-drive-janitor.js"></script>');
    expect(template).toContain('data-jn-subtab="shared-drives"');
    expect(template).toContain('Media</strong> share physically contains its <strong>Datalake');
    expect(template).toContain('Datalake is therefore counted exactly once');
    expect(template).toContain('id="jnsd-automation-state"');
    expect(template).toContain('id="jnsd-automation-errors"');
    expect(template).toContain('id="jnsd-save-policy" disabled');
    expect(template).toContain('id="jnsd-policy-support-state"');
    expect(template).toContain('id="jnsd-policy-choice-tbody"');
    expect(template).toContain('id="jnsd-organization-progress"');
    expect(template).toContain('id="jnsd-oversized-evidence"');
    expect(template).toContain('id="jnsd-verification-outlook"');
    expect(template).toContain('id="jnsd-metadata-first"');
    expect(template).toContain('id="jnsd-verification-queue"');
    expect(template).toContain('id="jnsd-impact-survivor"');
    expect(template).toContain('<th>Missing extension total</th>');
    expect(template).toContain('<th>Content-known</th>');
    expect(template).toContain('<th>Content-unknown</th>');
    expect(template).not.toContain('(recommended)');
    expect(client).toContain("'/api/nerve-center/ecosystem'");
    expect(client).not.toContain("DataCommons.apiFetch('/api/nerve-center/ecosystem')");
    expect(client).toContain("api('/shared-drive/policy'");
    expect(client).toContain("api('/shared-drive/strategy/latest'");
    expect(client).not.toMatch(/api\(['"`]\/shared-drive\/(?:approve|execute|delete|move|archive|actions)/);
    expect(client).not.toMatch(/openclaw cron|\/api\/openclaw\/cron\/(?:run|edit|enable|disable)/);
  });
});
