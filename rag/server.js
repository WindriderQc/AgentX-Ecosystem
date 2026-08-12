const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const connectDB = require('./config/db');
const logger = require('./config/logger');

const PORT = process.env.PORT || 3082;
const HOST = process.env.HOST || '::';

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection', {
    reason: reason?.message || reason,
    stack: reason?.stack
  });
});

process.on('uncaughtException', (error) => {
  if (error.code === 'EPIPE' || error.code === 'ECONNRESET') {
    logger.debug(`${error.code} ignored (closed connection)`);
    return;
  }
  logger.error('Uncaught Exception', { message: error.message, stack: error.stack });
  setTimeout(() => process.exit(1), 1000);
});

process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

const mongoose = require('mongoose');
const { resetEmbeddingsService } = require('./src/services/embeddings');
const { resetRagStore } = require('./src/services/ragStore');
const app = require('./app');

let server = null;

async function gracefulShutdown(signal) {
  logger.info(`${signal} received — starting graceful shutdown`);

  const forceTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out after 5s — forcing exit');
    process.exit(1);
  }, 5000);

  try {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      logger.info('HTTP server closed');
    }

    await mongoose.connection.close();
    logger.info('MongoDB connection closed');

    resetEmbeddingsService();
    resetRagStore();
    logger.info('Services reset — shutdown complete');

    clearTimeout(forceTimer);
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown', { error: err.message });
    clearTimeout(forceTimer);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function start() {
  await connectDB();
  server = app.listen(PORT, HOST, () => {
    logger.info(`agentx-rag listening on ${HOST}:${PORT}`);
  });
}

if (require.main === module) {
  start().catch(err => {
    logger.error('Failed to start', { error: err.message });
    process.exit(1);
  });
}
