const mongoose = require('mongoose');
const logger = require('./logger');

function deriveTestMongoUri(uri) {
  const fallback = 'mongodb://localhost:27017/agentx_test';
  if (!uri || typeof uri !== 'string') return fallback;

  const parts = uri.split('?');
  const base = parts[0];
  const query = parts.length > 1 ? parts.slice(1).join('?') : '';

  const lastSlash = base.lastIndexOf('/');
  if (lastSlash === -1) return fallback;

  const prefix = base.slice(0, lastSlash + 1);
  const dbName = base.slice(lastSlash + 1);
  const nextDbName = dbName ? `${dbName}_test` : 'agentx_test';

  return query ? `${prefix}${nextDbName}?${query}` : `${prefix}${nextDbName}`;
}

function getTestServerSelectionTimeoutMs() {
  const configured = Number(process.env.MONGODB_TEST_SERVER_SELECTION_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return process.platform === 'win32' ? 5000 : 1000;
}

const connectDB = async () => {
  try {
    const isTest = process.env.NODE_ENV === 'test';
    const mongoUri = isTest
      ? (process.env.MONGODB_URI_TEST || deriveTestMongoUri(process.env.MONGODB_URI))
      : (process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx');

    const conn = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: isTest ? getTestServerSelectionTimeoutMs() : 2000,
      // Production can keep a deeper pool warm; tests mostly run single-request
      // flows and benefit from cheaper setup/teardown.
      maxPoolSize: isTest ? 10 : 50,
      minPoolSize: isTest ? 0 : 10,
      maxIdleTimeMS: 30000,
      socketTimeoutMS: 45000,
      family: 4,
      // In tests we create a time-series collection explicitly; prevent Mongoose
      // from eagerly creating regular collections/indexes for registered models.
      autoCreate: !isTest,
      autoIndex: !isTest
    });
    logger.info('MongoDB connected', {
      host: conn.connection.host,
      port: conn.connection.port,
      db: conn.connection.name,
      poolSize: `${conn.connection.client.options.minPoolSize}-${conn.connection.client.options.maxPoolSize}`
    });

    // Ensure time-series collection for metrics exists before other startup tasks
    await ensureTimeSeriesCollections();

    // V4: Initialize default PromptConfig if none exist
    await ensureDefaultPromptConfig();
  } catch (err) {
    logger.error('MongoDB connection failed', { error: err.message });
    // In tests we must fail fast; otherwise queries buffer and tests time out.
    if (process.env.NODE_ENV === 'test') {
      throw err;
    }

    // Don't kill the server if DB is missing, just log error for now to allow frontend verification
    // process.exit(1);
  }
};

/**
 * V4: Ensure at least one active PromptConfig exists
 * Contract: specs/V4_ANALYTICS_ARCHITECTURE.md § 1
 */
async function ensureDefaultPromptConfig() {
  try {
    const PromptConfig = require('../models/PromptConfig');

    const activePrompt = await PromptConfig.findOne({ name: 'default_chat', isActive: true });

    if (!activePrompt) {
      logger.info('[V4] No active prompt found, creating default_chat v1');

      const defaultPrompt = new PromptConfig({
        name: 'default_chat',
        version: 1,
        systemPrompt: 'You are AgentX, a concise and capable local assistant. Keep answers brief and actionable.',
        description: 'Initial default system prompt',
        isActive: true,
        author: 'system'
      });

      await defaultPrompt.save();
      logger.info('[V4] Created default_chat v1', { status: 'active' });
    } else {
      logger.info('[V4] Active prompt loaded', {
        name: activePrompt.name,
        version: activePrompt.version
      });
    }
  } catch (err) {
    logger.error('[V4] Failed to initialize PromptConfig', { error: err.message });
  }
}

/**
 * Ensure time-series collections are created for historical metrics storage.
 * MongoDB will handle auto-creation for regular collections via mongoose models,
 * but time-series collections must be explicitly created with the correct options.
 */
async function ensureTimeSeriesCollections() {
  try {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('MongoDB connection not initialized');
    }

    const tryDrop = async (collectionName) => {
      try {
        await db.command({ drop: collectionName });
      } catch (_) {
        // ignore (NamespaceNotFound, etc.)
      }
    };
    const [metricsInfo] = await db.listCollections({ name: 'metricssnapshots' }).toArray();
    const [bucketsInfo] = await db
      .listCollections({ name: 'system.buckets.metricssnapshots' })
      .toArray();

    const isMetricsTimeSeries =
      metricsInfo &&
      (metricsInfo.type === 'timeseries' ||
        (metricsInfo.options && metricsInfo.options.timeseries));

    // In tests we want a deterministic, queryable time-series collection.
    // We've observed states where the buckets collection exists but the logical
    // collection isn't readable (queries return 0 while buckets fill up).
    // Safest fix for tests: drop and recreate the time-series collection.
    const shouldRepairInTest =
      process.env.NODE_ENV === 'test' &&
      (!metricsInfo || !isMetricsTimeSeries || bucketsInfo);

    if (shouldRepairInTest) {
      // Drop buckets first; it's the authoritative storage for time-series.
      await tryDrop('system.buckets.metricssnapshots');
      await tryDrop('metricssnapshots');
    }

    const [metricsInfoAfter] = await db.listCollections({ name: 'metricssnapshots' }).toArray();
    const isReady =
      metricsInfoAfter &&
      (metricsInfoAfter.type === 'timeseries' ||
        (metricsInfoAfter.options && metricsInfoAfter.options.timeseries));

    if (!isReady) {
      await db.createCollection('metricssnapshots', {
        timeseries: {
          timeField: 'timestamp',
          metaField: 'metadata',
          granularity: 'minutes'
        },
        expireAfterSeconds: 7776000 // 90 days
      });
      logger.info('✓ Created time-series collection: metricssnapshots');
    }
  } catch (err) {
    logger.error('Failed to ensure time-series collections', { error: err.message });
  }
}

module.exports = connectDB;
