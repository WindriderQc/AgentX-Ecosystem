'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');
const configSource = fs.readFileSync(path.join(root, 'public/js/chat/chat-config.js'), 'utf8');
const messagingSource = fs.readFileSync(path.join(root, 'public/js/chat/chat-messaging.js'), 'utf8');
const viewSource = fs.readFileSync(path.join(root, 'views/pages/chat.ejs'), 'utf8');

describe('Playground routing modes', () => {
  test('keeps Quick and Deep fixed while Standard activates per-turn classification', () => {
    expect(configSource).toContain("quick: 'quick_chat'");
    expect(configSource).toContain("deep: 'deep_reasoning'");
    expect(configSource).not.toContain("standard: 'general_chat'");
    expect(configSource).toContain("return routingMode(elements, state) === 'standard'");
    expect(messagingSource).toContain('autoRoute: isAutoRoutingMode(elements, state)');
  });

  test('explains the classifier boundary to the operator', () => {
    expect(viewSource).toContain('Standard classifies each turn; Quick and Deep use fixed lanes.');
    expect(configSource).toContain('The classifier picks an eligible model for each turn.');
  });
});
