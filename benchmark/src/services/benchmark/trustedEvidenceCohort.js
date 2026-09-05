/**
 * Trusted leaderboard evidence selection.
 *
 * A Trusted board must never average unrelated historical runs. We therefore
 * select one completed, recent benchmark batch whose scored rows all carry an
 * exact candidate identity. A batch is the comparison boundary: every model in
 * it ran the same captured fixture set under the same scorer generation.
 * Legacy rows remain available to the exploratory board.
 */

const crypto = require('crypto');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { GENERALIST_AGGREGATION_OPTIONS } = require('./generalistScoreConstants');

const DEFAULT_TRUSTED_FRESHNESS_DAYS = 30;

function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    const ordered = {};
    for (const key of Object.keys(value).sort()) {
        ordered[key] = canonicalize(value[key]);
    }
    return ordered;
}

function fingerprint(value) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(canonicalize(value)))
        .digest('hex');
}

function freshnessDaysFromEnv() {
    const configured = Number(process.env.LEADERBOARD_TRUST_FRESHNESS_DAYS);
    if (!Number.isFinite(configured)) return DEFAULT_TRUSTED_FRESHNESS_DAYS;
    return Math.max(1, Math.min(3650, Math.round(configured)));
}

function dateValue(value) {
    const time = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(time) ? time : null;
}

function uniqueStrings(values) {
    return [...new Set((values || []).map(normalizeText).filter(Boolean))].sort();
}

function fixtureIdentity(rows) {
    const fixtures = (rows || []).map((row) => ({
        name: normalizeText(row?.name),
        prompt: normalizeText(row?.prompt),
        category: normalizeText(row?.category),
        level: Number.isFinite(Number(row?.level)) ? Number(row.level) : null,
        expectedAnswer: row?.expectedAnswer ?? null,
        scoringType: row?.scoringType ?? null,
        scoringDimensions: row?.scoringDimensions ?? null,
        outputContract: row?.outputContract ?? null
    }));

    const complete = fixtures.length > 0 && fixtures.every((row) => (
        row.name && row.prompt && row.category && row.level !== null
    ));
    const categories = new Set(fixtures.map(row => row.category).filter(Boolean));
    const categoryLevelCells = new Set(fixtures
        .filter(row => row.category && row.level !== null)
        .map(row => `${row.category}@@${row.level}`));
    fixtures.sort((left, right) => JSON.stringify(canonicalize(left)).localeCompare(JSON.stringify(canonicalize(right))));
    return {
        complete,
        count: fixtures.length,
        categoryCount: categories.size,
        categoryLevelCellCount: categoryLevelCells.size,
        fingerprint: complete ? fingerprint(fixtures) : null
    };
}

function candidateIdentity(candidateRows) {
    const byCandidate = new Map();
    for (const row of candidateRows || []) {
        const model = normalizeText(row?.model);
        const host = normalizeText(row?.host).replace(/\/+$/, '').toLowerCase();
        const artifactDigest = normalizeText(row?.artifactDigest);
        const modelDigest = normalizeText(row?.modelDigest);
        const runtimeFingerprint = normalizeText(row?.runtimeFingerprint);
        const key = `${model.toLowerCase()}@@${host}`;
        if (!byCandidate.has(key)) byCandidate.set(key, []);
        byCandidate.get(key).push({ model, host, artifactDigest, modelDigest, runtimeFingerprint });
    }

    const exact = [];
    let complete = byCandidate.size > 0;
    for (const identities of byCandidate.values()) {
        const unique = new Map(identities.map((identity) => [JSON.stringify(identity), identity]));
        if (unique.size !== 1) {
            complete = false;
            continue;
        }
        const identity = unique.values().next().value;
        if (!identity.model || !identity.host || !identity.artifactDigest
            || !identity.modelDigest || !identity.runtimeFingerprint) {
            complete = false;
            continue;
        }
        exact.push(identity);
    }
    exact.sort((left, right) => `${left.model}@@${left.host}`.localeCompare(`${right.model}@@${right.host}`));
    return { complete, count: byCandidate.size, identities: exact };
}

function candidateFixtureCompatibility(rows) {
    const byCandidate = new Map();
    for (const row of rows || []) {
        const model = normalizeText(row?.model).toLowerCase();
        const host = normalizeText(row?.host).replace(/\/+$/, '').toLowerCase();
        const key = `${model}@@${host}`;
        if (!model || !host) continue;
        if (!byCandidate.has(key)) byCandidate.set(key, []);
        byCandidate.get(key).push({
            name: row?.name,
            prompt: row?.prompt,
            category: row?.category,
            level: row?.level,
            expectedAnswer: row?.expectedAnswer,
            scoringType: row?.scoringType,
            scoringDimensions: row?.scoringDimensions,
            outputContract: row?.outputContract
        });
    }
    const identities = [...byCandidate.entries()].map(([candidate, fixtures]) => ({
        candidate,
        ...fixtureIdentity(fixtures)
    }));
    const fingerprints = uniqueStrings(identities.map((identity) => identity.fingerprint));
    return {
        complete: identities.length > 0
            && identities.every((identity) => identity.complete)
            && fingerprints.length === 1,
        fingerprint: fingerprints.length === 1 ? fingerprints[0] : null,
        identities
    };
}

function assessTrustedCohort(group, batch, {
    asOf = new Date(),
    freshnessDays = freshnessDaysFromEnv(),
    inventory = null
} = {}) {
    const reasons = [];
    const completedAt = dateValue(batch?.completed_at || group?.latestTimestamp);
    const cutoff = new Date(asOf).getTime() - freshnessDays * 24 * 60 * 60 * 1000;
    if (batch?.status !== 'completed') reasons.push('batch_not_completed');
    if (completedAt === null || completedAt < cutoff) reasons.push('stale');
    const plannedTests = Number(batch?.total_tests || 0);
    const completedTests = Number(batch?.completed || 0);
    const failedTests = Number(batch?.failed || 0);
    if (plannedTests <= 0 || completedTests !== plannedTests || failedTests !== 0) {
        reasons.push('batch_counts_incomplete');
    }

    const fixture = fixtureIdentity(group?.fixtures);
    if (!fixture.complete) reasons.push('fixture_identity_missing');

    const candidates = candidateIdentity(group?.candidateIdentities);
    if (!candidates.complete) reasons.push('candidate_identity_missing_or_mixed');
    const candidateFixtures = candidateFixtureCompatibility(group?.candidateFixtures);
    const exactCandidateKeys = new Set(candidates.identities.map(identity => (
        `${identity.model.toLowerCase()}@@${identity.host}`
    )));
    const fixtureCandidateKeys = new Set(candidateFixtures.identities.map(identity => identity.candidate));
    const sameCandidates = exactCandidateKeys.size === fixtureCandidateKeys.size
        && [...exactCandidateKeys].every(key => fixtureCandidateKeys.has(key));
    if (!candidateFixtures.complete || candidateFixtures.fingerprint !== fixture.fingerprint || !sameCandidates) {
        reasons.push('candidate_fixture_scope_mismatch');
    }

    const scorerVersions = uniqueStrings(group?.scorerVersions);
    if (scorerVersions.length !== 1 || Number(group?.scorerKnownRows || 0) !== Number(group?.rowCount || 0)) {
        reasons.push('scorer_identity_missing_or_mixed');
    }
    if (Number(group?.confidenceKnownRows || 0) !== Number(group?.rowCount || 0)) {
        reasons.push('confidence_unknown');
    }

    // The trusted query deliberately filters failed, excluded and unscored
    // rows. Without a second look at the same requested scope, those hidden
    // rows could make a partial campaign look complete. The resolver supplies
    // this bounded inventory; direct unit callers may omit it.
    if (inventory) {
        if (Number(inventory.excludedRows || 0) > 0) reasons.push('excluded_rows');
        if (Number(inventory.reviewRows || 0) > 0) reasons.push('review_pending_rows');
        if (Number(inventory.failedRows || 0) > 0) reasons.push('incomplete_rows');
        if (Number(inventory.unscoredRows || 0) > 0) reasons.push('unscored_rows');
        if (Number(inventory.totalRows || 0) !== plannedTests) {
            reasons.push('batch_result_count_mismatch');
        }
        if (Number(inventory.totalRows || 0) !== Number(group?.rowCount || 0)) {
            reasons.push('partial_scope');
        }
    } else {
        reasons.push('batch_inventory_missing');
    }

    const judgeTargets = (group?.judgeTargets || [])
        .map((target) => ({
            model: normalizeText(target?.model).toLowerCase(),
            host: normalizeText(target?.host).replace(/\/+$/, '').toLowerCase()
        }))
        .filter((target) => target.model && target.host)
        .sort((left, right) => `${left.model}@@${left.host}`.localeCompare(`${right.model}@@${right.host}`));
    const judgeIdentityKnown = Number(group?.judgeKnownRows || 0) === Number(group?.rowCount || 0)
        && judgeTargets.length === 1;
    if (!judgeIdentityKnown) reasons.push('judge_identity_missing_or_mixed');
    const scorerFingerprint = scorerVersions.length === 1 && judgeIdentityKnown
        ? fingerprint({ scorerVersion: scorerVersions[0], judgeTargets })
        : null;

    return {
        eligible: reasons.length === 0,
        reasons: [...new Set(reasons)],
        batchId: String(group?._id || batch?._id || ''),
        completedAt: completedAt === null ? null : new Date(completedAt).toISOString(),
        latestTimestamp: dateValue(group?.latestTimestamp),
        rowCount: Number(group?.rowCount || 0),
        modelCount: candidates.count,
        fixtureCount: fixture.count,
        fixtureCategoryCount: fixture.categoryCount,
        fixtureCategoryLevelCellCount: fixture.categoryLevelCellCount,
        fixtureFingerprint: fixture.fingerprint,
        scorerVersion: scorerVersions.length === 1 ? scorerVersions[0] : null,
        scorerFingerprint,
        candidateIdentities: candidates.identities,
        evidenceFingerprint: reasons.length === 0
            ? fingerprint({
                batchId: String(group?._id || batch?._id || ''),
                fixtureFingerprint: fixture.fingerprint,
                scorerFingerprint,
                candidates: candidates.identities
            })
            : null
    };
}

function selectTrustedCohort(cohorts) {
    return (cohorts || [])
        .filter((cohort) => cohort.eligible)
        .sort((left, right) => (
            right.fixtureCategoryLevelCellCount - left.fixtureCategoryLevelCellCount
            || right.fixtureCategoryCount - left.fixtureCategoryCount
            || right.fixtureCount - left.fixtureCount
            || right.modelCount - left.modelCount
            || (dateValue(right.completedAt) || 0) - (dateValue(left.completedAt) || 0)
        ))[0] || null;
}

async function resolveTrustedEvidenceCohort(matchQuery, options = {}) {
    const groups = await BenchmarkResult.aggregate([
        {
            $match: {
                ...(matchQuery || {}),
                batch_id: { $ne: null }
            }
        },
        {
            $group: {
                _id: '$batch_id',
                rowCount: { $sum: 1 },
                earliestTimestamp: { $min: '$timestamp' },
                latestTimestamp: { $max: '$timestamp' },
                scorerVersions: { $addToSet: '$scorer_version' },
                scorerKnownRows: {
                    $sum: { $cond: [{ $and: [
                        { $eq: [{ $type: '$scorer_version' }, 'string'] },
                        { $ne: ['$scorer_version', ''] }
                    ] }, 1, 0] }
                },
                confidenceKnownRows: {
                    $sum: { $cond: [{ $in: [{ $type: '$judge_confidence' }, ['double', 'int', 'long', 'decimal']] }, 1, 0] }
                },
                candidateIdentities: {
                    $addToSet: {
                        model: '$model',
                        host: '$host',
                        modelDigest: '$model_digest',
                        artifactDigest: '$execution_settings.artifact_digest',
                        runtimeFingerprint: '$execution_settings.inference_contract_fingerprint'
                    }
                },
                judgeTargets: {
                    $addToSet: { model: '$judge_model', host: '$judge_host' }
                },
                judgeKnownRows: {
                    $sum: { $cond: [{ $and: [
                        { $eq: [{ $type: '$judge_model' }, 'string'] },
                        { $ne: ['$judge_model', ''] },
                        { $eq: [{ $type: '$judge_host' }, 'string'] },
                        { $ne: ['$judge_host', ''] }
                    ] }, 1, 0] }
                },
                fixtures: {
                    $addToSet: {
                        name: '$prompt_name',
                        prompt: '$prompt',
                        category: '$prompt_category',
                        level: '$prompt_level',
                        expectedAnswer: '$expected_answer',
                        scoringType: '$scoring_type',
                        scoringDimensions: '$scoring_dimensions',
                        outputContract: '$output_contract'
                    }
                },
                candidateFixtures: {
                    $addToSet: {
                        model: '$model',
                        host: '$host',
                        name: '$prompt_name',
                        prompt: '$prompt',
                        category: '$prompt_category',
                        level: '$prompt_level',
                        expectedAnswer: '$expected_answer',
                        scoringType: '$scoring_type',
                        scoringDimensions: '$scoring_dimensions',
                        outputContract: '$output_contract'
                    }
                }
            }
        }
    ], GENERALIST_AGGREGATION_OPTIONS);

    const batchIds = groups.map((group) => group._id).filter(Boolean);
    const scoreField = ['composite_score', 'quality_score', 'deterministic_score', 'subjective_score']
        .find((field) => Object.prototype.hasOwnProperty.call(matchQuery || {}, field)) || null;
    // Inventory the whole planned batch, not only the consumer's filtered
    // slice. This makes a never-inserted planned cell visible through the
    // batch counters and makes host/challenge/category slices fail closed as
    // partial rather than masquerading as complete cohorts.
    const scopeMatch = { batch_id: { $in: batchIds } };

    const [batches, inventories] = batchIds.length > 0
        ? await Promise.all([
            BenchmarkBatch.aggregate([
                { $match: { _id: { $in: batchIds } } },
                { $project: { status: 1, completed_at: 1, total_tests: 1, completed: 1, failed: 1 } }
            ], GENERALIST_AGGREGATION_OPTIONS),
            BenchmarkResult.aggregate([
                { $match: scopeMatch },
                {
                    $group: {
                        _id: '$batch_id',
                        totalRows: { $sum: 1 },
                        excludedRows: {
                            $sum: { $cond: [{ $eq: ['$excluded_from_leaderboard', true] }, 1, 0] }
                        },
                        reviewRows: {
                            $sum: { $cond: [{ $eq: ['$needs_review', true] }, 1, 0] }
                        },
                        failedRows: {
                            $sum: { $cond: [{ $or: [
                                { $ne: ['$success', true] },
                                { $eq: ['$infra_error', true] }
                            ] }, 1, 0] }
                        },
                        unscoredRows: scoreField
                            ? { $sum: { $cond: [{ $eq: [`$${scoreField}`, null] }, 1, 0] } }
                            : { $sum: 0 }
                    }
                }
            ], GENERALIST_AGGREGATION_OPTIONS)
        ])
        : [[], []];
    const batchesById = new Map(batches.map((batch) => [String(batch._id), batch]));
    const inventoriesById = new Map(inventories.map((row) => [String(row._id), row]));
    const freshnessDays = options.freshnessDays || freshnessDaysFromEnv();
    const assessed = groups.map((group) => assessTrustedCohort(
        group,
        batchesById.get(String(group._id)),
        {
            asOf: options.asOf || new Date(),
            freshnessDays,
            inventory: inventoriesById.get(String(group._id)) || null
        }
    ));
    const selected = selectTrustedCohort(assessed);
    const selectedBatchObjectId = selected
        ? groups.find((group) => String(group._id) === selected.batchId)?._id || null
        : null;
    const reasonCounts = {};
    for (const cohort of assessed.filter((item) => !item.eligible)) {
        for (const reason of cohort.reasons) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }

    return {
        selected,
        selectedBatchObjectId,
        candidateBatchCount: assessed.length,
        eligibleBatchCount: assessed.filter((item) => item.eligible).length,
        excludedBatchCount: assessed.filter((item) => !item.eligible).length,
        exclusionReasons: reasonCounts,
        freshnessDays
    };
}

/**
 * Convert the one authoritative cohort resolution into a consumer-facing
 * verdict. Phase 0 intentionally cannot mint a qualified winner: the exact
 * human/judge qualification receipt is a later contract. Consumers still get
 * the strongest honest observation and an explicit reason for the limit.
 */
function buildConsumerTrustVerdict({
    trustScope,
    cohortResolution = null,
    rows = [],
    scopeComplete = null,
    comparisonSufficient = null
} = {}) {
    const requestedScope = trustScope === 'trusted' ? 'trusted' : 'exploratory';
    const visibleRows = (rows || []).filter((row) => row && row.filtered !== true);
    const top = visibleRows[0] || null;
    const resolution = cohortResolution || {};
    const exclusions = resolution.exclusionReasons || {};
    const activeExclusionReasons = Object.entries(exclusions)
        .filter(([, count]) => Number(count || 0) > 0)
        .map(([reason]) => reason);
    const allExcludedAreStale = Number(resolution.excludedBatchCount || 0) > 0
        && Number(exclusions.stale || 0) === Number(resolution.excludedBatchCount || 0)
        && activeExclusionReasons.length === 1
        && activeExclusionReasons[0] === 'stale';

    let state = 'exploratory';
    const reasons = [];
    if (requestedScope === 'exploratory') {
        reasons.push('exploratory_scope');
    } else if (!resolution.selected) {
        state = allExcludedAreStale ? 'stale' : 'inconclusive';
        reasons.push(...Object.keys(exclusions));
        if (reasons.length === 0) reasons.push('no_compatible_cohort');
    } else if (scopeComplete === false) {
        state = 'inconclusive';
        reasons.push('partial_scope');
    } else if (comparisonSufficient === false) {
        state = 'inconclusive';
        reasons.push('insufficient_comparison');
    } else {
        state = 'trusted';
    }

    // Human certification of the exact judge/rubric/holdout and an immutable
    // ranking receipt do not exist in Phase 0. Keep that absence visible and
    // fail closed for winner/high-confidence language.
    reasons.push('qualified_receipt_unavailable');

    return {
        contract: 'agentx.benchmark-consumer-trust/v1',
        requestedScope,
        state,
        comparable: state === 'trusted',
        qualified: false,
        qualification: 'insufficient',
        highConfidenceAllowed: false,
        claim: top && state === 'exploratory'
            ? 'top_exploratory_observation'
            : 'no_qualified_winner',
        reasons: [...new Set(reasons)],
        topObservation: top ? {
            model: top.model || null,
            host: top.host || null,
            score: top.generalistScore ?? top.quality_score ?? null
        } : null,
        qualifiedWinner: null,
        cohort: resolution.selected ? {
            evidenceFingerprint: resolution.selected.evidenceFingerprint || null,
            completedAt: resolution.selected.completedAt || null
        } : null
    };
}

module.exports = {
    DEFAULT_TRUSTED_FRESHNESS_DAYS,
    canonicalize,
    fingerprint,
    fixtureIdentity,
    candidateIdentity,
    candidateFixtureCompatibility,
    assessTrustedCohort,
    selectTrustedCohort,
    resolveTrustedEvidenceCohort,
    buildConsumerTrustVerdict
};
