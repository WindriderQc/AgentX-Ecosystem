'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { createOllamaHostConfig } = require('../../../shared/ollamaHostConfig');

let dotenvCache = null;

function readDotenv() {
  if (dotenvCache) return dotenvCache;
  if (String(process.env.NODE_ENV || '').trim() === 'test') return {};
  try {
    const envPath = path.join(process.cwd(), '.env');
    dotenvCache = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};
  } catch {
    dotenvCache = {};
  }
  return dotenvCache;
}

module.exports = createOllamaHostConfig({ readDotenv });
