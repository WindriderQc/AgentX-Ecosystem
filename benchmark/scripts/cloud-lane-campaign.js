#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { executeCampaign, prepareCampaign } = require('../src/services/benchmark/cloudLaneCampaignRunner');
const { fingerprint } = require('../src/services/benchmark/cloudLaneAccounting');
const { createOllamaTransport, createOpenRouterTransport } = require('../src/services/benchmark/cloudLaneTransports');

function cliError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function usage() {
    return [
        'Usage:',
        '  node scripts/cloud-lane-campaign.js --campaign <json> --fixtures <json>',
        '  node scripts/cloud-lane-campaign.js --campaign <json> --fixtures <json> --transports <json> --output <json> --execute-free',
        '',
        'The default is plan-only and performs zero network calls. --execute-free permits only local and free-cloud candidates.',
        'Paid execution is library-only and requires a host-authenticated approval integration.'
    ].join('\n');
}

function parseArgs(argv) {
    const parsed = { executeFree: false };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (flag === '--execute-free') {
            parsed.executeFree = true;
            continue;
        }
        const names = {
            '--campaign': 'campaignPath',
            '--fixtures': 'fixturesPath',
            '--transports': 'transportsPath',
            '--output': 'outputPath'
        };
        const name = names[flag];
        if (!name) throw cliError('UNKNOWN_ARGUMENT', `Unknown argument: ${flag}\n\n${usage()}`);
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) throw cliError('ARGUMENT_VALUE_REQUIRED', `${flag} requires a value`);
        parsed[name] = value;
        index += 1;
    }
    if (!parsed.campaignPath || !parsed.fixturesPath) throw cliError('INPUT_REQUIRED', usage());
    return parsed;
}

function loadJson(filePath, name) {
    const absolute = path.resolve(filePath);
    let raw;
    try {
        raw = fs.readFileSync(absolute, 'utf8');
    } catch (error) {
        throw cliError('INPUT_READ_FAILED', `Cannot read ${name} file ${absolute}: ${error.message}`);
    }
    try {
        return { absolute, value: JSON.parse(raw) };
    } catch (error) {
        throw cliError('INVALID_JSON', `${name} file is not valid JSON: ${error.message}`);
    }
}

function buildTransports(plan, rawConfig, environment = process.env) {
    const configured = rawConfig?.transports;
    if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
        throw cliError('TRANSPORT_CONFIG_REQUIRED', 'transport config requires a transports object keyed by candidate id');
    }
    const candidateIds = new Set(plan.candidates.map((candidate) => candidate.id));
    const unknown = Object.keys(configured).filter((id) => !candidateIds.has(id));
    if (unknown.length) throw cliError('UNKNOWN_TRANSPORT_CANDIDATE', `transport config contains unknown candidate ids: ${unknown.join(', ')}`);
    return Object.fromEntries(plan.candidates.map((candidate) => {
        const config = configured[candidate.id];
        if (!config || typeof config !== 'object') {
            throw cliError('TRANSPORT_REQUIRED', `missing transport config for ${candidate.id}`);
        }
        if (Object.prototype.hasOwnProperty.call(config, 'apiKey')) {
            throw cliError('INLINE_SECRET_FORBIDDEN', `transport ${candidate.id} must reference an environment variable, not contain an API key`);
        }
        if (config.type === 'ollama') {
            return [candidate.id, createOllamaTransport({ baseUrl: config.baseUrl, timeoutMs: config.timeoutMs })];
        }
        if (config.type === 'openrouter') {
            const envName = String(config.apiKeyEnv || '');
            if (!/^[A-Z_][A-Z0-9_]*$/.test(envName)) {
                throw cliError('API_KEY_ENV_REQUIRED', `transport ${candidate.id} requires a valid apiKeyEnv name`);
            }
            const apiKey = environment[envName];
            if (!apiKey) throw cliError('API_KEY_MISSING', `required credential environment variable is not set: ${envName}`);
            return [candidate.id, createOpenRouterTransport({
                apiKey,
                baseUrl: config.baseUrl,
                modelsUrl: config.modelsUrl,
                timeoutMs: config.timeoutMs
            })];
        }
        throw cliError('UNKNOWN_TRANSPORT_TYPE', `unsupported transport type for ${candidate.id}: ${config.type}`);
    }));
}

function print(value, output = process.stdout) {
    output.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function run(argv = process.argv.slice(2), dependencies = {}) {
    const args = parseArgs(argv);
    const campaignFile = loadJson(args.campaignPath, 'campaign');
    const fixtureFile = loadJson(args.fixturesPath, 'fixtures');
    const attempts = campaignFile.value.attempts == null ? 1 : campaignFile.value.attempts;
    const prepared = prepareCampaign({ plan: campaignFile.value, fixtures: fixtureFile.value, attempts });
    if (!args.executeFree) {
        const summary = {
            mode: 'plan_only',
            campaign: prepared.plan.campaignId,
            lane: prepared.plan.lane,
            candidates: prepared.plan.candidates.map(({ id, tier }) => ({ id, tier })),
            estimatedCalls: prepared.plan.estimatedCalls,
            planFingerprint: prepared.plan.planFingerprint,
            preparedFingerprint: prepared.fingerprint,
            networkCalls: 0,
            paidSpendNanodollars: 0,
            routeMutation: false,
            networkAuthorized: false
        };
        print(summary, dependencies.stdout);
        return summary;
    }
    if (prepared.plan.cohorts.paid_cloud.length) {
        throw cliError('PAID_EXECUTION_UNAVAILABLE', 'this CLI never executes paid-cloud candidates; use a reviewed host integration with authenticated approval');
    }
    if (!args.transportsPath || !args.outputPath) {
        throw cliError('EXECUTION_FILES_REQUIRED', '--execute-free requires both --transports and --output so raw evidence is retained');
    }
    const transportFile = loadJson(args.transportsPath, 'transports');
    const transports = buildTransports(prepared.plan, transportFile.value, dependencies.environment || process.env);
    const startedAt = new Date(dependencies.now || Date.now());
    const actor = dependencies.actor || os.userInfo().username;
    const result = await executeCampaign({
        plan: prepared.plan,
        fixtures: fixtureFile.value,
        attempts,
        transports,
        now: startedAt,
        authorizeExecution: async ({ plan, requestedCalls, requestedSpendNanodollars }) => ({
            authorized: true,
            authorizationId: fingerprint({ actor, pid: process.pid, startedAt: startedAt.toISOString(), plan: plan.planFingerprint }),
            authenticatedActor: actor,
            authenticationMethod: 'local-os-session-plus-explicit-cli-flag',
            authenticatedAt: startedAt.toISOString(),
            planFingerprint: plan.planFingerprint,
            maxCalls: requestedCalls,
            maxSpendNanodollars: requestedSpendNanodollars
        })
    });
    const outputPath = path.resolve(args.outputPath);
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    const summary = {
        mode: 'executed_local_and_free_cloud',
        campaign: result.plan.campaignId,
        calls: result.counters.calls,
        paidCalls: result.counters.paidCalls,
        paidSpendNanodollars: result.counters.spendNanodollars,
        evidenceArtifact: outputPath,
        artifactFingerprint: result.fingerprint,
        universalWinner: null,
        routeMutation: false,
        networkAuthorized: false
    };
    print(summary, dependencies.stdout);
    return summary;
}

if (require.main === module) {
    run().catch((error) => {
        process.stderr.write(`${error.code || 'CAMPAIGN_FAILED'}: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { buildTransports, loadJson, parseArgs, run, usage };
