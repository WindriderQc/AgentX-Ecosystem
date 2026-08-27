'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const root = path.resolve(__dirname, '../..');
const demoViewPath = path.join(root, 'views/pages/demo.ejs');
const profileScriptPath = path.join(root, 'public/js/chat/chat-profile.js');
const selectorScriptPath = path.join(root, 'public/js/persona-selector.js');
const mainScriptPath = path.join(root, 'public/js/chat/chat-main.js');

describe('guided persona demo', () => {
  test('presents personas as a first-class, secret-free product primitive', async () => {
    const html = await ejs.renderFile(demoViewPath, {
      publicUrls: {
        rag: 'http://rag.example',
        benchmark: 'http://benchmark.example'
      }
    });

    expect(html).toContain('What do you want to do?');
    expect(html).toContain('Try a guided conversation');
    expect(html).toContain('href="/playground?persona=learning_guide"');
    expect(html).not.toMatch(/openclaw|herm[eè]s|nestor|192\.168\.|credential|token/i);
  });

  test('honors only API-known persona deep links in both Playground selectors', () => {
    const profileSource = fs.readFileSync(profileScriptPath, 'utf8');
    const selectorSource = fs.readFileSync(selectorScriptPath, 'utf8');
    const mainSource = fs.readFileSync(mainScriptPath, 'utf8');

    for (const source of [profileSource, selectorSource]) {
      expect(source).toContain("new URLSearchParams(window.location.search).get('persona')");
    }
    expect(profileSource).toContain('Array.from(promptSelect.options)');
    expect(profileSource).toContain('await loadActivePrompt(promptSelect.value)');
    expect(profileSource).toContain("promptSelect.addEventListener('change'");
    expect(selectorSource).toContain('personas.find(persona => persona.name ===');
    expect(selectorSource).toContain('Ignoring unknown requested persona');
    expect(mainSource).toContain('await loadPromptSelector();');
    expect(mainSource).not.toContain('loadActivePrompt();');
  });
});
