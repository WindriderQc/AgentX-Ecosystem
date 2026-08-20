const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');

describe('Playground optional controls', () => {
  test('hydrates the optional TTS toggle only when the rendered page provides it', () => {
    const config = fs.readFileSync(path.join(root, 'public/js/chat/chat-config.js'), 'utf8');
    const chatView = fs.readFileSync(path.join(root, 'views/pages/chat.ejs'), 'utf8');

    expect(chatView).not.toContain('id="ttsToggle"');
    expect(config).toContain('if (elements.ttsToggle) {');
    expect(config).toMatch(/if \(elements\.ttsToggle\) \{\s*elements\.ttsToggle\.checked/);
  });
});
