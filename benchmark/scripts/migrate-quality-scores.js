/**
 * Migrate Quality Scores to 0-10 Scale
 *
 * Purpose: Normalize all quality_score values to 0-10 scale
 * Converts 0-100 values to 0-10 and recalculates dependent metrics
 *
 * CRITICAL: Run analyze-quality-scores.js first to understand current state
 * CRITICAL: Backup database before running this script
 *
 * Usage: node scripts/migrate-quality-scores.js [--dry-run]
 */

const mongoose = require('mongoose');
const BenchmarkResult = require('../models/BenchmarkResult');
const HardwareProfile = require('../models/HardwareProfile');
const logger = require('../config/logger');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

async function migrateQualityScores() {
    try {
        console.log('\n========================================');
        console.log('QUALITY SCORE MIGRATION SCRIPT');
        console.log('========================================\n');

        if (DRY_RUN) {
            console.log('🔍 DRY RUN MODE - No changes will be made\n');
        } else {
            console.log('⚠️  LIVE MODE - Database will be modified\n');
            console.log('Waiting 5 seconds... Press Ctrl+C to cancel\n');
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        // Connect to MongoDB
        await mongoose.connect(process.env.MONGODB_URI);
        logger.info('Connected to MongoDB for migration');

        // ============================================================
        // STEP 1: Migrate BenchmarkResult quality_score
        // ============================================================
        console.log('STEP 1: Migrate BenchmarkResult quality_score (0-100 → 0-10)');
        console.log('─────────────────────────────────────────────────────\n');

        const resultsToMigrate = await BenchmarkResult.find({
            quality_score: { $gt: 10 }
        }).select('_id model quality_score composite_score');

        console.log(`Found ${resultsToMigrate.length} records with quality_score > 10\n`);

        if (resultsToMigrate.length > 0) {
            console.log('Sample records to migrate:');
            resultsToMigrate.slice(0, 5).forEach(r => {
                const newScore = r.quality_score / 10;
                const compositeNote = (r.composite_score && r.composite_score > 100) ? ` (composite_score ${r.composite_score} → null)` : '';
                console.log(`  ${r.model}: ${r.quality_score} → ${newScore.toFixed(1)}${compositeNote}`);
            });

            if (!DRY_RUN) {
                let migratedCount = 0;
                for (const result of resultsToMigrate) {
                    result.quality_score = result.quality_score / 10;
                    // Fix composite_score if it violates schema (max: 100)
                    if (result.composite_score && result.composite_score > 100) {
                        result.composite_score = null;  // Set to null, will be recalculated later
                    }
                    await result.save();
                    migratedCount++;

                    if (migratedCount % 100 === 0) {
                        console.log(`  Progress: ${migratedCount}/${resultsToMigrate.length}`);
                    }
                }
                console.log(`\n✅ Migrated ${migratedCount} BenchmarkResult records`);
            } else {
                console.log('\n🔍 DRY RUN - Would migrate ' + resultsToMigrate.length + ' records');
            }
        } else {
            console.log('✅ No BenchmarkResult records need migration\n');
        }

        // ============================================================
        // STEP 2: Migrate HardwareProfile avg_quality_score
        // ============================================================
        console.log('\n\nSTEP 2: Migrate HardwareProfile avg_quality_score (0-100 → 0-10)');
        console.log('─────────────────────────────────────────────────────\n');

        const profilesToMigrate = await HardwareProfile.find({
            avg_quality_score: { $gt: 10 }
        }).select('_id model avg_quality_score vram_efficiency speed_efficiency');

        console.log(`Found ${profilesToMigrate.length} profiles with avg_quality_score > 10\n`);

        if (profilesToMigrate.length > 0) {
            console.log('Sample profiles to migrate:');
            profilesToMigrate.slice(0, 5).forEach(p => {
                const newScore = p.avg_quality_score / 10;
                console.log(`  ${p.model}: ${p.avg_quality_score} → ${newScore.toFixed(1)}`);
            });

            if (!DRY_RUN) {
                let migratedCount = 0;
                for (const profile of profilesToMigrate) {
                    profile.avg_quality_score = profile.avg_quality_score / 10;
                    await profile.save();
                    migratedCount++;
                }
                console.log(`\n✅ Migrated ${migratedCount} HardwareProfile records`);
            } else {
                console.log('\n🔍 DRY RUN - Would migrate ' + profilesToMigrate.length + ' profiles');
            }
        } else {
            console.log('✅ No HardwareProfile records need migration\n');
        }

        // ============================================================
        // STEP 3: Recalculate HardwareProfile efficiency metrics
        // ============================================================
        console.log('\n\nSTEP 3: Recalculate HardwareProfile efficiency metrics');
        console.log('─────────────────────────────────────────────────────\n');

        const allProfiles = await HardwareProfile.find({
            avg_quality_score: { $ne: null }
        });

        console.log(`Found ${allProfiles.length} profiles to recalculate\n`);

        if (allProfiles.length > 0 && !DRY_RUN) {
            let recalculatedCount = 0;
            for (const profile of allProfiles) {
                const oldVramEff = profile.vram_efficiency;
                const oldSpeedEff = profile.speed_efficiency;

                profile.calculateEfficiency();
                await profile.save();

                if (recalculatedCount < 5) {
                    console.log(`  ${profile.model}:`);
                    console.log(`    VRAM efficiency: ${oldVramEff} → ${profile.vram_efficiency}`);
                    console.log(`    Speed efficiency: ${oldSpeedEff} → ${profile.speed_efficiency}`);
                }

                recalculatedCount++;
            }
            console.log(`\n✅ Recalculated ${recalculatedCount} HardwareProfile efficiency metrics`);
        } else if (DRY_RUN) {
            console.log('🔍 DRY RUN - Would recalculate ' + allProfiles.length + ' profiles');
        }

        // ============================================================
        // STEP 4: Verification
        // ============================================================
        console.log('\n\nSTEP 4: Verification');
        console.log('─────────────────────────────────────────────────────\n');

        if (!DRY_RUN) {
            const invalidBenchmarks = await BenchmarkResult.countDocuments({
                quality_score: { $gt: 10 }
            });

            const invalidProfiles = await HardwareProfile.countDocuments({
                avg_quality_score: { $gt: 10 }
            });

            if (invalidBenchmarks === 0 && invalidProfiles === 0) {
                console.log('✅ All quality scores are now 0-10');
                console.log('✅ Migration successful!\n');

                // Stats
                const stats = await BenchmarkResult.aggregate([
                    { $match: { quality_score: { $ne: null } } },
                    { $group: {
                        _id: null,
                        min: { $min: '$quality_score' },
                        max: { $max: '$quality_score' },
                        avg: { $avg: '$quality_score' }
                    }}
                ]);

                if (stats.length > 0) {
                    console.log('📊 Post-migration statistics:');
                    console.log(`   Min: ${stats[0].min}`);
                    console.log(`   Max: ${stats[0].max}`);
                    console.log(`   Avg: ${stats[0].avg.toFixed(2)}`);
                }
            } else {
                console.log('❌ Migration incomplete!');
                console.log(`   ${invalidBenchmarks} BenchmarkResults still have quality_score > 10`);
                console.log(`   ${invalidProfiles} HardwareProfiles still have avg_quality_score > 10`);
            }
        }

        console.log('\n========================================');
        console.log('MIGRATION COMPLETE');
        console.log('========================================\n');

        if (!DRY_RUN) {
            console.log('✅ Next steps:');
            console.log('   1. Update BenchmarkResult schema: max: 10 (was 100)');
            console.log('   2. Deploy frontend fixes (Model Explorer, Hardware Matrix)');
            console.log('   3. Remove defensive code in benchmarkService.js line 424-426');
            console.log('   4. Test thoroughly\n');
        } else {
            console.log('🔍 To run migration for real, execute:');
            console.log('   node scripts/migrate-quality-scores.js\n');
        }

        await mongoose.connection.close();
        process.exit(0);

    } catch (error) {
        logger.error('Migration failed', { error: error.message, stack: error.stack });
        console.error('\n❌ Migration Error:', error.message);
        console.error('\n⚠️  Database may be in inconsistent state!');
        console.error('   Restore from backup if needed\n');
        process.exit(1);
    }
}

// Run migration
migrateQualityScores();
