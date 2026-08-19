const path = require('path');
const winston = require('winston');
const { createLogger } = require('../../shared/loggerFactory');

module.exports = createLogger({ winston, logDir: path.join(__dirname, '../logs') });
