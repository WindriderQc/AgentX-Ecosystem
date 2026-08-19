'use strict';

const path = require('path');

const LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, http: 3, debug: 4 });
const COLORS = Object.freeze({ error: 'red', warn: 'yellow', info: 'green', http: 'magenta', debug: 'blue' });

function createLogger({ winston, logDir = null, env = process.env } = {}) {
  if (!winston) throw new Error('winston is required');
  winston.addColors(COLORS);

  const nodeEnv = env.NODE_ENV || 'development';
  const isTest = nodeEnv === 'test';
  const level = isTest
    ? (env.TEST_LOG_LEVEL || 'error')
    : (nodeEnv === 'development' ? 'debug' : 'info');
  const jsonFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  );
  const consoleFormat = winston.format.combine(
    winston.format.colorize({ all: true }),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level: logLevel, message, ...meta }) => {
      const details = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
      return `${timestamp} [${logLevel}]: ${message} ${details}`;
    })
  );
  const transports = [new winston.transports.Console({ format: consoleFormat })];
  if (!isTest && logDir) {
    transports.push(
      new winston.transports.File({
        filename: path.join(logDir, 'error.log'),
        level: 'error',
        format: jsonFormat,
        maxsize: 5242880,
        maxFiles: 5
      }),
      new winston.transports.File({
        filename: path.join(logDir, 'combined.log'),
        format: jsonFormat,
        maxsize: 5242880,
        maxFiles: 5
      })
    );
  }
  return winston.createLogger({
    level,
    levels: LEVELS,
    format: jsonFormat,
    transports,
    exitOnError: false
  });
}

module.exports = { COLORS, LEVELS, createLogger };
