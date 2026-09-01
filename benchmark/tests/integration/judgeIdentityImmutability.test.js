'use strict';

process.env.MONGOMS_VERSION = '7.0.24';
jest.setTimeout(30_000);

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const CalibrationBaseline = require('../../models/CalibrationBaseline');
const { ratifyBaseline: ratifyBaselineService } = require('../../src/services/benchmark/judgeDriftService');

const JUDGE_A = 'a'.repeat(64);
const JUDGE_B = 'b'.repeat(64);
const IMMUTABLE = { code: 'JUDGE_IDENTITY_FINGERPRINT_IMMUTABLE' };
const STATE_IMMUTABLE = { code: 'CALIBRATION_BASELINE_STATE_IMMUTABLE' };
const CONTENT_IMMUTABLE = { code: 'CALIBRATION_BASELINE_CONTENT_IMMUTABLE' };
const QUALIFIED_IMMUTABLE = { code: 'QUALIFIED_JUDGE_GROUND_TRUTH_IMMUTABLE', statusCode: 409 };
const CALIBRATION_CATEGORIES = ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'];

let mongoServer;

function groundTruthFixture() {
    return {
        name: 'identity-immutable-ground-truth',
        prompt: 'opaque prompt',
        response: 'opaque response',
        category: 'coding',
        expert_scores: { overall: 8 },
        expert_rationale: 'independent evidence',
        provenance_class: 'independent_human_score',
        review_protocol: 'blind_independent',
        judge_score_at_review: 7,
        judge_identity_fingerprint: JUDGE_A
    };
}

async function insertHistoricalQualifiedGroundTruth(patch = {}) {
    // Test-only simulation of an already trusted historical import. Product
    // intentionally exposes no ordinary qualified-creation authority yet.
    const candidate = new JudgeGroundTruth({ ...groundTruthFixture(), ...patch });
    await candidate.validate();
    const materialized = candidate.toObject({ depopulate: true });
    const now = new Date();
    materialized.createdAt = now;
    materialized.updatedAt = now;
    await JudgeGroundTruth.collection.insertOne(materialized);
    return JudgeGroundTruth.findById(materialized._id);
}

function completeBaselineInput(input) {
    const requested = new Map((input.categories || []).map(row => [row.category, row]));
    const categories = CALIBRATION_CATEGORIES.map(category => ({
        category,
        rho: 0.9,
        sample_size: 5,
        ...(requested.get(category) || {})
    }));
    return {
        ...input,
        overall_rho: input.overall_rho ?? 0.9,
        overall_sample_size: categories.reduce((total, row) => total + row.sample_size, 0),
        categories
    };
}

function ratifyBaseline(input) {
    return ratifyBaselineService(completeBaselineInput(input));
}

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create({ binary: { version: '7.0.24' } });
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([JudgeGroundTruth.init(), CalibrationBaseline.init()]);
});

afterEach(async () => {
    await Promise.all([
        JudgeGroundTruth.collection.deleteMany({}),
        CalibrationBaseline.collection.deleteMany({})
    ]);
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

test('JudgeGroundTruth rejects every Mongoose identity rewrite surface', async () => {
    const row = await insertHistoricalQualifiedGroundTruth();
    const before = await JudgeGroundTruth.collection.findOne({ _id: row._id });
    const replacement = { ...groundTruthFixture(), judge_identity_fingerprint: JUDGE_B };

    await expect(JudgeGroundTruth.replaceOne({ _id: row._id }, replacement))
        .rejects.toMatchObject(IMMUTABLE);
    await expect(JudgeGroundTruth.findOneAndReplace({ _id: row._id }, replacement))
        .rejects.toMatchObject(IMMUTABLE);
    await expect(JudgeGroundTruth.updateOne(
        { _id: row._id },
        [{ $set: { judge_identity_fingerprint: JUDGE_B } }]
    )).rejects.toMatchObject(IMMUTABLE);
    await expect(JudgeGroundTruth.updateOne(
        { _id: row._id },
        { $set: { judge_identity_fingerprint: JUDGE_B } }
    )).rejects.toMatchObject(IMMUTABLE);
    await expect(JudgeGroundTruth.updateOne(
        { _id: row._id },
        { $unset: { judge_identity_fingerprint: '' } }
    )).rejects.toMatchObject(IMMUTABLE);
    await expect(JudgeGroundTruth.updateOne(
        { _id: row._id },
        { $rename: { judge_identity_fingerprint: 'legacy_judge_identity' } }
    )).rejects.toMatchObject(IMMUTABLE);
    await expect(JudgeGroundTruth.updateOne(
        { _id: row._id },
        { judge_identity_fingerprint: JUDGE_B }
    )).rejects.toMatchObject(IMMUTABLE);
    row.set('judge_identity_fingerprint', JUDGE_B, null, { overwriteImmutable: true });
    await expect(row.save()).rejects.toMatchObject(IMMUTABLE);
    await expect(JudgeGroundTruth.bulkWrite([{
        updateOne: {
            filter: { _id: row._id },
            update: { $set: { judge_identity_fingerprint: JUDGE_B } }
        }
    }])).rejects.toMatchObject(IMMUTABLE);

    await expect(JudgeGroundTruth.collection.findOne({ _id: row._id })).resolves.toEqual(before);
});

test('qualified JudgeGroundTruth rows are append-only while diagnostic validation history remains writable', async () => {
    const row = await insertHistoricalQualifiedGroundTruth({
        name: 'qualified-append-only'
    });
    const before = await JudgeGroundTruth.collection.findOne({ _id: row._id });

    await expect(JudgeGroundTruth.updateOne(
        { _id: row._id },
        { $set: { prompt: 'rewritten prompt' } }
    )).rejects.toMatchObject(QUALIFIED_IMMUTABLE);
    await expect(JudgeGroundTruth.updateMany(
        { _id: row._id },
        { $unset: { expert_scores: '' } }
    )).rejects.toMatchObject(QUALIFIED_IMMUTABLE);
    await expect(JudgeGroundTruth.findOneAndUpdate(
        { _id: row._id },
        { $rename: { expert_rationale: 'legacy_rationale' } }
    )).rejects.toMatchObject(QUALIFIED_IMMUTABLE);

    const loaded = await JudgeGroundTruth.findById(row._id);
    loaded.set('active', false);
    await expect(loaded.save()).rejects.toMatchObject(QUALIFIED_IMMUTABLE);
    await expect(JudgeGroundTruth.deleteOne({ _id: row._id }))
        .rejects.toMatchObject(QUALIFIED_IMMUTABLE);
    await expect(JudgeGroundTruth.deleteMany({ _id: row._id }))
        .rejects.toMatchObject(QUALIFIED_IMMUTABLE);
    await expect(JudgeGroundTruth.findOneAndDelete({ _id: row._id }))
        .rejects.toMatchObject(QUALIFIED_IMMUTABLE);
    await expect(JudgeGroundTruth.findOneAndRemove({ _id: row._id }))
        .rejects.toMatchObject(QUALIFIED_IMMUTABLE);
    await expect((await JudgeGroundTruth.findById(row._id)).deleteOne())
        .rejects.toMatchObject(QUALIFIED_IMMUTABLE);
    await expect(JudgeGroundTruth.aggregate([{
        $facet: { destructive: [{ $merge: 'judgegroundtruths' }] }
    }])).rejects.toMatchObject(QUALIFIED_IMMUTABLE);
    await expect(JudgeGroundTruth.bulkWrite([{
        updateOne: {
            filter: { _id: row._id },
            update: { $set: { prompt: 'bulk rewrite' } }
        }
    }])).rejects.toBeDefined();

    await expect(JudgeGroundTruth.collection.findOne({ _id: row._id })).resolves.toEqual(before);

    const diagnostic = await JudgeGroundTruth.findById(row._id);
    await diagnostic.recordValidation({
        judge_model: 'diagnostic-only',
        judge_score: 7,
        dimension_scores: { correctness: 7 }
    });
    const afterDiagnostic = await JudgeGroundTruth.collection.findOne({ _id: row._id });
    expect(afterDiagnostic.validation_stats.total_runs).toBe(1);
    expect(afterDiagnostic.prompt).toBe(before.prompt);
    expect(afterDiagnostic.expert_scores).toEqual(before.expert_scores);
});

test('human-attestation fields are server-import-only, immutable, and uniquely replay-bound', async () => {
    const attestationFingerprint = 'c'.repeat(64);
    const sourceFingerprint = 'd'.repeat(64);
    const rawLegacy = {
        ...groundTruthFixture(),
        _id: new mongoose.Types.ObjectId(),
        name: 'legacy-with-attestation-metadata',
        provenance_class: 'legacy_unverified',
        review_protocol: 'legacy_unknown',
        judge_identity_fingerprint: null,
        human_attestation_fingerprint: attestationFingerprint,
        human_attestation_issuer_id: 'human-review-board',
        human_attestation_key_id: 'review-key-2026-09',
        human_attestation_nonce: 'review-nonce-00000000000000000001',
        human_attestation_issued_at: new Date('2026-09-01T11:00:00.000Z'),
        human_attestation_valid_until: new Date('2026-10-01T11:00:00.000Z'),
        human_attestation_source_fingerprint: sourceFingerprint,
        human_attestation: { signed: true },
        createdAt: new Date(),
        updatedAt: new Date()
    };

    await expect(JudgeGroundTruth.create({ ...rawLegacy, _id: undefined }))
        .rejects.toMatchObject(QUALIFIED_IMMUTABLE);
    await expect(JudgeGroundTruth.countDocuments({ name: rawLegacy.name })).resolves.toBe(0);

    await JudgeGroundTruth.collection.insertOne(rawLegacy);
    const before = await JudgeGroundTruth.collection.findOne({ _id: rawLegacy._id });
    await expect(JudgeGroundTruth.updateOne(
        { _id: rawLegacy._id },
        { $set: { human_attestation_nonce: 'different-nonce-0000000000000000001' } }
    )).rejects.toMatchObject(QUALIFIED_IMMUTABLE);
    const loaded = await JudgeGroundTruth.findById(rawLegacy._id);
    loaded.set('human_attestation_fingerprint', 'e'.repeat(64), null, { overwriteImmutable: true });
    await expect(loaded.save()).rejects.toMatchObject(QUALIFIED_IMMUTABLE);
    await expect(JudgeGroundTruth.collection.findOne({ _id: rawLegacy._id })).resolves.toEqual(before);

    await expect(JudgeGroundTruth.collection.insertOne({
        ...rawLegacy,
        _id: new mongoose.Types.ObjectId(),
        name: 'duplicate-attestation-fingerprint'
    })).rejects.toMatchObject({ code: 11000 });
    await expect(JudgeGroundTruth.collection.insertOne({
        ...rawLegacy,
        _id: new mongoose.Types.ObjectId(),
        name: 'duplicate-attestation-nonce',
        human_attestation_fingerprint: 'f'.repeat(64)
    })).rejects.toMatchObject({ code: 11000 });
});

test('legacy rows cannot be qualified by query, document save, or upsert filter', async () => {
    const legacy = await JudgeGroundTruth.create({
        ...groundTruthFixture(),
        name: 'legacy-cannot-be-promoted',
        provenance_class: 'legacy_unverified',
        review_protocol: 'legacy_unknown'
    });
    const before = await JudgeGroundTruth.collection.findOne({ _id: legacy._id });

    await expect(JudgeGroundTruth.updateOne(
        { _id: legacy._id },
        {
            $set: {
                provenance_class: 'independent_human_score',
                review_protocol: 'blind_independent',
                expert_scores: { overall: 10 }
            }
        }
    )).rejects.toMatchObject(QUALIFIED_IMMUTABLE);

    const loaded = await JudgeGroundTruth.findById(legacy._id);
    loaded.provenance_class = 'adjudicated_human_score';
    loaded.review_protocol = 'adjudicated';
    await expect(loaded.save()).rejects.toMatchObject(QUALIFIED_IMMUTABLE);

    await expect(JudgeGroundTruth.findOneAndUpdate(
        {
            name: 'operator-filter-qualified-upsert',
            provenance_class: { $eq: 'independent_human_score' },
            review_protocol: { $eq: 'blind_double_review' }
        },
        {
            $setOnInsert: {
                prompt: 'must not materialize',
                response: 'must not materialize',
                category: 'coding',
                expert_scores: { overall: 9 },
                expert_rationale: 'must not materialize'
            }
        },
        { upsert: true, new: true }
    )).rejects.toMatchObject(QUALIFIED_IMMUTABLE);

    await expect(JudgeGroundTruth.collection.findOne({ _id: legacy._id })).resolves.toEqual(before);
    await expect(JudgeGroundTruth.collection.findOne({ name: 'operator-filter-qualified-upsert' }))
        .resolves.toBeNull();

    await expect(JudgeGroundTruth.create({
        ...groundTruthFixture(),
        name: 'qualified-created-atomically'
    })).rejects.toMatchObject(QUALIFIED_IMMUTABLE);
});

test('all ordinary Mongo operators reject provenance, review, identity, and qualified-content bypasses', async () => {
    const legacy = await JudgeGroundTruth.create({
        ...groundTruthFixture(),
        name: 'operator-bypass-legacy',
        source: 'independent_human_score',
        provenance_class: 'legacy_unverified',
        review_protocol: 'legacy_unknown',
        judge_identity_fingerprint: null
    });
    const legacyBefore = await JudgeGroundTruth.collection.findOne({ _id: legacy._id });

    for (const update of [
        { $min: { provenance_class: 'independent_human_score' } },
        { $max: { review_protocol: 'blind_double_review' } },
        { $currentDate: { provenance_class: true } },
        { $rename: { source: 'provenance_class' } },
        { $rename: { provenance_class: 'legacy_provenance_class' } }
    ]) {
        await expect(JudgeGroundTruth.updateOne({ _id: legacy._id }, update))
            .rejects.toMatchObject(QUALIFIED_IMMUTABLE);
    }
    for (const update of [
        { $min: { judge_identity_fingerprint: JUDGE_A } },
        { $rename: { source: 'judge_identity_fingerprint' } },
        { $rename: { judge_identity_fingerprint: 'legacy_judge_identity' } }
    ]) {
        await expect(JudgeGroundTruth.updateOne({ _id: legacy._id }, update))
            .rejects.toMatchObject(IMMUTABLE);
    }
    await expect(JudgeGroundTruth.findOneAndUpdate(
        { _id: legacy._id },
        { $setOnInsert: { 'provenance_class.nested': 'independent_human_score' } },
        { upsert: true, new: true }
    )).rejects.toBeDefined();
    await expect(JudgeGroundTruth.collection.findOne({ _id: legacy._id }))
        .resolves.toEqual(legacyBefore);

    const qualified = await insertHistoricalQualifiedGroundTruth({
        name: 'operator-bypass-qualified'
    });
    const qualifiedBefore = await JudgeGroundTruth.collection.findOne({ _id: qualified._id });
    await expect(JudgeGroundTruth.updateOne(
        { _id: qualified._id },
        { $min: { difficulty: 1 } }
    )).rejects.toMatchObject(QUALIFIED_IMMUTABLE);
    await expect(JudgeGroundTruth.updateOne(
        { _id: qualified._id },
        { $rename: { prompt: 'legacy_prompt' } }
    )).rejects.toMatchObject(QUALIFIED_IMMUTABLE);
    await expect(JudgeGroundTruth.collection.findOne({ _id: qualified._id }))
        .resolves.toEqual(qualifiedBefore);

    await expect(JudgeGroundTruth.updateOne(
        { _id: qualified._id },
        {
            $push: {
                validation_history: {
                    judge_model: 'query-diagnostic',
                    judge_score: 7,
                    deviation: 1,
                    timestamp: new Date('2026-08-31T00:00:00.000Z')
                }
            },
            $inc: { 'validation_stats.total_runs': 1 }
        }
    )).resolves.toMatchObject({ modifiedCount: 1 });
    await expect(JudgeGroundTruth.findById(qualified._id).lean()).resolves.toMatchObject({
        validation_stats: { total_runs: 1 },
        validation_history: [expect.objectContaining({ judge_model: 'query-diagnostic' })]
    });
});

test('ordinary ground truth creation rejects non-finite scores, validation bypasses, and qualified claims', async () => {
    for (const [suffix, patch] of [
        ['judge-infinity', { judge_score_at_review: Number.POSITIVE_INFINITY }],
        ['judge-negative-infinity', { judge_score_at_review: Number.NEGATIVE_INFINITY }],
        ['human-nan', { expert_scores: { overall: Number.NaN } }],
        ['human-out-of-range', { expert_scores: { overall: 11 } }]
    ]) {
        await expect(JudgeGroundTruth.create({
            ...groundTruthFixture(),
            name: `invalid-${suffix}`,
            ...patch
        })).rejects.toBeDefined();
    }

    await expect(JudgeGroundTruth.insertMany([{
        ...groundTruthFixture(),
        name: 'lean-non-finite',
        expert_scores: { overall: Number.POSITIVE_INFINITY }
    }], { lean: true })).rejects.toBeDefined();

    const incomplete = new JudgeGroundTruth({
        ...groundTruthFixture(),
        name: 'validation-disabled-incomplete'
    });
    incomplete.prompt = undefined;
    incomplete.$ignore('prompt');
    await expect(incomplete.save({
        validateBeforeSave: false,
        validateModifiedOnly: true
    })).rejects.toBeDefined();

    const ignoredInsert = new JudgeGroundTruth({
        ...groundTruthFixture(),
        name: 'insert-many-ignored-required'
    });
    ignoredInsert.prompt = undefined;
    ignoredInsert.$ignore('prompt');
    await expect(JudgeGroundTruth.insertMany([ignoredInsert])).rejects.toBeDefined();

    await expect(JudgeGroundTruth.insertMany([{
        ...groundTruthFixture(),
        name: 'valid-qualified-insert-many'
    }])).rejects.toMatchObject(QUALIFIED_IMMUTABLE);
    await expect(JudgeGroundTruth.create({
        ...groundTruthFixture(),
        name: 'valid-qualified-create'
    })).rejects.toMatchObject(QUALIFIED_IMMUTABLE);

    const legacy = await JudgeGroundTruth.create({
        ...groundTruthFixture(),
        name: 'legacy-numeric-mutation',
        provenance_class: 'legacy_unverified',
        review_protocol: 'legacy_unknown',
        judge_identity_fingerprint: null
    });
    const legacyBefore = await JudgeGroundTruth.collection.findOne({ _id: legacy._id });
    await expect(JudgeGroundTruth.updateOne(
        { _id: legacy._id },
        { $set: { judge_score_at_review: Number.POSITIVE_INFINITY } }
    )).rejects.toBeDefined();
    legacy.judge_score_at_review = Number.NEGATIVE_INFINITY;
    await expect(legacy.save({ validateBeforeSave: false })).rejects.toBeDefined();
    await expect(JudgeGroundTruth.collection.findOne({ _id: legacy._id }))
        .resolves.toEqual(legacyBefore);

    await expect(JudgeGroundTruth.collection.countDocuments({
        name: { $in: [
            'lean-non-finite',
            'validation-disabled-incomplete',
            'insert-many-ignored-required',
            'valid-qualified-insert-many',
            'valid-qualified-create'
        ] }
    })).resolves.toBe(0);
});

test('CalibrationBaseline rejects every Mongoose identity rewrite surface and unbound insert', async () => {
    const row = await CalibrationBaseline.create({
        label: 'identity-immutable-baseline',
        judge_identity_fingerprint: JUDGE_A,
        categories: []
    });
    const before = await CalibrationBaseline.collection.findOne({ _id: row._id });
    const replacement = {
        label: row.label,
        judge_identity_fingerprint: JUDGE_B,
        categories: []
    };

    await expect(CalibrationBaseline.replaceOne({ _id: row._id }, replacement))
        .rejects.toMatchObject(IMMUTABLE);
    await expect(CalibrationBaseline.findOneAndReplace({ _id: row._id }, replacement))
        .rejects.toMatchObject(IMMUTABLE);
    await expect(CalibrationBaseline.updateOne(
        { _id: row._id },
        [{ $set: { judge_identity_fingerprint: JUDGE_B } }]
    )).rejects.toMatchObject(IMMUTABLE);
    await expect(CalibrationBaseline.updateOne(
        { _id: row._id },
        { $set: { judge_identity_fingerprint: JUDGE_B } }
    )).rejects.toMatchObject(IMMUTABLE);
    await expect(CalibrationBaseline.updateOne(
        { _id: row._id },
        { $unset: { judge_identity_fingerprint: '' } }
    )).rejects.toMatchObject(IMMUTABLE);
    await expect(CalibrationBaseline.updateOne(
        { _id: row._id },
        { $rename: { judge_identity_fingerprint: 'legacy_judge_identity' } }
    )).rejects.toMatchObject(IMMUTABLE);
    await expect(CalibrationBaseline.updateOne(
        { _id: row._id },
        { judge_identity_fingerprint: JUDGE_B }
    )).rejects.toMatchObject(IMMUTABLE);
    row.set('judge_identity_fingerprint', JUDGE_B, null, { overwriteImmutable: true });
    await expect(row.save()).rejects.toMatchObject(IMMUTABLE);
    await expect(CalibrationBaseline.bulkWrite([{
        updateOne: {
            filter: { _id: row._id },
            update: { $set: { judge_identity_fingerprint: JUDGE_B } }
        }
    }])).rejects.toMatchObject(STATE_IMMUTABLE);
    await expect(CalibrationBaseline.findOneAndUpdate(
        { label: 'unbound-upsert' },
        { $setOnInsert: { judge_identity_fingerprint: JUDGE_A } },
        { upsert: true, new: true }
    )).rejects.toMatchObject(IMMUTABLE);

    await expect(CalibrationBaseline.collection.findOne({ _id: row._id })).resolves.toEqual(before);
});

test('CalibrationBaseline rejects caller-supplied ratification state on every ordinary write surface', async () => {
    const fixture = {
        label: 'state-immutable-baseline',
        judge_identity_fingerprint: JUDGE_A,
        categories: []
    };
    await expect(CalibrationBaseline.create({ ...fixture, active: false }))
        .rejects.toMatchObject(STATE_IMMUTABLE);
    await expect(CalibrationBaseline.create({
        ...fixture,
        label: 'state-create-slot',
        identity_active_slot: JUDGE_A
    })).rejects.toMatchObject(STATE_IMMUTABLE);
    await expect(CalibrationBaseline.insertMany([{
        ...fixture,
        label: 'state-insert-many',
        active: false
    }])).rejects.toMatchObject(STATE_IMMUTABLE);
    await expect(CalibrationBaseline.insertMany([
        new CalibrationBaseline({
            ...fixture,
            label: 'state-insert-many-document',
            active: true,
            identity_active_slot: JUDGE_A
        })
    ])).rejects.toMatchObject(STATE_IMMUTABLE);
    await expect(CalibrationBaseline.findOneAndUpdate(
        {
            label: 'state-filter-upsert',
            judge_identity_fingerprint: JUDGE_A,
            active: true,
            identity_active_slot: JUDGE_A
        },
        { $setOnInsert: { categories: [] } },
        { upsert: true, new: true }
    )).rejects.toMatchObject(STATE_IMMUTABLE);

    const row = await CalibrationBaseline.create(fixture);
    const before = await CalibrationBaseline.collection.findOne({ _id: row._id });
    const replacement = {
        ...fixture,
        active: true,
        identity_active_slot: JUDGE_A
    };

    await expect(CalibrationBaseline.replaceOne({ _id: row._id }, replacement))
        .rejects.toBeDefined();
    await expect(CalibrationBaseline.findOneAndReplace({ _id: row._id }, replacement))
        .rejects.toBeDefined();
    await expect(CalibrationBaseline.updateOne(
        { _id: row._id },
        [{ $set: { active: true, identity_active_slot: JUDGE_A } }]
    )).rejects.toBeDefined();
    await expect(CalibrationBaseline.updateOne(
        { _id: row._id },
        { $set: { active: true } }
    )).rejects.toMatchObject(STATE_IMMUTABLE);
    await expect(CalibrationBaseline.updateMany(
        { _id: row._id },
        { $unset: { active_slot: '' } }
    )).rejects.toMatchObject(STATE_IMMUTABLE);
    await expect(CalibrationBaseline.findOneAndUpdate(
        { _id: row._id },
        { $rename: { notes: 'identity_active_slot' } }
    )).rejects.toMatchObject(STATE_IMMUTABLE);
    await expect(CalibrationBaseline.updateOne(
        { _id: row._id },
        { active: true }
    )).rejects.toMatchObject(STATE_IMMUTABLE);
    row.set('active', true, null, { overwriteImmutable: true });
    await expect(row.save()).rejects.toMatchObject(STATE_IMMUTABLE);
    await expect(CalibrationBaseline.bulkWrite([{
        updateOne: {
            filter: { _id: row._id },
            update: { $set: { active: true, identity_active_slot: JUDGE_A } }
        }
    }])).rejects.toMatchObject(STATE_IMMUTABLE);

    await expect(CalibrationBaseline.collection.findOne({ _id: row._id })).resolves.toEqual(before);
    await expect(CalibrationBaseline.collection.countDocuments({
        label: { $in: ['state-filter-upsert', 'state-insert-many', 'state-insert-many-document'] }
    })).resolves.toBe(0);
});

test('CalibrationBaseline rejects every ordinary upsert before it can poison an append-only label', async () => {
    await expect(CalibrationBaseline.findOneAndUpdate(
        { label: 'invalid-upsert-label', judge_identity_fingerprint: JUDGE_A },
        {
            $setOnInsert: {
                judge_identity_fingerprint: JUDGE_A,
                overall_rho: Number.POSITIVE_INFINITY,
                categories: []
            }
        },
        { upsert: true, new: true }
    )).rejects.toBeDefined();
    await expect(CalibrationBaseline.updateOne(
        { label: 'valid-upsert-label', judge_identity_fingerprint: JUDGE_A },
        {
            $setOnInsert: {
                overall_rho: null,
                overall_sample_size: 0,
                categories: []
            }
        },
        { upsert: true }
    )).rejects.toMatchObject(CONTENT_IMMUTABLE);
    await expect(CalibrationBaseline.collection.countDocuments({
        label: { $in: ['invalid-upsert-label', 'valid-upsert-label'] }
    })).resolves.toBe(0);
});

test('CalibrationBaseline rejects non-finite, out-of-domain, duplicate, and invalid sample metrics', async () => {
    const invalidRows = [
        { label: 'rho-infinity', categories: [{ category: 'coding', rho: Number.POSITIVE_INFINITY, sample_size: 5 }] },
        { label: 'rho-negative-two', categories: [{ category: 'coding', rho: -2, sample_size: 5 }] },
        { label: 'sample-negative', categories: [{ category: 'coding', rho: 0.9, sample_size: -7 }] },
        { label: 'sample-float', categories: [{ category: 'coding', rho: 0.9, sample_size: 5.5 }] },
        { label: 'mae-nan', categories: [{ category: 'coding', rho: 0.9, sample_size: 5, mae: Number.NaN }] },
        { label: 'bias-infinity', categories: [{ category: 'coding', rho: 0.9, sample_size: 5, bias: Number.NEGATIVE_INFINITY }] },
        {
            label: 'duplicate-category',
            categories: [
                { category: 'coding', rho: 0.9, sample_size: 5 },
                { category: 'coding', rho: 0.8, sample_size: 5 }
            ]
        },
        { label: 'unknown-category', categories: [{ category: 'factual', rho: 0.9, sample_size: 5 }] }
    ];
    for (const input of invalidRows) {
        await expect(CalibrationBaseline.create({
            ...input,
            judge_identity_fingerprint: JUDGE_A
        })).rejects.toBeDefined();
    }
    await expect(CalibrationBaseline.create({
        label: 'overall-infinity',
        judge_identity_fingerprint: JUDGE_A,
        overall_rho: Number.POSITIVE_INFINITY,
        categories: []
    })).rejects.toBeDefined();
    await expect(CalibrationBaseline.create({
        label: 'overall-negative-sample',
        judge_identity_fingerprint: JUDGE_A,
        overall_sample_size: -1,
        categories: []
    })).rejects.toBeDefined();
    await expect(CalibrationBaseline.insertMany([{
        label: 'lean-invalid-baseline',
        judge_identity_fingerprint: JUDGE_A,
        overall_rho: Number.NaN,
        categories: []
    }], { lean: true })).rejects.toBeDefined();
    const bypass = new CalibrationBaseline({
        label: 'validation-disabled-baseline',
        judge_identity_fingerprint: JUDGE_A,
        categories: []
    });
    bypass.overall_rho = Number.POSITIVE_INFINITY;
    bypass.$ignore('overall_rho');
    await expect(bypass.save({ validateBeforeSave: false })).rejects.toBeDefined();

    await expect(CalibrationBaseline.collection.countDocuments({})).resolves.toBe(0);
});

test('invalid ratification never materializes or deactivates the canonical baseline', async () => {
    const canonical = await ratifyBaseline({
        label: 'valid-before-invalid-attempt',
        judge_identity_fingerprint: JUDGE_A,
        categories: []
    });
    const before = await CalibrationBaseline.collection.find({}).sort({ _id: 1 }).toArray();
    const invalidInputs = [
        {
            label: 'incomplete-ratification',
            judge_identity_fingerprint: JUDGE_A,
            overall_rho: 0.9,
            overall_sample_size: 5,
            categories: [{ category: 'coding', rho: 0.9, sample_size: 5 }]
        },
        {
            label: 'zero-sample-ratification',
            judge_identity_fingerprint: JUDGE_A,
            overall_rho: 0.9,
            overall_sample_size: 30,
            categories: CALIBRATION_CATEGORIES.map(category => ({
                category,
                rho: 0.9,
                sample_size: category === 'coding' ? 0 : 5
            }))
        },
        {
            label: 'inconsistent-total-ratification',
            judge_identity_fingerprint: JUDGE_A,
            overall_rho: 0.9,
            overall_sample_size: 34,
            categories: CALIBRATION_CATEGORIES.map(category => ({ category, rho: 0.9, sample_size: 5 }))
        }
    ];

    for (const input of invalidInputs) {
        await expect(ratifyBaselineService(input)).rejects.toBeDefined();
        await expect(CalibrationBaseline.collection.find({}).sort({ _id: 1 }).toArray())
            .resolves.toEqual(before);
        await expect(CalibrationBaseline.getActive(JUDGE_A)).resolves.toMatchObject({
            _id: canonical._id,
            label: canonical.label,
            active: true
        });
    }
});

test('ratification rejects a label owned by another judge without changing one byte', async () => {
    const row = await ratifyBaseline({
        label: 'owned-by-judge-a',
        judge_identity_fingerprint: JUDGE_A,
        source_sprint: 'sprint-a',
        overall_rho: 0.91,
        overall_sample_size: 30,
        categories: [{ category: 'coding', rho: 0.91, sample_size: 30 }],
        notes: 'judge-a baseline'
    });
    const before = await CalibrationBaseline.collection.findOne({ _id: row._id });

    await expect(ratifyBaseline({
        label: row.label,
        judge_identity_fingerprint: JUDGE_B,
        source_sprint: 'sprint-b',
        overall_rho: -0.5,
        overall_sample_size: 5,
        categories: [{ category: 'coding', rho: -0.5, sample_size: 5 }],
        notes: 'must never land'
    })).rejects.toMatchObject({
        code: 'CALIBRATION_BASELINE_IDENTITY_MISMATCH',
        statusCode: 409
    });

    await expect(CalibrationBaseline.collection.findOne({ _id: row._id })).resolves.toEqual(before);
});

test('ratification keeps same-label content append-only and exact replay byte-idempotent', async () => {
    const input = {
        label: 'append-only-baseline',
        judge_identity_fingerprint: JUDGE_A,
        source_sprint: 'sprint-a',
        overall_rho: 0.91,
        overall_sample_size: 30,
        categories: [{ category: 'coding', rho: 0.91, sample_size: 30 }],
        notes: 'immutable metrics'
    };
    const row = await ratifyBaseline(input);
    const beforeConflict = await CalibrationBaseline.collection.findOne({ _id: row._id });

    await expect(ratifyBaseline({
        ...input,
        source_sprint: 'rewritten-sprint',
        overall_rho: -0.5,
        categories: [{ category: 'coding', rho: -0.5, sample_size: 5 }]
    })).rejects.toMatchObject({
        code: 'CALIBRATION_BASELINE_CONFLICT',
        statusCode: 409
    });
    await expect(CalibrationBaseline.collection.findOne({ _id: row._id }))
        .resolves.toEqual(beforeConflict);

    await expect(CalibrationBaseline.updateOne(
        { _id: row._id },
        { $set: { overall_rho: -0.5 } }
    )).rejects.toMatchObject(CONTENT_IMMUTABLE);
    const loaded = await CalibrationBaseline.findById(row._id);
    loaded.set('notes', 'ordinary save rewrite', null, { overwriteImmutable: true });
    await expect(loaded.save()).rejects.toMatchObject(CONTENT_IMMUTABLE);
    await expect(CalibrationBaseline.collection.findOne({ _id: row._id }))
        .resolves.toEqual(beforeConflict);

    await expect(ratifyBaseline(input)).resolves.toMatchObject({
        _id: row._id,
        active: true,
        identity_active_slot: JUDGE_A
    });
    await expect(CalibrationBaseline.collection.findOne({ _id: row._id }))
        .resolves.toEqual(beforeConflict);
});

test('controlled ratification leaves exactly one active baseline per identity', async () => {
    await ratifyBaseline({
        label: 'judge-a-first',
        judge_identity_fingerprint: JUDGE_A,
        categories: []
    });
    await ratifyBaseline({
        label: 'judge-a-second',
        judge_identity_fingerprint: JUDGE_A,
        categories: []
    });

    const rows = await CalibrationBaseline.find({
        judge_identity_fingerprint: JUDGE_A
    }).sort({ label: 1 }).lean();
    expect(rows.filter(row => row.active)).toHaveLength(1);
    expect(rows.find(row => row.active)).toMatchObject({
        label: 'judge-a-second',
        identity_active_slot: JUDGE_A
    });
    expect(rows.find(row => row.label === 'judge-a-first')).toMatchObject({ active: false });
    expect(rows.find(row => row.label === 'judge-a-first').identity_active_slot).toBeUndefined();
});

test('controlled ratification keeps cross-identity slots independent and ordinary writes cannot spoof them', async () => {
    const judgeA = await ratifyBaseline({
        label: 'judge-a-active',
        judge_identity_fingerprint: JUDGE_A,
        categories: []
    });
    const judgeB = await ratifyBaseline({
        label: 'judge-b-active',
        judge_identity_fingerprint: JUDGE_B,
        categories: []
    });
    const beforeB = await CalibrationBaseline.collection.findOne({ _id: judgeB._id });

    await expect(CalibrationBaseline.updateOne(
        { _id: judgeB._id },
        { $set: { identity_active_slot: JUDGE_A } }
    )).rejects.toMatchObject(STATE_IMMUTABLE);
    await expect(CalibrationBaseline.create({
        label: 'spoofed-judge-a-slot',
        judge_identity_fingerprint: JUDGE_B,
        categories: [],
        active: true,
        identity_active_slot: JUDGE_A
    })).rejects.toMatchObject(STATE_IMMUTABLE);

    const active = await CalibrationBaseline.find({ active: true }).lean();
    expect(active).toEqual(expect.arrayContaining([
        expect.objectContaining({
            _id: judgeA._id,
            judge_identity_fingerprint: JUDGE_A,
            identity_active_slot: JUDGE_A
        }),
        expect.objectContaining({
            _id: judgeB._id,
            judge_identity_fingerprint: JUDGE_B,
            identity_active_slot: JUDGE_B
        })
    ]));
    expect(active).toHaveLength(2);
    await expect(CalibrationBaseline.collection.findOne({ _id: judgeB._id })).resolves.toEqual(beforeB);
});

test('getActive fails closed on missing slots, duplicate-like state, and a cross-identity slot spoof', async () => {
    const canonical = await ratifyBaseline({
        label: 'canonical-active',
        judge_identity_fingerprint: JUDGE_A,
        categories: []
    });

    await CalibrationBaseline.collection.insertOne({
        label: 'active-without-slot',
        judge_identity_fingerprint: JUDGE_A,
        categories: [],
        active: true,
        createdAt: new Date(),
        updatedAt: new Date()
    });
    await expect(CalibrationBaseline.getActive(JUDGE_A))
        .rejects.toMatchObject({ code: 'CALIBRATION_BASELINE_CONFLICT', statusCode: 409 });

    await CalibrationBaseline.collection.deleteOne({ label: 'active-without-slot' });
    await CalibrationBaseline.collection.updateOne(
        { _id: canonical._id },
        { $set: { active: false }, $unset: { identity_active_slot: '' } }
    );
    await CalibrationBaseline.collection.insertOne({
        label: 'cross-identity-slot-spoof',
        judge_identity_fingerprint: JUDGE_B,
        categories: [],
        active: true,
        identity_active_slot: JUDGE_A,
        createdAt: new Date(),
        updatedAt: new Date()
    });
    await expect(CalibrationBaseline.getActive(JUDGE_A))
        .rejects.toMatchObject({ code: 'CALIBRATION_BASELINE_CONFLICT', statusCode: 409 });
});

test('ratification rejects instead of returning an inactive target after a post-activation race', async () => {
    const rawUpdateOne = CalibrationBaseline.collection.updateOne.bind(CalibrationBaseline.collection);
    const updateSpy = jest.spyOn(CalibrationBaseline.collection, 'updateOne')
        .mockImplementation(async (filter, update, options) => {
            const result = await rawUpdateOne(filter, update, options);
            if (update?.$set?.active === true) {
                await rawUpdateOne(
                    { _id: filter._id },
                    { $set: { active: false }, $unset: { identity_active_slot: '', active_slot: '' } }
                );
            }
            return result;
        });

    try {
        await expect(ratifyBaseline({
            label: 'post-activation-race',
            judge_identity_fingerprint: JUDGE_A,
            categories: []
        })).rejects.toMatchObject({ code: 'CALIBRATION_BASELINE_CONFLICT', statusCode: 409 });
    } finally {
        updateSpy.mockRestore();
    }
});

test('ordinary creation remains available only as an inactive baseline', async () => {
    const [created] = await CalibrationBaseline.insertMany([{
        label: 'ordinary-inactive',
        judge_identity_fingerprint: JUDGE_A,
        categories: []
    }]);

    expect(created.judge_identity_fingerprint).toBe(JUDGE_A);
    expect(created.active).toBe(false);
    expect(created.active_slot).toBeUndefined();
    expect(created.identity_active_slot).toBeUndefined();
});

test('all model deletion surfaces preserve active and inactive baselines byte-for-byte', async () => {
    const inactive = await CalibrationBaseline.create({
        label: 'deletion-inactive',
        judge_identity_fingerprint: JUDGE_A,
        categories: []
    });
    const active = await ratifyBaseline({
        label: 'deletion-active',
        judge_identity_fingerprint: JUDGE_B,
        categories: []
    });
    const before = await CalibrationBaseline.collection.find({})
        .sort({ _id: 1 })
        .toArray();

    await expect(CalibrationBaseline.deleteOne({ _id: active._id }))
        .rejects.toMatchObject(STATE_IMMUTABLE);
    await expect(CalibrationBaseline.deleteMany({ _id: inactive._id }))
        .rejects.toMatchObject(STATE_IMMUTABLE);
    await expect(CalibrationBaseline.findOneAndDelete({ _id: active._id }))
        .rejects.toMatchObject(STATE_IMMUTABLE);
    await expect(CalibrationBaseline.findOneAndRemove({ _id: inactive._id }))
        .rejects.toMatchObject(STATE_IMMUTABLE);
    await expect((await CalibrationBaseline.findById(active._id)).deleteOne())
        .rejects.toMatchObject(STATE_IMMUTABLE);
    await expect((await CalibrationBaseline.findById(inactive._id)).deleteOne())
        .rejects.toMatchObject(STATE_IMMUTABLE);
    await expect(CalibrationBaseline.aggregate([{
        $facet: { destructive: [{ $out: 'calibrationbaselines' }] }
    }])).rejects.toMatchObject(STATE_IMMUTABLE);

    await expect(CalibrationBaseline.collection.find({})
        .sort({ _id: 1 })
        .toArray()).resolves.toEqual(before);
});
