'use strict';
const fs = require('fs');
const path = require('path');

const BYPASS_MARKER_NAME = '.overseer-bypass';

function isBypassed(overseerDir) {
  return fs.existsSync(path.join(overseerDir, BYPASS_MARKER_NAME));
}

module.exports = { isBypassed, BYPASS_MARKER_NAME };
