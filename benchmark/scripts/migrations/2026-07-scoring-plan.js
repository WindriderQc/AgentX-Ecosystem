#!/usr/bin/env node

const mongoose = require('mongoose');
const connectDB = require('../../config/db');
const BenchmarkPrompt = require('../../models/BenchmarkPrompt');
const { inferLegacyPlan, PLANS } = require('../../src/services/scoring/scoringPlan');
const { CATEGORY_STRATEGIES } = require('../../src/services/scoring/scoringConfigs');

const APPLY = process.argv.includes('--apply');
const PRESERVE_CRITERIA = process.argv.includes('--preserve-criteria');

async function main() {
    await connectDB();
    const prompts = await BenchmarkPrompt.find({}).lean();
    const ops = [];
    const criteriaPrompts = [];
    let alreadyExplicit = 0;

    for (const prompt of prompts) {
        if (prompt.scoring_plan) {
            alreadyExplicit += 1;
            continue;
        }
        let plan = inferLegacyPlan(prompt, CATEGORY_STRATEGIES);
        if (plan === PLANS.CRITERIA) {
            criteriaPrompts.push(prompt.name);
            if (!PRESERVE_CRITERIA) plan = PLANS.LLM_JUDGE;
        }
        ops.push({
            updateOne: {
                filter: {
                    _id: prompt._id,
                    $or: [
                        { scoring_plan: null },
                        { scoring_plan: { $exists: false } }
                    ]
                },
                update: { $set: { scoring_plan: plan } }
            }
        });
    }

    console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}${PRESERVE_CRITERIA ? ' (+preserve-criteria)' : ' (+demote-criteria default)'}`);
    console.log(`Prompts scanned: ${prompts.length}`);
    console.log(`Already explicit: ${alreadyExplicit}`);
    console.log(`Would update: ${ops.length}`);

    if (criteriaPrompts.length > 0) {
        console.log(`${criteriaPrompts.length} prompt(s) matched the legacy criteria-regex route:`);
        for (const name of criteriaPrompts) console.log(`  - ${name}`);
        console.log(PRESERVE_CRITERIA
            ? 'Criteria prompts will be preserved as criteria. Only use this if criteria scoring is restored.'
            : 'Criteria prompts will be demoted to llm_judge because criteria-regex scoring is not executable in this checkout.');
    }

    if (APPLY && ops.length > 0) {
        const result = await BenchmarkPrompt.bulkWrite(ops, { ordered: false });
        console.log(`Applied updates: matched=${result.matchedCount || 0}, modified=${result.modifiedCount || 0}`);
    }
}

if (require.main === module) {
    main()
        .catch((error) => {
            console.error(`scoring-plan migration failed: ${error.message}`);
            process.exitCode = 1;
        })
        .finally(() => mongoose.disconnect().catch(() => {}));
}
