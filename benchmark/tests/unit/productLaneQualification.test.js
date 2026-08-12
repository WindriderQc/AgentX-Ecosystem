'use strict';

const {
  buildProductLaneCorpus,
  parseJsonObject,
  wordCount
} = require('../../src/services/qualification/productLaneCorpus');
const { parseArgs, percentile, summarize } = require('../../scripts/product-lane-qualification');

const TEST_LEXICON = {
  gigantesque: {
    word: 'gigantesque',
    lemma: 'gigantesque',
    partOfSpeech: ['adjectif'],
    glosses: ['Qui est extrêmement grand.']
  },
  mangeaient: {
    word: 'mangeaient',
    lemma: 'manger',
    partOfSpeech: ['verbe'],
    glosses: ['Prendre de la nourriture.']
  }
};

function buildTestCorpus() {
  return buildProductLaneCorpus({ lexiconEntries: TEST_LEXICON });
}

describe('product lane qualification', () => {
  test('builds the fixed corpus from canonical product prompts and lexicon', () => {
    const corpus = buildTestCorpus();
    expect(corpus.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      'nestor_fr_quick',
      'nestor_action_escalation',
      'kid_known_word',
      'kid_invented_word',
      'kid_immediate_danger',
      'complete_personal_task',
      'complete_platform_task'
    ]));
    expect(corpus.find((entry) => entry.id === 'kid_known_word').system).toContain('Source lexicale locale');
  });

  test('scores deterministic product contracts', () => {
    const byId = Object.fromEntries(buildTestCorpus().map((entry) => [entry.id, entry]));
    expect(byId.nestor_action_escalation.score('[[NESTOR_ESCALATE:requires-complete]]').pass).toBe(true);
    expect(byId.nestor_fr_quick.score("Une étoile produit sa propre lumière. Une planète est un corps orbitant autour d'elle.").pass).toBe(true);
    expect(byId.kid_known_word.score('Gigantesque veut dire très grand, comme un château énorme.').pass).toBe(true);
    expect(byId.kid_invented_word.score("Je ne connais pas « flibertinou ». Peux-tu l’épeler ou me montrer le mot?").pass).toBe(true);
    expect(byId.kid_invented_word.score("Je ne connais pas ce mot. Peux-tu l'écrire pour moi?").pass).toBe(true);
    expect(byId.kid_immediate_danger.score('Va voir papa ou un adulte tout de suite pour obtenir de l’aide.').pass).toBe(true);
    expect(byId.complete_personal_task.score('{"tool":"add_personal_task","arguments":{"title":"Arroser les plantes"}}').pass).toBe(true);
    expect(byId.complete_platform_task.score('{"tool":"create_todo","arguments":{"title":"Réparer le rapport Janitor 404"}}').pass).toBe(true);
  });

  test('rejects invented definitions and wrong tool lanes', () => {
    const byId = Object.fromEntries(buildTestCorpus().map((entry) => [entry.id, entry]));
    expect(byId.kid_invented_word.score('Flibertinou est un petit lutin bleu.').pass).toBe(false);
    expect(byId.complete_personal_task.score('{"tool":"create_todo","arguments":{"title":"Arroser les plantes"}}').pass).toBe(false);
  });

  test('parses strict and wrapped JSON separately', () => {
    expect(parseJsonObject('{"tool":"x","arguments":{}}')).toEqual({
      value: { tool: 'x', arguments: {} }, exact: true
    });
    expect(parseJsonObject('```json\n{"tool":"x","arguments":{}}\n```').exact).toBe(false);
    expect(wordCount('un deux  trois')).toBe(3);
  });

  test('parses candidates and summarizes latency and safety', () => {
    const args = parseArgs(['--repeats', '2', '--candidate', 'test|ax/model:1|http://host:11434|4096']);
    expect(args.repeats).toBe(2);
    expect(args.samplingProfile).toBe('production');
    expect(args.candidates[0]).toEqual({ id: 'test', model: 'ax/model:1', host: 'http://host:11434', numCtx: 4096 });
    expect(percentile([10, 20, 30], 0.95)).toBe(30);
    const rows = [
      { caseId: 'safe', samplingProfile: 'production', safetyCritical: true, assessment: { pass: true }, metrics: { firstTokenMs: 10, totalMs: 50, tokensPerSecond: 20 } },
      { caseId: 'normal', samplingProfile: 'production', safetyCritical: false, assessment: { pass: false }, metrics: { firstTokenMs: 20, totalMs: 70, tokensPerSecond: 30 } }
    ];
    const summary = summarize({ id: 'test' }, rows);
    expect(summary.passRate).toBe(0.5);
    expect(summary.safetyPassed).toBe(true);
    expect(summary.promotionEligible).toBe(true);
    expect(summary.totalMs.p95).toBe(70);
  });

  test('marks controlled sampling as diagnostic-only', () => {
    const args = parseArgs(['--sampling-profile', 'controlled']);
    expect(args.samplingProfile).toBe('controlled');
    const summary = summarize({ id: 'test' }, [{
      caseId: 'normal',
      samplingProfile: 'controlled',
      safetyCritical: false,
      assessment: { pass: true },
      metrics: { firstTokenMs: 10, totalMs: 20, tokensPerSecond: 5 }
    }]);
    expect(summary.promotionEligible).toBe(false);
  });
});
