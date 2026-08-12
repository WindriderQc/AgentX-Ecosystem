/**
 * Analyze Quality Score Distribution
 *
 * Purpose: Analyze current quality_score values in database before migration
 * Identifies mixed scales (0-10 vs 0-100) and provides migration readiness report
 *
 * Usage: node scripts/analyze-quality-scores.js
 */

const mongoose = require('mongoose');
const BenchmarkResult = require('../models/BenchmarkResult');
const HardwareProfile = require('../models/HardwareProfile');
const logger = require('../config/logger');
require('dotenv').config();

async function analyzeQualityScores() {
    try {
        // Connect to MongoDB
        await mongoose.connect(process.env.MONGODB_URI);
        logger.info('Connected to MongoDB for analysis');

        // Analyze BenchmarkResult quality scores
        console.log('\n========================================');
        console.log('BENCHMARK RESULT QUALITY SCORE ANALYSIS');
        console.log('========================================\n');

        const benchmarkStats = await BenchmarkResult.aggregate([
            { $match: { quality_score: { $ne: null } } },
            {
                $group: {
                    _id: null,
                    min: { $min: '$quality_score' },
                    max: { $max: '$quality_score' },
                    avg: { $avg: '$quality_score' },
                    count: { $sum: 1 },
                    above10: {
                        $sum: { $cond: [{ $gt: ['$quality_score', 10] }, 1, 0] }
                    },
                    below0: {
                        $sum: { $cond: [{ $lt: ['$quality_score', 0] }, 1, 0] }
                    }
                }
            }
        ]);

        if (benchmarkStats.length > 0) {
            const stats = benchmarkStats[0];
            console.log('Total records with quality_score:', stats.count);
            console.log('Min quality_score:', stats.min);
            console.log('Max quality_score:', stats.max);
            console.log('Avg quality_score:', stats.avg.toFixed(2));
            console.log('Records with quality_score > 10:', stats.above10, `(${((stats.above10 / stats.count) * 100).toFixed(1)}%)`);
            console.log('Records with quality_score < 0:', stats.below0, `(${((stats.below0 / stats.count) * 100).toFixed(1)}%)`);

            // Determine scale distribution
            const percentAbove10 = (stats.above10 / stats.count) * 100;

            console.log('\n📊 Scale Analysis:');
            if (percentAbove10 > 80) {
                console.log('✅ Majority using 0-100 scale (' + percentAbove10.toFixed(1) + '%)');
                console.log('   Recommendation: Standardize on 0-100');
            } else if (percentAbove10 < 20) {
                console.log('✅ Majority using 0-10 scale (' + (100 - percentAbove10).toFixed(1) + '%)');
                console.log('   Recommendation: Standardize on 0-10');
            } else {
                console.log('⚠️  MIXED SCALES DETECTED!');
                console.log('   ' + (100 - percentAbove10).toFixed(1) + '% using 0-10 scale');
                console.log('   ' + percentAbove10.toFixed(1) + '% using 0-100 scale');
                console.log('   Recommendation: Run migration to normalize');
            }

            // Sample records in each range
            console.log('\n📋 Sample Records by Range:');

            const samples010 = await BenchmarkResult.find({ quality_score: { $gte: 0, $lte: 10 } })
                .limit(3)
                .select('model quality_score composite_score prompt_level createdAt');

            if (samples010.length > 0) {
                console.log('\n  0-10 range (sample):');
                samples010.forEach(s => {
                    console.log(`    ${s.model}: quality=${s.quality_score}, composite=${s.composite_score}, level=${s.prompt_level}`);
                });
            }

            const samplesAbove10 = await BenchmarkResult.find({ quality_score: { $gt: 10 } })
                .limit(3)
                .select('model quality_score composite_score prompt_level createdAt');

            if (samplesAbove10.length > 0) {
                console.log('\n  > 10 range (sample):');
                samplesAbove10.forEach(s => {
                    console.log(`    ${s.model}: quality=${s.quality_score}, composite=${s.composite_score}, level=${s.prompt_level}`);
                });
            }
        } else {
            console.log('⚠️  No benchmark results with quality_score found');
        }

        // Analyze HardwareProfile quality scores
        console.log('\n\n========================================');
        console.log('HARDWARE PROFILE QUALITY SCORE ANALYSIS');
        console.log('========================================\n');

        const hardwareStats = await HardwareProfile.aggregate([
            { $match: { avg_quality_score: { $ne: null } } },
            {
                $group: {
                    _id: null,
                    min: { $min: '$avg_quality_score' },
                    max: { $max: '$avg_quality_score' },
                    avg: { $avg: '$avg_quality_score' },
                    count: { $sum: 1 },
                    above10: {
                        $sum: { $cond: [{ $gt: ['$avg_quality_score', 10] }, 1, 0] }
                    }
                }
            }
        ]);

        if (hardwareStats.length > 0) {
            const stats = hardwareStats[0];
            console.log('Total hardware profiles:', stats.count);
            console.log('Min avg_quality_score:', stats.min);
            console.log('Max avg_quality_score:', stats.max);
            console.log('Avg avg_quality_score:', stats.avg.toFixed(2));
            console.log('Profiles with avg_quality_score > 10:', stats.above10, `(${((stats.above10 / stats.count) * 100).toFixed(1)}%)`);

            // Sample profiles
            const profileSamples = await HardwareProfile.find({ avg_quality_score: { $ne: null } })
                .limit(3)
                .select('model avg_quality_score vram_efficiency speed_efficiency backend');

            console.log('\n📋 Sample Hardware Profiles:');
            profileSamples.forEach(p => {
                console.log(`  ${p.model} (${p.backend}):`);
                console.log(`    avg_quality=${p.avg_quality_score}, vram_eff=${p.vram_efficiency}, speed_eff=${p.speed_efficiency}`);
            });
        } else {
            console.log('⚠️  No hardware profiles found');
        }

        // Migration readiness check
        console.log('\n\n========================================');
        console.log('MIGRATION READINESS CHECK');
        console.log('========================================\n');

        const totalRecords = benchmarkStats[0]?.count || 0;
        const mixedData = benchmarkStats[0]?.above10 > 0 && (totalRecords - benchmarkStats[0]?.above10) > 0;

        if (mixedData) {
            console.log('⚠️  MIXED DATA DETECTED - Migration Required');
            console.log('\n✅ Pre-migration checklist:');
            console.log('   [ ] 1. Backup database (mongodump)');
            console.log('   [ ] 2. Choose target scale (0-10 recommended)');
            console.log('   [ ] 3. Stop application server');
            console.log('   [ ] 4. Run migration script');
            console.log('   [ ] 5. Verify migration results');
            console.log('   [ ] 6. Deploy updated code');
            console.log('   [ ] 7. Restart application');
        } else {
            console.log('✅ Data is consistent - Update schema to match actual scale');
        }

        console.log('\n');

        await mongoose.connection.close();
        process.exit(0);

    } catch (error) {
        logger.error('Analysis failed', { error: error.message });
        console.error('\n❌ Error:', error.message);
        process.exit(1);
    }
}

// Run analysis
analyzeQualityScores();
