'use strict';

const fs = require('node:fs');
const path = require('node:path');

describe('Models count scope', () => {
  const view = fs.readFileSync(path.resolve(__dirname, '../../views/pages/models.ejs'), 'utf8');
  const experience = fs.readFileSync(path.resolve(__dirname, '../../public/js/models-experience.js'), 'utf8');

  test('labels unique tags, host installs, provider scope, and benchmark evidence separately', () => {
    expect(view).toMatch(/Unique model tags/);
    expect(view).toMatch(/unique active model tags across configured Ollama hosts and custom providers/i);
    expect(view).toMatch(/Host installs are counted separately/);
    expect(view).toMatch(/positive-score evidence/);
    expect(experience).toMatch(/unique model tag/);
  });
});
