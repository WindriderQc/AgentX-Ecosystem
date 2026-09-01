'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const publicReadContext = new AsyncLocalStorage();

function buildStrictTrustResultExclusion() {
    // Mongoose casts query objects in place, so every query receives a fresh
    // object instead of a shared frozen policy value.
    return {
        $nor: [
            { trust_candidate_id: { $ne: null } },
            { trust_prompt_id: { $ne: null } },
            { trust_evidence_sealed: true }
        ]
    };
}

function isPublicBenchmarkRead() {
    return publicReadContext.getStore()?.excludeStrictTrustResults === true;
}

function runWithPublicBenchmarkReadPrivacy(next) {
    return publicReadContext.run({ excludeStrictTrustResults: true }, next);
}

function runWithVerifiedStrictTrustEvidenceRead(next) {
    // Narrow escape hatch for cryptographic verification code that must load
    // sealed source rows behind an already supplied signed attestation.
    return publicReadContext.run({
        excludeStrictTrustResults: false,
        verifiedStrictTrustEvidenceRead: true
    }, next);
}

function withPublicBenchmarkReadPrivacy(req, _res, next) {
    if (!['GET', 'HEAD'].includes(req.method)) return next();
    return runWithPublicBenchmarkReadPrivacy(next);
}

function withPublicBenchmarkResultReadPrivacy(_req, _res, next) {
    return runWithPublicBenchmarkReadPrivacy(next);
}

function combineWithStrictTrustResultExclusion(filter = {}) {
    return {
        $and: [
            filter && typeof filter === 'object' ? filter : {},
            buildStrictTrustResultExclusion()
        ]
    };
}

function applyStrictTrustExclusionToAggregate(pipeline) {
    const match = { $match: buildStrictTrustResultExclusion() };
    if (!Array.isArray(pipeline)) return [match];
    const firstStage = pipeline[0] || {};
    const mustRemainFirst = Object.hasOwn(firstStage, '$geoNear')
        || Object.hasOwn(firstStage, '$search')
        || Object.hasOwn(firstStage, '$vectorSearch');
    pipeline.splice(mustRemainFirst ? 1 : 0, 0, match);
    return pipeline;
}

module.exports = {
    applyStrictTrustExclusionToAggregate,
    buildStrictTrustResultExclusion,
    combineWithStrictTrustResultExclusion,
    isPublicBenchmarkRead,
    runWithPublicBenchmarkReadPrivacy,
    runWithVerifiedStrictTrustEvidenceRead,
    withPublicBenchmarkReadPrivacy,
    withPublicBenchmarkResultReadPrivacy
};
