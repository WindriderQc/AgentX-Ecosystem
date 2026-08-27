#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
    attributeProviderCall,
    buildCampaignPlan,
    compareLaneObservations
} = require('../src/services/benchmark/cloudLaneAccounting');

const fixturePath = path.join(__dirname, '..', 'data', 'cloud-lane-comparison-offline.v1.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const candidates = new Map(fixture.candidates.map((candidate) => [candidate.id, candidate]));
const paidCandidate = fixture.candidates.find((candidate) => candidate.tier === 'paid_cloud');

const plan = buildCampaignPlan({
    campaignId: fixture.campaignId,
    lane: fixture.lane,
    contract: fixture.contract,
    candidates: fixture.candidates,
    estimatedCalls: fixture.estimatedCalls,
    spendCeilingNanodollars: fixture.spendCeilingNanodollars
});

const attribution = attributeProviderCall({
    ...fixture.paidCall,
    campaignId: fixture.campaignId,
    lane: fixture.lane,
    tier: paidCandidate.tier,
    provider: paidCandidate.provider,
    model: paidCandidate.model,
    modelVersion: paidCandidate.modelVersion,
    pricing: paidCandidate.priceSnapshot
});

const observations = fixture.observations.map((row) => {
    const candidate = candidates.get(row.candidateId);
    if (!candidate) throw new Error(`Unknown offline candidate: ${row.candidateId}`);
    return {
        campaignId: fixture.campaignId,
        lane: fixture.lane,
        evidenceType: 'synthetic',
        candidate,
        contract: fixture.contract,
        observedAt: fixture.generatedAt,
        attempts: row.attempts,
        successes: row.successes,
        metrics: row.metrics,
        attribution: candidate.tier === 'paid_cloud' ? attribution : null
    };
});

const report = compareLaneObservations({
    lane: fixture.lane,
    observations,
    generatedAt: fixture.generatedAt
});

process.stdout.write(`${JSON.stringify({
    fixture: path.basename(fixturePath),
    networkCalls: 0,
    paidSpendNanodollars: 0,
    syntheticAttributionNanodollars: attribution.totalCostNanodollars,
    syntheticAttributionUsd: attribution.totalCostUsd,
    planFingerprint: plan.planFingerprint,
    reportFingerprint: report.fingerprint,
    evidenceScope: report.evidenceScope,
    cohorts: plan.cohorts,
    universalWinner: report.universalWinner,
    routeMutation: report.routeMutation,
    networkAuthorized: report.networkAuthorized
}, null, 2)}\n`);
