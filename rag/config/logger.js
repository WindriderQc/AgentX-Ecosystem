/**
 * RAG service logger — delegates to shared factory.
 * Factory: ./createLogger.js (standardized across all AgentX services)
 */
const path = require('path');
const { createLogger } = require('./createLogger');

module.exports = createLogger(path.join(__dirname, '../logs'));
