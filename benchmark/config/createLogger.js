/**
 * Shared logger factory — standardized across all AgentX services.
 * Each service keeps its own copy (no cross-service runtime dependency).
 * See TODO/0065 for consolidation rationale.
 */
const winston = require('winston');
const path = require('path');

const LEVELS = { error: 0, warn: 1, info: 2, http: 3, debug: 4 };
const COLORS = { error: 'red', warn: 'yellow', info: 'green', http: 'magenta', debug: 'blue' };
winston.addColors(COLORS);

function createLogger(logDir) {
  const env = process.env.NODE_ENV || 'development';
  const isTest = env === 'test';
  const level = isTest ? (process.env.TEST_LOG_LEVEL || 'error') : env === 'development' ? 'debug' : 'info';

  const jsonFmt = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  );

  const consoleFmt = winston.format.combine(
    winston.format.colorize({ all: true }),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const m = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
      return `${timestamp} [${level}]: ${message} ${m}`;
    })
  );

  const transports = [new winston.transports.Console({ format: consoleFmt })];
  if (!isTest && logDir) {
    transports.push(
      new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error', format: jsonFmt, maxsize: 5242880, maxFiles: 5 }),
      new winston.transports.File({ filename: path.join(logDir, 'combined.log'), format: jsonFmt, maxsize: 5242880, maxFiles: 5 })
    );
  }

  return winston.createLogger({ level, levels: LEVELS, format: jsonFmt, transports, exitOnError: false });
}

module.exports = { createLogger };
