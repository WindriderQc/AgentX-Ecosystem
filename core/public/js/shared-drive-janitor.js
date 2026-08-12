/**
 * SharedDriveJanitorPage -- policy and evidence review for Media + Datalake.
 *
 * This client only reads policy/strategy evidence, saves explicitly confirmed
 * policy choices, and asks the backend to regenerate a read-only report. It has
 * no maintenance approval or filesystem execution path.
 */
(function (root, factory) {
    const page = factory();
    if (typeof module === 'object' && module.exports) module.exports = page;
    if (root && root.document) {
        root.SharedDriveJanitorPage = page;
        if (root.document.readyState === 'loading') {
            root.document.addEventListener('DOMContentLoaded', page.init);
        } else {
            page.init();
        }
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const POLICY_CHOICES = Object.freeze({
        duplicateSurvivor: Object.freeze(['canonical_active', 'newest', 'oldest']),
        backupRetention: Object.freeze(['immutable_archive', 'disaster_recovery', 'staging']),
        generatedCache: Object.freeze(['review_rebuildable', 'preserve'])
    });

    const POLICY_SELECTS = Object.freeze({
        duplicateSurvivor: 'jnsd-duplicate-survivor',
        backupRetention: 'jnsd-backup-retention',
        generatedCache: 'jnsd-generated-cache'
    });

    const JANITOR_AUTOMATION_ID = '5667ddfa-5ace-49f4-8c81-717b0c4e8df0';
    const JANITOR_AUTOMATION_NAME = 'shared-drive-janitor-assessment';

    function findJanitorAutomation(snapshot = {}) {
        const jobs = snapshot?.schedules?.openclawCron?.jobs;
        if (!Array.isArray(jobs)) return null;
        return jobs.find(job => String(job?.id || '') === JANITOR_AUTOMATION_ID)
            || jobs.find(job => String(job?.name || '').toLowerCase() === JANITOR_AUTOMATION_NAME)
            || null;
    }

    function scheduleLabel(schedule = {}) {
        if (schedule.kind === 'cron') {
            const expression = String(schedule.expr || '').trim() || 'cron schedule unavailable';
            const timezone = String(schedule.tz || '').trim();
            return timezone ? `${expression} (${timezone})` : expression;
        }
        const everyMs = finiteNumber(schedule.everyMs);
        if (schedule.kind === 'every' && everyMs > 0) {
            if (everyMs % 3600000 === 0) return `Every ${everyMs / 3600000} hour(s)`;
            if (everyMs % 60000 === 0) return `Every ${everyMs / 60000} minute(s)`;
            return `Every ${everyMs / 1000} second(s)`;
        }
        return 'Schedule unavailable';
    }

    function buildAutomationViewModel(snapshot = {}) {
        const cron = snapshot?.schedules?.openclawCron;
        const job = findJanitorAutomation(snapshot);
        if (cron?.available !== true || !job) {
            return {
                available: false,
                found: Boolean(job),
                healthy: false,
                enabled: false,
                stateLabel: cron?.available === true ? 'Job not found' : 'Snapshot unavailable',
                status: 'unavailable',
                owner: 'Unavailable',
                schedule: 'Schedule unavailable',
                lastRunAtMs: null,
                nextRunAtMs: null,
                consecutiveErrors: 0,
                diagnostic: 'Live OpenClaw automation evidence is unavailable.'
            };
        }

        const enabled = job.enabled === true;
        const status = String(job.lastRunStatus || job.lastStatus || 'unknown').toLowerCase();
        const consecutiveErrors = Math.max(0, finiteNumber(job.consecutiveErrors));
        const healthy = enabled && ['ok', 'success'].includes(status) && consecutiveErrors === 0;
        let stateLabel = status === 'error' ? 'Error' : status === 'ok' ? 'OK' : status;
        if (!enabled) stateLabel = 'Disabled';
        else if (healthy) stateLabel = 'Healthy';
        else if (status === 'ok' && consecutiveErrors > 0) stateLabel = 'Recovering';

        return {
            available: true,
            found: true,
            healthy,
            enabled,
            stateLabel,
            status,
            owner: String(job.agentId || 'Unknown'),
            schedule: scheduleLabel(job.schedule || {}),
            lastRunAtMs: finiteNumber(job.lastRunAtMs) || null,
            nextRunAtMs: finiteNumber(job.nextRunAtMs) || null,
            consecutiveErrors,
            diagnostic: String(job.lastDiagnosticSummary || job.lastError || 'No run diagnostic reported.')
                .trim().slice(0, 500)
        };
    }

    function validChoice(field, value) {
        return POLICY_CHOICES[field].includes(value) ? value : '';
    }

    function policySelections(policy = {}) {
        return {
            duplicateSurvivor: validChoice('duplicateSurvivor', policy.duplicateSurvivor),
            backupRetention: validChoice('backupRetention', policy.backupRetention),
            generatedCache: validChoice('generatedCache', policy.generatedCache)
        };
    }

    function policyComplete(selections = {}) {
        return Object.keys(POLICY_CHOICES).every(
            field => POLICY_CHOICES[field].includes(selections[field])
        );
    }

    function buildPolicyRequest(selections, updatedBy = 'data-toolbox-operator') {
        if (!policyComplete(selections)) {
            throw new Error('All three shared-drive policy decisions are required.');
        }
        return {
            confirm: true,
            updated_by: updatedBy,
            policy: {
                version: 1,
                duplicateSurvivor: selections.duplicateSurvivor,
                backupRetention: selections.backupRetention,
                generatedCache: selections.generatedCache,
                maintenanceAuthorization: 'explicit_per_action'
            }
        };
    }

    function confirmPolicyRequest(selections, confirmFn, updatedBy) {
        if (!policyComplete(selections)) return null;
        const confirmed = confirmFn(
            'Save these three shared-drive policy decisions? This generates review proposals only; every maintenance action still requires separate explicit approval.'
        );
        return confirmed ? buildPolicyRequest(selections, updatedBy) : null;
    }

    function finiteNumber(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function fallbackBytes(value) {
        const bytes = Math.max(0, finiteNumber(value));
        if (bytes === 0) return '0 B';
        const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
        const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        const amount = bytes / (1024 ** index);
        return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(2)} ${units[index]}`;
    }

    async function fetchCoreJson(fetchImpl, path, opts = {}) {
        if (typeof fetchImpl !== 'function') throw new Error('Core API fetch is unavailable.');
        const response = await fetchImpl(path, {
            ...opts,
            headers: { 'Content-Type': 'application/json', ...opts.headers }
        });
        if (!response.ok) {
            const body = await response.text().catch(() => response.statusText);
            throw new Error(`${response.status}: ${body}`);
        }
        return response.json();
    }

    function unavailablePolicyDecisionSupport(reason = 'Aggregate policy decision support is unavailable.') {
        return {
            available: false,
            reason,
            verifiedGroups: 0,
            verifiedFiles: 0,
            provenSavingsBytes: 0,
            backup: { verifiedGroups: 0, provenSavingsBytes: 0, choices: [] },
            generatedCache: { verifiedGroups: 0, provenSavingsBytes: 0, choices: [] },
            overlap: { verifiedGroups: 0, provenSavingsBytes: 0 },
            survivor: {
                choices: [],
                groupsWithIdenticalMtime: 0,
                selectionDifferences: {
                    canonicalVsNewest: 0,
                    canonicalVsOldest: 0,
                    newestVsOldest: 0
                },
                maximumGroupsWithDifferentSelection: 0
            },
            note: 'This decision support selects or recommends no policy. This preview is not authorization or a reclaimable-space plan.'
        };
    }

    function normalizePolicyChoices(field, section = {}) {
        if (!Array.isArray(section.choices)) return null;
        const byValue = new Map(section.choices.map(choice => [choice?.value, choice]));
        const normalized = [];
        for (const value of POLICY_CHOICES[field]) {
            const choice = byValue.get(value);
            const description = String(choice?.description || '').trim();
            if (!description) return null;
            const selectedStorageRoles = field === 'duplicateSurvivor'
                ? (Array.isArray(choice.selectedStorageRoles) ? choice.selectedStorageRoles : [])
                    .map(row => ({
                        storageRole: String(row?.storageRole || 'not_assessed'),
                        verifiedGroups: Math.max(0, finiteNumber(row?.verifiedGroups))
                    }))
                    .filter(row => row.verifiedGroups > 0)
                : [];
            normalized.push({ value, description, selectedStorageRoles });
        }
        return normalized;
    }

    function buildPolicyDecisionSupportViewModel(report = {}) {
        const support = report.policyDecisionSupport;
        if (!support || support.mode !== 'aggregate-read-only-decision-support') {
            return unavailablePolicyDecisionSupport();
        }
        const basis = support.basis || {};
        const survivor = support.duplicateSurvivor || {};
        const backup = support.backupRetention || {};
        const generatedCache = support.generatedCache || {};
        const safety = support.safety || {};
        const choices = {
            duplicateSurvivor: normalizePolicyChoices('duplicateSurvivor', survivor),
            backupRetention: normalizePolicyChoices('backupRetention', backup),
            generatedCache: normalizePolicyChoices('generatedCache', generatedCache)
        };
        const choicesAreUnselected = [survivor, backup, generatedCache].every(
            section => section.selectedValue == null && section.recommendedValue == null
        );
        const safe = safety.policyPersisted === false
            && finiteNumber(safety.proposalsCreated) === 0
            && safety.approvalRequested === false
            && safety.executionAuthorized === false
            && finiteNumber(safety.sharedDriveMutations) === 0;
        if (
            basis.unverifiedCandidatesExcluded !== true
            || basis.candidateBytesIncluded !== false
            || !Object.values(choices).every(Boolean)
            || !choicesAreUnselected
            || !safe
        ) {
            return unavailablePolicyDecisionSupport(
                'Aggregate policy decision support failed its safety contract and was not rendered.'
            );
        }

        return {
            available: true,
            reason: null,
            verifiedGroups: Math.max(0, finiteNumber(basis.verifiedGroups)),
            verifiedFiles: Math.max(0, finiteNumber(basis.verifiedFiles)),
            provenSavingsBytes: Math.max(0, finiteNumber(basis.provenSavingsBytes)),
            backup: {
                verifiedGroups: Math.max(0, finiteNumber(backup.verifiedGroups)),
                provenSavingsBytes: Math.max(0, finiteNumber(backup.provenSavingsBytes)),
                choices: choices.backupRetention
            },
            generatedCache: {
                verifiedGroups: Math.max(0, finiteNumber(generatedCache.verifiedGroups)),
                provenSavingsBytes: Math.max(0, finiteNumber(generatedCache.provenSavingsBytes)),
                choices: choices.generatedCache
            },
            overlap: {
                verifiedGroups: Math.max(0, finiteNumber(support.overlap?.verifiedGroups)),
                provenSavingsBytes: Math.max(0, finiteNumber(support.overlap?.provenSavingsBytes))
            },
            survivor: {
                choices: choices.duplicateSurvivor,
                groupsWithIdenticalMtime: Math.max(0, finiteNumber(survivor.groupsWithIdenticalMtime)),
                selectionDifferences: {
                    canonicalVsNewest: Math.max(0, finiteNumber(survivor.selectionDifferences?.canonicalVsNewest)),
                    canonicalVsOldest: Math.max(0, finiteNumber(survivor.selectionDifferences?.canonicalVsOldest)),
                    newestVsOldest: Math.max(0, finiteNumber(survivor.selectionDifferences?.newestVsOldest))
                },
                maximumGroupsWithDifferentSelection: Math.max(
                    0,
                    finiteNumber(survivor.maximumGroupsWithDifferentSelection)
                )
            },
            note: 'This decision support selects or recommends no policy. This preview is not authorization or a reclaimable-space plan.'
        };
    }

    function hashingLimitMessage(row, formatBytes = fallbackBytes) {
        const ceiling = finiteNumber(row?.hashMaxBytes);
        if (!ceiling) {
            return `${row?.root || 'This root'}: no hashing byte ceiling is recorded; duplicate evidence remains incomplete.`;
        }
        const formatted = formatBytes(ceiling);
        return `${row?.root || 'This root'}: duplicate groups >${formatted} can progress when each individual file fits budget; one individual unhashed file >${formatted} remains unverified until cap raised.`;
    }

    function oversizedHashEvidenceViewModel(evidence = {}) {
        const values = [evidence.groups, evidence.files, evidence.bytesToHash];
        const measured = evidence.status === 'measured'
            && values.every(value => Number.isFinite(value) && value >= 0)
            && evidence.bytesAreNotSavings === true
            && evidence.fileIdentityIncluded === false
            && evidence.filesystemMutationAllowed === false;
        if (!measured) {
            return {
                status: 'unavailable',
                groups: null,
                files: null,
                bytesToHash: null,
                bytesAreNotSavings: true,
                note: 'Portfolio oversized-file evidence is unavailable; do not infer a measured zero.'
            };
        }
        return {
            status: 'measured',
            groups: Math.max(0, finiteNumber(evidence.groups)),
            files: Math.max(0, finiteNumber(evidence.files)),
            bytesToHash: Math.max(0, finiteNumber(evidence.bytesToHash)),
            bytesAreNotSavings: true,
            note: 'Aggregate canonical-portfolio evidence only; bytes-to-hash are not savings.'
        };
    }

    function oversizedHashEvidenceMessage(model, formatBytes = fallbackBytes) {
        if (model?.status !== 'measured') {
            return 'Portfolio oversized-file measurement unavailable; do not infer zero.';
        }
        const prefix = model.groups === 0 && model.files === 0
            ? 'Measured zero:'
            : 'Measured:';
        return `${prefix} ${Number(model.groups).toLocaleString()} same-size candidate group(s) contain `
            + `${Number(model.files).toLocaleString()} individually oversized unhashed file(s), representing `
            + `${formatBytes(Number(model.bytesToHash))} still to hash (not savings).`;
    }

    function metadataFirstViewModel(input = {}) {
        const measured = input.status === 'measured'
            && Number.isInteger(input.indexedFiles)
            && input.indexedFiles >= 0
            && Number.isFinite(input.indexedBytes)
            && input.indexedBytes >= 0
            && Number.isInteger(input.canonicalRoots)
            && input.canonicalRoots > 0
            && input.organizationReviewAvailable === true
            && input.exactDuplicateProofRequired === true
            && input.filesystemMutationAllowed === false;
        if (!measured) {
            return {
                status: 'unavailable',
                indexedFiles: null,
                indexedBytes: null,
                canonicalRoots: null,
                signals: [],
                note: 'Metadata-first organization readiness is unavailable; do not infer that the index is current.'
            };
        }
        return {
            status: 'measured',
            indexedFiles: input.indexedFiles,
            indexedBytes: input.indexedBytes,
            canonicalRoots: input.canonicalRoots,
            signals: Array.isArray(input.signals) ? input.signals.map(String).slice(0, 8) : [],
            note: 'Indexed metadata supports organization review now. It does not prove duplicates or authorize file changes.'
        };
    }

    function metadataFirstMessage(model, formatBytes = fallbackBytes) {
        if (model?.status !== 'measured') return model?.note || 'Metadata-first organization readiness unavailable.';
        const signals = model.signals.length ? ` Signals: ${model.signals.join(', ')}.` : '';
        return `Metadata-first lane: organization evidence is ready now for ${Number(model.indexedFiles).toLocaleString()} indexed file(s) / ${formatBytes(Number(model.indexedBytes))} across ${Number(model.canonicalRoots).toLocaleString()} canonical root(s).${signals} It does not prove duplicates; exact SHA-256 is still required before any explicitly approved duplicate action.`;
    }

    function verificationQueueViewModel(queue = {}, candidates = {}) {
        const candidateValues = ['groups', 'files', 'candidateBytes', 'filesToHash', 'bytesToHash'];
        const queueValues = [
            queue.groups,
            queue.files,
            queue.potentialDuplicateBytes,
            queue.filesToHash,
            queue.bytesToHash
        ];
        const validNumbers = candidateValues.every(key => Number.isFinite(candidates[key]) && candidates[key] >= 0)
            && queueValues.every(value => Number.isFinite(value) && value >= 0);
        const matchesCandidates = validNumbers
            && queue.groups === candidates.groups
            && queue.files === candidates.files
            && queue.potentialDuplicateBytes === candidates.candidateBytes
            && queue.filesToHash === candidates.filesToHash
            && queue.bytesToHash === candidates.bytesToHash;
        const ordering = Array.isArray(queue.ordering) ? queue.ordering.map(String) : [];
        const validOrdering = ordering.length === 2
            && ordering[0] === 'potential_duplicate_bytes_desc'
            && ordering[1] === 'file_size_desc';
        const valid = matchesCandidates
            && validOrdering
            && ['prioritized', 'empty'].includes(queue.status)
            && queue.potentialDuplicateBytesAreNotSavings === true
            && queue.exactDuplicateProofRequired === true
            && queue.filesystemMutationAllowed === false;
        if (!valid) {
            return {
                status: 'unavailable',
                groups: null,
                potentialDuplicateBytes: null,
                note: 'Targeted SHA-256 proof queue unavailable; do not infer its order, savings, or authorization.'
            };
        }
        return {
            status: queue.status,
            groups: queue.groups,
            potentialDuplicateBytes: queue.potentialDuplicateBytes,
            note: queue.status === 'prioritized'
                ? 'Candidate groups are ranked by aggregate potential duplicate bytes, then file size. This is proof prioritization, not a savings estimate or action authorization.'
                : 'No current same-size candidate groups require SHA-256 verification.'
        };
    }

    function verificationQueueMessage(model, formatBytes = fallbackBytes) {
        if (model?.status === 'unavailable') return model?.note || 'Targeted SHA-256 proof queue unavailable.';
        if (model.status === 'empty') return model.note;
        return `Targeted proof lane: SHA-256 starts with ${Number(model.groups).toLocaleString()} same-size candidate group(s), ordered by aggregate potential duplicate bytes then file size. ${formatBytes(Number(model.potentialDuplicateBytes))} is prioritization evidence only—not savings. Exact proof and explicit per-action approval remain required.`;
    }

    function verificationOutlookViewModel(outlook = {}, candidates = {}) {
        const rawBacklogFiles = candidates.filesToHash;
        const rawBacklogBytes = candidates.bytesToHash;
        const rawOutlookFiles = outlook.filesToHash;
        const rawOutlookBytes = outlook.bytesToHash;
        const backlogFiles = finiteNumber(rawBacklogFiles);
        const backlogBytes = finiteNumber(rawBacklogBytes);
        const cycle = outlook.latestCompletedCycle || {};
        const capacity = outlook.configuredCapacity || {};
        const measured = outlook.status === 'measured'
            && Number.isFinite(rawBacklogFiles)
            && rawBacklogFiles >= 0
            && Number.isFinite(rawBacklogBytes)
            && rawBacklogBytes >= 0
            && rawOutlookFiles === rawBacklogFiles
            && rawOutlookBytes === rawBacklogBytes
            && [
                cycle.hashedFiles,
                cycle.hashedBytes,
                cycle.durationSeconds,
                cycle.estimatedComparableCyclesLowerBound,
                capacity.maxFiles,
                capacity.maxBytes,
                capacity.estimatedCyclesLowerBound
            ].every(value => Number.isFinite(value) && value >= 0)
            && cycle.durationSeconds > 0;
        if (!measured) {
            return {
                status: 'unavailable',
                filesToHash: null,
                bytesToHash: null,
                cycle: null,
                capacity: null,
                note: 'Verification backlog or pace is unavailable; do not infer a rate or ETA.'
            };
        }
        return {
            status: 'measured',
            filesToHash: Math.max(0, backlogFiles),
            bytesToHash: Math.max(0, backlogBytes),
            cycle: {
                hashedFiles: Math.max(0, finiteNumber(cycle.hashedFiles)),
                hashedBytes: Math.max(0, finiteNumber(cycle.hashedBytes)),
                durationSeconds: Math.max(0, finiteNumber(cycle.durationSeconds)),
                estimatedComparableCyclesLowerBound: Math.max(
                    0,
                    finiteNumber(cycle.estimatedComparableCyclesLowerBound)
                )
            },
            capacity: {
                maxFiles: Math.max(0, finiteNumber(capacity.maxFiles)),
                maxBytes: Math.max(0, finiteNumber(capacity.maxBytes)),
                estimatedCyclesLowerBound: Math.max(
                    0,
                    finiteNumber(capacity.estimatedCyclesLowerBound)
                )
            },
            note: 'All counts are aggregate verification evidence only; cycle estimates are lower bounds, not a calendar ETA or reclaimable-space estimate.'
        };
    }

    function verificationOutlookMessage(model, formatBytes = fallbackBytes) {
        if (model?.status !== 'measured') return model?.note || 'Verification pace unavailable.';
        const minutes = Math.max(1, Math.round(model.cycle.durationSeconds / 60));
        return `Verification backlog: ${Number(model.filesToHash).toLocaleString()} not-current candidate file(s), `
            + `${formatBytes(Number(model.bytesToHash))} to hash (not savings). Latest successful scans for both roots hashed `
            + `${Number(model.cycle.hashedFiles).toLocaleString()} file(s) / ${formatBytes(Number(model.cycle.hashedBytes))} in `
            + `${minutes} min; lower bound: ~${Number(model.cycle.estimatedComparableCyclesLowerBound).toLocaleString()} comparable `
            + `cycles at observed throughput, ~${Number(model.capacity.estimatedCyclesLowerBound).toLocaleString()} at configured capacity. Not a calendar ETA.`;
    }

    function missingExtensionSplit(row = {}) {
        const total = Math.max(0, finiteNumber(row.missingExtensionUnresolvedFiles));
        const hasSplit = Object.prototype.hasOwnProperty.call(row, 'missingExtensionContentKnownFiles')
            && Object.prototype.hasOwnProperty.call(row, 'missingExtensionContentUnknownFiles');
        if (!hasSplit) return { total, contentKnown: 0, contentUnknown: total };
        const contentKnown = Math.min(
            total,
            Math.max(0, finiteNumber(row.missingExtensionContentKnownFiles))
        );
        return { total, contentKnown, contentUnknown: total - contentKnown };
    }

    function organizationProgressViewModel(report = {}) {
        const comparison = report.comparison || {};
        const organization = comparison.organization || {};
        const previous = comparison.previousGeneratedAt || comparison.previousReportId || null;
        if (organization.status !== 'compared') {
            return {
                status: 'baseline',
                reason: String(organization.reason || 'organization_comparison_unavailable'),
                previous,
                counts: null,
                totals: null,
                topChanges: [],
                note: 'No organization improvement, regression, or resolution is inferred.'
            };
        }
        const counts = organization.counts || {};
        const totals = organization.totals || {};
        const countValues = ['new', 'improved', 'worsened', 'unchanged', 'resolved']
            .map(key => counts[key]);
        const totalValues = [
            'current', 'previous', 'union', 'currentAccountedFor', 'previousAccountedFor'
        ].map(key => totals[key]);
        const invalid = [...countValues, ...totalValues].some(value => (
            !Number.isInteger(value) || value < 0
        )) || (
            counts.new + counts.improved + counts.worsened + counts.unchanged
            !== totals.currentAccountedFor
        ) || (
            counts.resolved + counts.improved + counts.worsened + counts.unchanged
            !== totals.previousAccountedFor
        ) || totals.currentAccountedFor !== totals.current
            || totals.previousAccountedFor !== totals.previous
            || counts.new + counts.improved + counts.worsened + counts.unchanged + counts.resolved
                !== totals.union;
        if (invalid) {
            return {
                status: 'baseline',
                reason: 'organization_comparison_invalid',
                previous,
                counts: null,
                totals: null,
                topChanges: [],
                note: 'No organization improvement, regression, or resolution is inferred.'
            };
        }
        return {
            status: 'compared',
            reason: null,
            previous,
            counts: {
                new: Math.max(0, finiteNumber(counts.new)),
                improved: Math.max(0, finiteNumber(counts.improved)),
                worsened: Math.max(0, finiteNumber(counts.worsened)),
                unchanged: Math.max(0, finiteNumber(counts.unchanged)),
                resolved: Math.max(0, finiteNumber(counts.resolved))
            },
            totals: {
                current: Math.max(0, finiteNumber(totals.current)),
                previous: Math.max(0, finiteNumber(totals.previous)),
                union: Math.max(0, finiteNumber(totals.union)),
                currentAccountedFor: Math.max(0, finiteNumber(totals.currentAccountedFor)),
                previousAccountedFor: Math.max(0, finiteNumber(totals.previousAccountedFor))
            },
            topChanges: Array.isArray(organization.topChanges)
                ? organization.topChanges.slice(0, 12)
                : [],
            note: 'Labels describe aggregate indexed-evidence changes only; they do not prove cleanup or authorize file changes.'
        };
    }

    function buildViewModel(report = {}) {
        const evidence = report.evidence || {};
        const candidates = evidence.duplicateCandidates || {};
        const maintenance = report.maintenance || {};
        const safety = report.safety || {};
        const limits = Array.isArray(evidence.hashingLimits) ? evidence.hashingLimits : [];
        const roots = Array.isArray(evidence.perRoot) ? evidence.perRoot : [];
        const workItems = Array.isArray(report.organizationStrategy?.workItems)
            ? report.organizationStrategy.workItems
            : [];
        return {
            generatedAt: report.generatedAt || null,
            status: String(report.status || 'unknown'),
            decisionsRequired: Array.isArray(report.decisions_required) ? report.decisions_required : [],
            verifiedGroups: finiteNumber(evidence.verifiedDuplicateGroups),
            verifiedFiles: finiteNumber(evidence.verifiedDuplicateFiles),
            provenSavingsBytes: finiteNumber(evidence.provenSavingsBytes),
            candidateGroups: finiteNumber(candidates.groups),
            candidateFiles: finiteNumber(candidates.files),
            candidateBytes: finiteNumber(candidates.candidateBytes),
            filesToHash: finiteNumber(candidates.filesToHash),
            bytesToHash: finiteNumber(candidates.bytesToHash),
            candidateBytesAreNotSavings: candidates.candidateBytesAreNotSavings !== false,
            verifiedDuplicatesAreLowerBound: evidence.verifiedDuplicatesAreLowerBound !== false,
            metadataFirst: metadataFirstViewModel(evidence.metadataFirst),
            verificationQueue: verificationQueueViewModel(evidence.verificationQueue, candidates),
            verificationOutlook: verificationOutlookViewModel(
                evidence.verificationOutlook,
                candidates
            ),
            oversizedUnhashedCandidates: oversizedHashEvidenceViewModel(
                evidence.oversizedUnhashedCandidates
            ),
            hashingLimits: limits.map(row => ({
                root: String(row?.root || ''),
                hashMaxBytes: finiteNumber(row?.hashMaxBytes),
                message: hashingLimitMessage(row)
            })),
            roots: roots.map(row => {
                const missing = missingExtensionSplit(row);
                return {
                    root: String(row?.root || ''),
                    totalFiles: finiteNumber(row?.totalFiles),
                    totalBytes: finiteNumber(row?.totalBytes),
                    unclassifiedFiles: finiteNumber(row?.unclassifiedFiles),
                    missingExtensionUnresolvedFiles: missing.total,
                    missingExtensionContentKnownFiles: missing.contentKnown,
                    missingExtensionContentUnknownFiles: missing.contentUnknown,
                    timestampReviewFiles: finiteNumber(row?.timestampReviewFiles)
                };
            }),
            proposalCount: Array.isArray(maintenance.proposals) ? maintenance.proposals.length : 0,
            executableActionCount: Array.isArray(maintenance.executableActions) ? maintenance.executableActions.length : 0,
            sharedDriveMutations: finiteNumber(safety.sharedDriveMutations),
            approvalEndpointsCalled: safety.approvalEndpointsCalled === true,
            deleteMoveArchiveExecuted: safety.deleteMoveArchiveExecuted === true,
            policyDecisionSupport: buildPolicyDecisionSupportViewModel(report),
            organizationProgress: organizationProgressViewModel(report),
            workItems: workItems.map(item => ({
                id: String(item?.id || ''),
                rank: finiteNumber(item?.rank),
                priority: String(item?.priority || 'review'),
                root: String(item?.root || ''),
                title: String(item?.title || ''),
                files: finiteNumber(item?.evidence?.files),
                bytes: finiteNumber(item?.evidence?.bytes),
                disposition: String(item?.disposition || 'review_metadata_or_classification_rule'),
                likelyMirrorOf: Array.isArray(item?.likelyMirrorOf)
                    ? item.likelyMirrorOf.map(value => String(value)).slice(0, 3)
                    : [],
                likelyMirrorEvidenceOnly: item?.likelyMirrorEvidenceOnly === true,
                filesystemMutationAllowed: item?.filesystemMutationAllowed === true
            }))
        };
    }

    function init() {
        const documentRef = typeof document !== 'undefined' ? document : null;
        if (!documentRef || !documentRef.getElementById('jn-subtab-shared-drives')) return;

        const $ = id => documentRef.getElementById(id);
        const api = (path, opts) => DataCommons.apiFetch(`/api/data/janitor/profiles${path}`, opts);
        const ecosystemApi = () => fetchCoreJson(
            window.fetch.bind(window),
            '/api/nerve-center/ecosystem'
        );
        const toast = (message, type = 'info') => window.AgentXUtils.showToast(message, type);
        const esc = value => window.AgentXUtils.escapeHtml(String(value ?? ''));
        const fmtBytes = value => window.AgentXUtils.formatBytes(finiteNumber(value));
        let loaded = false;
        let busy = false;

        function apiError(err) {
            const match = err?.message?.match(/^(\d+):\s*([\s\S]*)$/);
            if (!match) return err?.message || 'Unknown error';
            try {
                const body = JSON.parse(match[2]);
                if (Array.isArray(body.errors) && body.errors.length) return body.errors.join(' - ');
                if (body.message) return body.message;
            } catch (_) { /* keep raw response */ }
            return `${match[1]}: ${match[2]}`;
        }

        function readSelections() {
            return Object.fromEntries(
                Object.entries(POLICY_SELECTS).map(([field, id]) => [field, $(id)?.value || ''])
            );
        }

        function syncSaveButton() {
            const button = $('jnsd-save-policy');
            if (button) button.disabled = busy || !policyComplete(readSelections());
        }

        function setBusy(next) {
            busy = next;
            if ($('jnsd-refresh-btn')) $('jnsd-refresh-btn').disabled = next;
            if ($('jnsd-generate-btn')) $('jnsd-generate-btn').disabled = next;
            syncSaveButton();
        }

        function renderAutomation(snapshot = {}) {
            const model = buildAutomationViewModel(snapshot);
            const state = $('jnsd-automation-state');
            if (state) {
                state.textContent = `${model.stateLabel} - ${model.enabled ? 'enabled' : 'not enabled'}`;
                state.style.color = model.healthy ? '#22c55e' : '#f59e0b';
            }
            if ($('jnsd-automation-owner')) $('jnsd-automation-owner').textContent = model.owner;
            if ($('jnsd-automation-schedule')) $('jnsd-automation-schedule').textContent = model.schedule;
            if ($('jnsd-automation-last')) {
                $('jnsd-automation-last').textContent = model.lastRunAtMs
                    ? new Date(model.lastRunAtMs).toLocaleString()
                    : 'No completed run reported';
            }
            if ($('jnsd-automation-next')) {
                $('jnsd-automation-next').textContent = model.nextRunAtMs
                    ? new Date(model.nextRunAtMs).toLocaleString()
                    : 'No next run reported';
            }
            if ($('jnsd-automation-errors')) {
                $('jnsd-automation-errors').textContent = model.consecutiveErrors.toLocaleString();
            }
            if ($('jnsd-automation-diagnostic')) {
                $('jnsd-automation-diagnostic').textContent = model.diagnostic;
            }
        }

        async function loadAutomation() {
            try {
                const response = await ecosystemApi();
                renderAutomation(response?.data || {});
            } catch (err) {
                renderAutomation({});
                if ($('jnsd-automation-diagnostic')) {
                    $('jnsd-automation-diagnostic').textContent = `AgentX snapshot unavailable: ${apiError(err)}`;
                }
            }
        }

        function renderPolicy(data = {}) {
            const selections = policySelections(data.policy || {});
            Object.entries(POLICY_SELECTS).forEach(([field, id]) => {
                const select = $(id);
                if (select) select.value = selections[field];
            });
            const remaining = Array.isArray(data.decisions_required) ? data.decisions_required.length : 3;
            const updated = data.policy?.updatedAt
                ? ` - last saved ${new Date(data.policy.updatedAt).toLocaleString()}`
                : '';
            $('jnsd-policy-state').textContent = remaining
                ? `${remaining} decision${remaining === 1 ? '' : 's'} required${updated}`
                : `Complete${updated}`;
            syncSaveButton();
        }

        function renderPolicyDecisionSupport(model) {
            const state = $('jnsd-policy-support-state');
            const note = $('jnsd-policy-support-note');
            const survivorImpact = $('jnsd-impact-survivor');
            const backupImpact = $('jnsd-impact-backup');
            const cacheImpact = $('jnsd-impact-cache');
            const differences = $('jnsd-survivor-differences');
            const tbody = $('jnsd-policy-choice-tbody');
            if (!model.available) {
                if (state) state.textContent = 'Unavailable';
                if (note) note.textContent = `${model.reason} ${model.note}`;
                [survivorImpact, backupImpact, cacheImpact].forEach(element => {
                    if (element) element.textContent = 'Verified-group impact unavailable; no choice was inferred.';
                });
                if (differences) differences.textContent = 'Survivor-rule comparison unavailable.';
                if (tbody) {
                    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--muted); padding:20px;">Decision support unavailable; policy selectors remain explicit and unselected.</td></tr>';
                }
                return;
            }

            if (state) state.textContent = `${model.verifiedGroups.toLocaleString()} verified groups only`;
            if (note) note.textContent = model.note;
            if (survivorImpact) {
                survivorImpact.textContent = (
                    `${model.survivor.maximumGroupsWithDifferentSelection.toLocaleString()} of `
                    + `${model.verifiedGroups.toLocaleString()} verified groups choose a different survivor under at least one rule; `
                    + `${model.survivor.groupsWithIdenticalMtime.toLocaleString()} groups have identical timestamps.`
                );
            }
            if (backupImpact) {
                backupImpact.textContent = (
                    `${model.backup.verifiedGroups.toLocaleString()} verified groups; `
                    + `${fmtBytes(model.backup.provenSavingsBytes)} of proven-savings evidence is policy-affected.`
                );
            }
            if (cacheImpact) {
                cacheImpact.textContent = (
                    `${model.generatedCache.verifiedGroups.toLocaleString()} verified groups; `
                    + `${fmtBytes(model.generatedCache.provenSavingsBytes)} of proven-savings evidence is policy-affected; `
                    + `${model.overlap.verifiedGroups.toLocaleString()} groups overlap backup evidence.`
                );
            }
            const pairwise = model.survivor.selectionDifferences;
            if (differences) {
                differences.textContent = (
                    `Pairwise survivor differences: canonical vs newest ${pairwise.canonicalVsNewest.toLocaleString()}; `
                    + `canonical vs oldest ${pairwise.canonicalVsOldest.toLocaleString()}; `
                    + `newest vs oldest ${pairwise.newestVsOldest.toLocaleString()}.`
                );
            }
            if (tbody) {
                const rows = [
                    ...model.survivor.choices.map(choice => ({
                        field: 'Duplicate survivor',
                        ...choice,
                        aggregate: choice.selectedStorageRoles.length
                            ? choice.selectedStorageRoles.map(row => (
                                `${row.storageRole}: ${row.verifiedGroups.toLocaleString()}`
                            )).join(', ')
                            : 'No selected-role evidence'
                    })),
                    ...model.backup.choices.map(choice => ({
                        field: 'Backup retention',
                        ...choice,
                        aggregate: `${model.backup.verifiedGroups.toLocaleString()} affected verified groups`
                    })),
                    ...model.generatedCache.choices.map(choice => ({
                        field: 'Generated cache',
                        ...choice,
                        aggregate: `${model.generatedCache.verifiedGroups.toLocaleString()} affected verified groups`
                    }))
                ];
                tbody.innerHTML = rows.map(row => `
                    <tr>
                        <td>${esc(row.field)}</td>
                        <td><code>${esc(row.value)}</code></td>
                        <td>${esc(row.description)}</td>
                        <td>${esc(row.aggregate)}</td>
                    </tr>
                `).join('');
            }
        }

        function renderReport(report) {
            const model = buildViewModel(report);
            renderPolicyDecisionSupport(model.policyDecisionSupport);
            $('jnsd-report-time').textContent = model.generatedAt
                ? `Report ${new Date(model.generatedAt).toLocaleString()}`
                : 'Report time unavailable';
            $('jnsd-strategy-state').textContent = `${model.status} - ${model.decisionsRequired.length} decisions remaining`;
            $('jnsd-stat-groups').textContent = model.verifiedGroups.toLocaleString();
            $('jnsd-stat-savings').textContent = fmtBytes(model.provenSavingsBytes);
            $('jnsd-stat-candidates').textContent = `${model.candidateGroups.toLocaleString()} / ${model.candidateFiles.toLocaleString()} files`;
            $('jnsd-stat-proposals').textContent = model.proposalCount.toLocaleString();
            $('jnsd-stat-executable').textContent = model.executableActionCount.toLocaleString();

            $('jnsd-evidence-note').innerHTML = `
                Verified SHA-256 duplicates and ${esc(fmtBytes(model.provenSavingsBytes))} of proven savings are a <strong>lower bound</strong>.
                The ${esc(model.candidateGroups.toLocaleString())} same-size candidate groups are not verified duplicates, and their
                ${esc(fmtBytes(model.candidateBytes))} of candidate bytes are <strong>not a reclaimable-space estimate</strong>.<br>
                Safety evidence: ${esc(model.sharedDriveMutations)} shared-drive mutations; approval endpoints called:
                <strong>${model.approvalEndpointsCalled ? 'yes' : 'no'}</strong>; delete/move/archive executed:
                <strong>${model.deleteMoveArchiveExecuted ? 'yes' : 'no'}</strong>. Reported executable actions:
                <strong>${esc(model.executableActionCount)}</strong> (never exposed for execution on this screen).
            `;
            if ($('jnsd-metadata-first')) {
                $('jnsd-metadata-first').textContent = metadataFirstMessage(model.metadataFirst, fmtBytes);
            }
            if ($('jnsd-verification-queue')) {
                $('jnsd-verification-queue').textContent = verificationQueueMessage(model.verificationQueue, fmtBytes);
            }
            if ($('jnsd-verification-outlook')) {
                $('jnsd-verification-outlook').textContent = verificationOutlookMessage(
                    model.verificationOutlook,
                    fmtBytes
                );
            }

            $('jnsd-hashing-limits').innerHTML = model.hashingLimits.length
                ? model.hashingLimits.map(row => `
                    <div style="margin-top:5px;"><i class="fas fa-triangle-exclamation" style="color:#f59e0b;"></i>
                    ${esc(hashingLimitMessage(row))}</div>
                `).join('')
                : '<div><i class="fas fa-triangle-exclamation" style="color:#f59e0b;"></i> No hashing ceiling is recorded; duplicate evidence remains incomplete.</div>';
            if ($('jnsd-oversized-evidence')) {
                const oversized = model.oversizedUnhashedCandidates;
                const iconColor = oversized.status === 'measured' && oversized.groups === 0
                    ? '#22c55e'
                    : '#f59e0b';
                $('jnsd-oversized-evidence').innerHTML = `
                    <i class="fas fa-ruler-combined" style="color:${iconColor};"></i>
                    ${esc(oversizedHashEvidenceMessage(oversized, fmtBytes))}
                `;
            }

            $('jnsd-roots-tbody').innerHTML = model.roots.length
                ? model.roots.map(row => `
                    <tr>
                        <td><code>${esc(row.root)}</code></td>
                        <td>${esc(row.totalFiles.toLocaleString())}</td>
                        <td>${esc(fmtBytes(row.totalBytes))}</td>
                        <td>${esc(row.unclassifiedFiles.toLocaleString())}</td>
                        <td>${esc(row.missingExtensionUnresolvedFiles.toLocaleString())}</td>
                        <td>${esc(row.missingExtensionContentKnownFiles.toLocaleString())}</td>
                        <td>${esc(row.missingExtensionContentUnknownFiles.toLocaleString())}</td>
                        <td>${esc(row.timestampReviewFiles.toLocaleString())}</td>
                    </tr>
                `).join('')
                : '<tr><td colspan="8" style="text-align:center; color:var(--muted); padding:20px;">No root evidence in this report.</td></tr>';

            const progress = model.organizationProgress;
            if ($('jnsd-organization-progress')) {
                if (progress.status === 'compared') {
                    const counts = progress.counts;
                    const previous = progress.previous
                        ? ` vs ${new Date(progress.previous).toString() === 'Invalid Date' ? progress.previous : new Date(progress.previous).toLocaleString()}`
                        : '';
                    $('jnsd-organization-progress').textContent = (
                        `Aggregate evidence progress${previous}: ${counts.new.toLocaleString()} new, `
                        + `${counts.improved.toLocaleString()} improved, ${counts.worsened.toLocaleString()} worsened, `
                        + `${counts.unchanged.toLocaleString()} unchanged, ${counts.resolved.toLocaleString()} resolved. `
                        + `${progress.totals.currentAccountedFor.toLocaleString()} of `
                        + `${progress.totals.current.toLocaleString()} current candidates accounted for. ${progress.note}`
                    );
                } else {
                    $('jnsd-organization-progress').textContent = (
                        `Organization trend baseline (${progress.reason}); ${progress.note}`
                    );
                }
            }

            $('jnsd-work-tbody').innerHTML = model.workItems.length
                ? model.workItems.map(item => `
                    <tr>
                        <td>${esc(item.rank)}</td>
                        <td><span class="jn-stat-tag">${esc(item.priority)}</span></td>
                        <td><code>${esc(item.root)}</code></td>
                        <td>${esc(item.title)}${item.likelyMirrorEvidenceOnly && item.likelyMirrorOf.length
                            ? `<br><small style="color:var(--muted);">Correlated aggregate evidence only: ${esc(item.likelyMirrorOf.join(', '))}; not duplicate proof.</small>`
                            : ''}</td>
                        <td>${esc(item.files.toLocaleString())} files - ${esc(fmtBytes(item.bytes))}</td>
                        <td><strong>${item.filesystemMutationAllowed ? 'Not exposed here' : 'Not allowed'}</strong><br><small>${esc(item.disposition)}</small></td>
                    </tr>
                `).join('')
                : '<tr><td colspan="6" style="text-align:center; color:var(--muted); padding:20px;">No indexed metadata hotspots.</td></tr>';
        }

        function renderMissingReport() {
            renderPolicyDecisionSupport(unavailablePolicyDecisionSupport('No strategy report is available.'));
            $('jnsd-report-time').textContent = 'No strategy report yet';
            $('jnsd-strategy-state').textContent = 'Generate a read-only evidence report';
            $('jnsd-evidence-note').textContent = 'No strategy report is available. Refresh Evidence creates a database report without modifying shared-drive files.';
            if ($('jnsd-verification-outlook')) {
                $('jnsd-verification-outlook').textContent = 'Verification backlog and pace unavailable; no rate or ETA is inferred.';
            }
            $('jnsd-hashing-limits').textContent = '';
            if ($('jnsd-organization-progress')) {
                $('jnsd-organization-progress').textContent = 'Organization trend unavailable; no progress is inferred.';
            }
            ['groups', 'savings', 'candidates', 'proposals', 'executable'].forEach(key => {
                $(`jnsd-stat-${key}`).textContent = '--';
            });
            $('jnsd-roots-tbody').innerHTML = '<tr><td colspan="8" style="text-align:center; color:var(--muted); padding:20px;">No report.</td></tr>';
            $('jnsd-work-tbody').innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--muted); padding:20px;">No report.</td></tr>';
        }

        async function load() {
            if (busy) return;
            setBusy(true);
            const automationLoad = loadAutomation();
            try {
                const policyResponse = await api('/shared-drive/policy');
                renderPolicy(policyResponse?.data || {});
                try {
                    const reportResponse = await api('/shared-drive/strategy/latest');
                    renderReport(reportResponse?.data?.report || {});
                } catch (err) {
                    if (String(err?.message || '').startsWith('404:')) renderMissingReport();
                    else throw err;
                }
                loaded = true;
            } catch (err) {
                toast(`Shared-drive review failed: ${apiError(err)}`, 'error');
            } finally {
                await automationLoad;
                setBusy(false);
            }
        }

        async function generateStrategy({ silent = false } = {}) {
            if (busy) return null;
            setBusy(true);
            try {
                const response = await api('/shared-drive/strategy', { method: 'POST' });
                const report = response?.data?.report || null;
                if (report) renderReport(report);
                if (!silent) toast('Read-only shared-drive evidence refreshed', 'success');
                loaded = true;
                return report;
            } catch (err) {
                toast(`Evidence refresh failed: ${apiError(err)}`, 'error');
                return null;
            } finally {
                setBusy(false);
            }
        }

        async function savePolicy() {
            const request = confirmPolicyRequest(
                readSelections(),
                message => window.confirm(message),
                'data-toolbox-operator'
            );
            if (!request || busy) return;
            setBusy(true);
            try {
                await api('/shared-drive/policy', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(request)
                });
                await api('/shared-drive/strategy', { method: 'POST' });
                toast('Shared-drive policy saved; read-only strategy regenerated', 'success');
                loaded = false;
            } catch (err) {
                toast(`Policy save failed: ${apiError(err)}`, 'error');
            } finally {
                setBusy(false);
            }
            if (!loaded) await load();
        }

        Object.values(POLICY_SELECTS).forEach(id => $(id)?.addEventListener('change', syncSaveButton));
        $('jnsd-save-policy')?.addEventListener('click', savePolicy);
        $('jnsd-refresh-btn')?.addEventListener('click', load);
        $('jnsd-generate-btn')?.addEventListener('click', () => generateStrategy());
        documentRef.querySelector('[data-jn-subtab="shared-drives"]')?.addEventListener('click', () => {
            if (!loaded) load();
        });
        syncSaveButton();
    }

    return {
        POLICY_CHOICES,
        JANITOR_AUTOMATION_ID,
        JANITOR_AUTOMATION_NAME,
        policySelections,
        policyComplete,
        buildPolicyRequest,
        confirmPolicyRequest,
        findJanitorAutomation,
        scheduleLabel,
        buildAutomationViewModel,
        fetchCoreJson,
        hashingLimitMessage,
        oversizedHashEvidenceViewModel,
        oversizedHashEvidenceMessage,
        metadataFirstViewModel,
        metadataFirstMessage,
        verificationQueueViewModel,
        verificationQueueMessage,
        verificationOutlookViewModel,
        verificationOutlookMessage,
        missingExtensionSplit,
        buildPolicyDecisionSupportViewModel,
        organizationProgressViewModel,
        buildViewModel,
        init
    };
});
