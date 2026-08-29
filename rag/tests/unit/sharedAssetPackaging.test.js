const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../../app');

const repositoryRoot = path.resolve(__dirname, '..', '..', '..');

describe('RAG shared browser asset packaging', () => {
  test('the RAG image copies the shared typed-confirmation utility', () => {
    const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'docker', 'rag.Dockerfile'), 'utf8');
    expect(dockerfile).toContain(
      'COPY core/public/js/utils/typed-confirmation.js /core/public/js/utils/typed-confirmation.js'
    );
  });

  test('the closed shared-asset allowlist serves typed-confirmation as JavaScript', async () => {
    const response = await request(app)
      .get('/js/utils/typed-confirmation.js')
      .expect(200);

    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.text).toContain('AgentXTypedConfirmation');
  });
});
