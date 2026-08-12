'use strict';
const crypto = require('crypto');

function hashTodoContent(content) {
  const normalised = String(content).replace(/\r\n/g, '\n');
  const digest = crypto.createHash('sha256').update(normalised).digest('hex');
  return `sha256:${digest}`;
}

module.exports = { hashTodoContent };
