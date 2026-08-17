'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { createOllamaHostConfig } = require('../../../shared/ollamaHostConfig');

const CONFIG_FILE_PATH = path.join(__dirname, '..', '..', 'benchmark.config.json');
let dotenvCache = null;

function readDotenv() {
  if (dotenvCache) return dotenvCache;
  try {
    const envPath = path.join(process.cwd(), '.env');
    dotenvCache = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};
  } catch {
    dotenvCache = {};
  }
  return dotenvCache;
}

function readConfigFile() {
  try {
    return fs.existsSync(CONFIG_FILE_PATH)
      ? JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf8'))
      : null;
  } catch {
    return null;
  }
}

function saveConfigFile(config) {
  fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(config, null, 2), 'utf8');
}

const shared = createOllamaHostConfig({
  readDotenv,
  readFallbackHosts: () => readConfigFile()?.hosts || []
});

module.exports = { ...shared, readConfigFile, saveConfigFile };
