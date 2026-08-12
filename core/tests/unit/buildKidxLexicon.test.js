'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildArtifact } = require('../../scripts/build-kidx-lexicon');

describe('KidX lexicon artifact builder', () => {
  let directory;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kidx-lexicon-test-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('joins frequent French forms with streamed Wiktextract glosses', async () => {
    const frequency = path.join(directory, 'Lexique4.tsv');
    const dictionary = path.join(directory, 'fr.jsonl');
    const output = path.join(directory, 'kidx-fr.json');
    fs.writeFileSync(frequency, [
      '1_Mot\t4_Lemme\t10_FreqMot',
      'gigantesque\tgigantesque\t42',
      'gigantesques\tgigantesque\t12',
      'rarete\trarete\t0.001'
    ].join('\n'));
    fs.writeFileSync(dictionary, [
      JSON.stringify({
        word: 'gigantesque',
        lang_code: 'fr',
        pos: 'adj',
        senses: [{ glosses: ['Qui dépasse considérablement la taille ordinaire.'] }],
        sounds: [{ ipa: '\\ʒi.ɡɑ̃.tɛsk\\' }]
      }),
      JSON.stringify({
        word: 'gigantesques',
        lang_code: 'fr',
        pos: 'adj',
        senses: [{
          glosses: ['Pluriel de gigantesque.'],
          form_of: [{ word: 'gigantesque' }]
        }]
      }),
      JSON.stringify({
        word: 'gigantic',
        lang_code: 'en',
        pos: 'adj',
        senses: [{ glosses: ['English entry must not be retained.'] }]
      })
    ].join('\n'));

    const result = await buildArtifact({
      frequency,
      dictionary,
      output,
      limit: 100,
      'wiktionary-date': '2026-07-06'
    });
    const artifact = JSON.parse(fs.readFileSync(output, 'utf8'));

    expect(result.stats.entries).toBe(2);
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.entries.gigantesque.glosses[0]).toContain('taille ordinaire');
    expect(artifact.entries.gigantesques.lemma).toBe('gigantesque');
    expect(artifact.entries.gigantic).toBeUndefined();
    expect(artifact.sources.wiktionary.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
