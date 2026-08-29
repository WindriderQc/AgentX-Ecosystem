const request = require('supertest');
const { app } = require('../../src/app');

describe('Prompts product surface', () => {
  test('renders a self-contained prompt library with explicit states and native editing', async () => {
    const response = await request(app)
      .get('/prompts')
      .expect(200)
      .expect('Content-Type', /html/);

    expect(response.text).toContain('Persona Library');
    expect(response.text).toContain('id="loadingState"');
    expect(response.text).toContain('id="emptyState"');
    expect(response.text).toContain('id="errorState"');
    expect(response.text).toContain('<textarea id="systemPromptInput"');
    expect(response.text).toContain('<script src="/js/prompts-page.js" defer></script>');
    expect(response.text).not.toMatch(/monaco-editor|chart\.umd/i);
  });

  test('serves the local page controller as JavaScript', async () => {
    const response = await request(app)
      .get('/js/prompts-page.js')
      .expect(200)
      .expect('Content-Type', /javascript/);

    expect(response.text).toContain("requestJson(fetchImpl, '/api/prompts'");
    expect(response.text).toContain('createPromptPage');
  });
});
