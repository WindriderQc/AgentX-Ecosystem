'use strict';

const path = require('path');
const service = require('../../src/services/kidxLexiconService');

const ORIGINAL_PATH = process.env.KIDX_LEXICON_PATH;
const FIXTURE_PATH = path.resolve(__dirname, '..', 'fixtures', 'kidx-lexicon.json');

describe('KidX local lexicon service', () => {
  beforeEach(() => {
    process.env.KIDX_LEXICON_PATH = FIXTURE_PATH;
    service._resetForTests();
  });

  afterAll(() => {
    if (ORIGINAL_PATH === undefined) delete process.env.KIDX_LEXICON_PATH;
    else process.env.KIDX_LEXICON_PATH = ORIGINAL_PATH;
    service._resetForTests();
  });

  test('loads the attributed artifact and performs exact normalized lookup', () => {
    const result = service.lookupExact('Gigantesque');

    expect(result).toEqual(expect.objectContaining({
      status: 'ready',
      hit: true,
      normalized: 'gigantesque',
      entryCount: 1
    }));
    expect(result.entry.glosses[0]).toContain('taille ordinaire');
    expect(result.sources.wiktionary.dumpDate).toBe('2026-07-06');
    expect(result.lookupMs).toBeGreaterThanOrEqual(0);
  });

  test('returns an authoritative miss only when the artifact is ready', () => {
    expect(service.lookupReaderRequest('Ça veut dire quoi flibertinou?')).toEqual(
      expect.objectContaining({ status: 'ready', target: 'flibertinou', hit: false })
    );
  });

  test('builds bounded factual context for the reader model', () => {
    const context = service.buildPromptContext(service.lookupExact('gigantesque'));

    expect(context).toContain('mot exact « gigantesque »');
    expect(context).toContain('Qui dépasse considérablement');
    expect(context).toContain('Utilise uniquement ces sens');
  });

  test('degrades cleanly when no artifact is installed', () => {
    process.env.KIDX_LEXICON_PATH = path.resolve(__dirname, 'missing-kidx-lexicon.json');
    service._resetForTests();

    expect(service.lookupExact('gigantesque')).toEqual(expect.objectContaining({
      status: 'unavailable',
      reason: 'missing',
      hit: false
    }));
  });
});
