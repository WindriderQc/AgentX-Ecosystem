'use strict';

const CONTRACT_NAME = 'agentx.nestor.consumer';
const CONTRACT_VERSION = '1.2.0';
const CONTRACT_BASE_PATH = '/api/consumers/nestor/v1';

const OPERATION_TASK_TYPES = Object.freeze({
  chat: 'buddy_chat',
  react: 'buddy_reaction',
  analyze: 'analysis',
});

const MEMORY_SOURCES = Object.freeze(['agentx', 'rag']);

const LIMITS = Object.freeze({
  messageCount: 50,
  messageCharacters: 8000,
  totalMessageCharacters: 32000,
  inferenceTimeoutMs: 125000,
  streamLineCharacters: 262144,
  memoryQueryCharacters: 2000,
  memoryResultsPerSource: 20,
  metricsHours: 720,
  metricsRows: 10000,
});

class NestorConsumerError extends Error {
  constructor(message, statusCode = 400, code = 'NESTOR_CONSUMER_INVALID_REQUEST', details = null) {
    super(message);
    this.name = 'NestorConsumerError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

module.exports = {
  CONTRACT_NAME,
  CONTRACT_VERSION,
  CONTRACT_BASE_PATH,
  OPERATION_TASK_TYPES,
  MEMORY_SOURCES,
  LIMITS,
  NestorConsumerError,
};
