/**
 * Seed Model Registry — Metadata Enrichment
 *
 * Enriches registry entries with curated metadata (categories, tags, routing rules,
 * descriptions). If a listed model is not yet in the registry, it is created with
 * sourceType: 'manual', so every definition below must name a real deployable model.
 *
 * Usage:
 *   node scripts/seed-model-registry.js [--force]
 *
 * Options:
 *   --force    Update even models that already have curated metadata
 */

const mongoose = require('mongoose');
const ModelRegistry = require('../models/ModelRegistry');
const logger = require('../config/logger');

// Model definitions based on common Ollama models + AgentX usage patterns
const MODELS = [
  // ========== CODING SPECIALISTS ==========
  {
    modelName: 'qwen2.5-coder:7b',
    displayName: 'Qwen 2.5 Coder 7B',
    vendor: 'alibaba',
    description: 'Code-specialized model optimized for generation, refactoring, and debugging',
    categories: ['coding', 'specialist'],
    tags: ['production', 'fast', 'code-generation'],
    capabilities: {
      maxContext: 32768,
      supportsThinking: false,
      avgLatencyMs: 2500,
      targetUseCase: 'Code generation, refactoring, and technical documentation'
    },
    routingRules: {
      preferredFor: ['code_generation', 'data_analysis'],
      avoidFor: ['creative_writing'],
      priority: 9
    }
  },
  {
    modelName: 'qwen2.5-coder:14b',
    displayName: 'Qwen 2.5 Coder 14B',
    vendor: 'alibaba',
    description: 'Larger code-specialized model with enhanced reasoning for complex codebases',
    categories: ['coding', 'specialist', 'reasoning'],
    tags: ['production', 'high-quality'],
    capabilities: {
      maxContext: 32768,
      supportsThinking: false,
      avgLatencyMs: 5000,
      targetUseCase: 'Complex code generation, architecture design, code review'
    },
    routingRules: {
      preferredFor: ['code_generation', 'deep_reasoning'],
      avoidFor: ['time_sensitive'],
      priority: 8
    }
  },

  // ========== REASONING MODELS ==========
  {
    modelName: 'deepseek-r1:7b',
    displayName: 'DeepSeek R1 7B',
    vendor: 'deepseek',
    description: 'Reasoning-optimized model with explicit thinking process',
    categories: ['reasoning', 'specialist'],
    tags: ['experimental', 'thinking-model', 'slow'],
    capabilities: {
      maxContext: 8192,
      supportsThinking: true,
      avgLatencyMs: 8000,
      p95LatencyMs: 30000,
      targetUseCase: 'Deep reasoning, problem-solving, multi-step logic'
    },
    routingRules: {
      preferredFor: ['deep_reasoning', 'math'],
      avoidFor: ['time_sensitive', 'quick_chat'],
      priority: 7
    }
  },
  {
    modelName: 'qwen2.5:7b',
    displayName: 'Qwen 2.5 7B',
    vendor: 'alibaba',
    description: 'Balanced model with thinking capabilities and strong reasoning',
    categories: ['reasoning', 'generalist'],
    tags: ['production', 'thinking-model', 'balanced'],
    capabilities: {
      maxContext: 32768,
      supportsThinking: true,
      avgLatencyMs: 3000,
      targetUseCase: 'General reasoning with transparency into thought process'
    },
    routingRules: {
      preferredFor: ['deep_reasoning', 'factual_qa'],
      avoidFor: [],
      priority: 8
    }
  },

  // ========== GENERALISTS ==========
  {
    modelName: 'qwen2.5:7b-instruct-q5_K_M',
    displayName: 'Qwen 2.5 7B Instruct (Q5_K_M)',
    vendor: 'alibaba',
    description: 'Higher-quality quantized generalist model, excellent for judging tasks',
    categories: ['generalist', 'judge', 'ops'],
    tags: ['production', 'fast', 'recommended', 'judge'],
    capabilities: {
      maxContext: 32768,
      supportsThinking: false,
      avgLatencyMs: 2500,
      targetUseCase: 'General-purpose chat, quality scoring, LLM-as-judge',
      judgeTier: 'standard',
      judgeReliability: 0.95
    },
    routingRules: {
      preferredFor: ['quick_chat', 'factual_qa'],
      avoidFor: [],
      priority: 10
    }
  },
  {
    modelName: 'llama3.3:70b',
    displayName: 'Llama 3.3 70B',
    vendor: 'meta',
    description: 'Large generalist model with excellent quality across domains',
    categories: ['generalist', 'reasoning'],
    tags: ['production', 'high-quality', 'slow'],
    capabilities: {
      maxContext: 128000,
      supportsThinking: false,
      avgLatencyMs: 12000,
      targetUseCase: 'High-quality responses, complex queries, long-context tasks'
    },
    routingRules: {
      preferredFor: ['deep_reasoning', 'creative_writing'],
      avoidFor: ['time_sensitive'],
      priority: 6
    }
  },

  // ========== OPS/GLUE MODELS ==========
  {
    modelName: 'smollm2:1.7b',
    displayName: 'SmolLM2 1.7B',
    vendor: 'community',
    description: 'Ultra-fast tiny model for simple operations and routing decisions',
    categories: ['ops', 'specialist'],
    tags: ['experimental', 'ultra-fast', 'glue-logic'],
    capabilities: {
      maxContext: 2048,
      supportsThinking: false,
      avgLatencyMs: 500,
      targetUseCase: 'Query classification, intent detection, simple confirmations'
    },
    routingRules: {
      preferredFor: ['quick_chat'],
      avoidFor: ['code_generation', 'deep_reasoning', 'creative_writing'],
      priority: 4
    }
  },
  // ========== EMBEDDING MODELS ==========
  {
    modelName: 'nomic-embed-text',
    displayName: 'Nomic Embed Text',
    vendor: 'community',
    description: 'Text embedding model for RAG and semantic search',
    categories: ['embedding'],
    tags: ['production', 'rag', 'embeddings'],
    capabilities: {
      maxContext: 2048,
      supportsThinking: false,
      avgLatencyMs: 100,
      targetUseCase: 'Document embeddings, semantic search, RAG ingestion'
    },
    routingRules: {
      preferredFor: [],
      avoidFor: ['code_generation', 'deep_reasoning', 'factual_qa', 'creative_writing'],
      priority: 10
    }
  },
  {
    modelName: 'mxbai-embed-large',
    displayName: 'MxBai Embed Large',
    vendor: 'community',
    description: 'Large embedding model with high-quality representations',
    categories: ['embedding'],
    tags: ['production', 'rag', 'embeddings', 'high-quality'],
    capabilities: {
      maxContext: 512,
      supportsThinking: false,
      avgLatencyMs: 150,
      targetUseCase: 'High-quality embeddings for critical RAG applications'
    },
    routingRules: {
      preferredFor: [],
      avoidFor: ['code_generation', 'deep_reasoning', 'factual_qa', 'creative_writing'],
      priority: 9
    }
  },

  // ========== JUDGE MODELS ==========
  {
    modelName: 'llama3.1:8b',
    displayName: 'Llama 3.1 8B',
    vendor: 'meta',
    description: 'Balanced model used for quality scoring in benchmarks',
    categories: ['judge', 'generalist'],
    tags: ['production', 'judge', 'balanced'],
    capabilities: {
      maxContext: 128000,
      supportsThinking: false,
      avgLatencyMs: 3500,
      targetUseCase: 'LLM-as-judge quality scoring, evaluation tasks',
      judgeTier: 'standard',
      judgeReliability: 0.97
    },
    routingRules: {
      preferredFor: ['factual_qa'],
      avoidFor: [],
      priority: 7
    }
  }
];

// Fields safe to enrich without clobbering auto-sync data
const ENRICHMENT_FIELDS = [
  'displayName', 'vendor', 'description', 'categories', 'tags',
  'capabilities', 'routingRules'
];

/**
 * Main seeding function
 */
async function seedModelRegistry(options = {}) {
  const { force = false } = options;

  logger.info('Starting ModelRegistry metadata enrichment...', { force });

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const modelData of MODELS) {
    try {
      const existing = await ModelRegistry.findOne({ modelName: modelData.modelName });

      if (existing && !force) {
        // Only enrich if no categories set yet (auto-sync creates with empty categories)
        if (existing.categories.length === 0) {
          for (const field of ENRICHMENT_FIELDS) {
            if (modelData[field] != null) existing[field] = modelData[field];
          }
          existing.lastUpdated = new Date();
          await existing.save();
          logger.info(`Enriched model: ${modelData.modelName}`);
          updated++;
        } else {
          logger.debug(`Skipping model with existing metadata: ${modelData.modelName}`);
          skipped++;
        }
        continue;
      }

      if (existing && force) {
        // Force mode: update enrichment fields only, preserve auto-sync fields
        for (const field of ENRICHMENT_FIELDS) {
          if (modelData[field] != null) existing[field] = modelData[field];
        }
        existing.lastUpdated = new Date();
        await existing.save();
        logger.info(`Updated model metadata: ${modelData.modelName}`);
        updated++;
      } else {
        // Create new — model not discovered by auto-sync yet
        await ModelRegistry.create({
          ...modelData,
          sourceType: 'manual',
          createdBy: 'seed-script'
        });
        logger.info(`Created model: ${modelData.modelName}`);
        created++;
      }
    } catch (err) {
      logger.error(`Failed to seed model ${modelData.modelName}`, { error: err.message });
    }
  }

  logger.info('ModelRegistry enrichment complete', {
    created,
    updated,
    skipped,
    total: MODELS.length
  });

  return { created, updated, skipped, total: MODELS.length };
}

/**
 * CLI execution
 */
if (require.main === module) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');

  // Connect to MongoDB
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx';

  mongoose.connect(mongoUri)
    .then(() => {
      logger.info('Connected to MongoDB');
      return seedModelRegistry({ force });
    })
    .then((stats) => {
      logger.info('Seeding completed successfully', stats);
      process.exit(0);
    })
    .catch((err) => {
      logger.error('Seeding failed', { error: err.message });
      process.exit(1);
    });
}

module.exports = { seedModelRegistry, MODELS };
