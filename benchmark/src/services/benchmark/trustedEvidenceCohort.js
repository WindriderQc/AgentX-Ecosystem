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

function assessTrustedCohort(group, batch, { asOf = new Date(), freshnessDays = freshnessDaysFromEnv() } = {}) {
    const reasons = [];
    const completedAt = dateValue(batch?.completed_at || group?.latestTimestamp);
    const cutoff = new Date(asOf).getTime() - freshnessDays * 24 * 60 * 60 * 1000;
    if (batch?.status !== 'completed') reasons.push('batch_not_completed');
    if (completedAt === null || completedAt < cutoff) reasons.push('stale');

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

    const judgeTargets = (group?.judgeTargets || [])
        .map((target) => ({
            model: normalizeText(target?.model).toLowerCase(),
            host: normalizeText(target?.host).replace(/\/+$/, '').toLowerCase()
        }))
        .filter((target) => target.model || target.host)
        .sort((left, right) => `${left.model}@@${left.host}`.localeCompare(`${right.model}@@${right.host}`));
    const scorerFingerprint = scorerVersions.length === 1
        ? fingerprint({ scorerVersion: scorerVersions[0], judgeTargets })
        : null;

    return {
        eligible: reasons.length === 0,
        reasons,
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
    const batches = batchIds.length > 0
        ? await BenchmarkBatch.aggregate([
            { $match: { _id: { $in: batchIds } } },
            { $project: { status: 1, completed_at: 1 } }
        ], GENERALIST_AGGREGATION_OPTIONS)
        : [];
    const batchesById = new Map(batches.map((batch) => [String(batch._id), batch]));
    const freshnessDays = options.freshnessDays || freshnessDaysFromEnv();
    const assessed = groups.map((group) => assessTrustedCohort(
        group,
        batchesById.get(String(group._id)),
        { asOf: options.asOf || new Date(), freshnessDays }
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

module.exports = {
    DEFAULT_TRUSTED_FRESHNESS_DAYS,
    canonicalize,
    fingerprint,
    fixtureIdentity,
    candidateIdentity,
    candidateFixtureCompatibility,
    assessTrustedCohort,
    selectTrustedCohort,
    resolveTrustedEvidenceCohort
};
