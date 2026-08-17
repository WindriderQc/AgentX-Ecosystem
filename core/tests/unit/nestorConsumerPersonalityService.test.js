'use strict';

const fs = require('fs');
const path = require('path');
const {
  getPersonalitySources,
  resolveAgentxNestorRole,
  resolvePersonalityCandidate,
} = require('../../src/services/nestorConsumerPersonalityService');

describe('read-only product personality candidate', () => {
  let readFileSpy;

  beforeEach(() => {
    readFileSpy = jest.spyOn(fs.promises, 'readFile').mockResolvedValue('# Product role');
  });

  afterEach(() => readFileSpy.mockRestore());

  test('discovers only the packaged Agent X role', async () => {
    const result = await getPersonalitySources();
    expect(result.sources).toEqual({
      agentx: expect.objectContaining({ available: true, source: 'agentx' }),
    });
  });

  test('resolves the packaged role with provenance and no write', async () => {
    await expect(resolvePersonalityCandidate({ source: 'agentx' })).resolves.toEqual(
      expect.objectContaining({
        source: 'agentx', ref: 'agentx:roles/Nestor.md', soul: '# Product role',
      })
    );
  });

  test('rejects external personality authorities', async () => {
    await expect(resolvePersonalityCandidate({ source: 'external-runtime' }))
      .rejects.toEqual(expect.objectContaining({ code: 'UNKNOWN_PERSONALITY_SOURCE' }));
  });

  test('resolves the packaged role from the configured product root', () => {
    expect(resolveAgentxNestorRole({ AGENTX_REPO_ROOT: '/workspace/agentx' }))
      .toBe(path.resolve('/workspace/agentx/roles/Nestor.md'));
  });
});
