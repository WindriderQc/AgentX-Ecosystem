const mongoose = require('mongoose');
const prompts = require('/home/agentx/codes/agentx-platform/benchmark/data/benchmark-prompts.json');

(async () => {
  await mongoose.connect('mongodb://192.0.2.33:27017/agentx');
  const list = Array.isArray(prompts) ? prompts : (prompts.prompts || []);
  const byName = new Map(list.map(p => [p.name, p]));
  const R = mongoose.connection.db.collection('benchmarkresults');

  // All prompts flagged in the anomaly screenshot.
  const targets = [
    'No-Solution Detection', 'Compounding Discount', 'Constrained Job Shop Schedule',
    'Cultural Reference Rain Check', 'Raining Cats and Dogs Idiom',
    'Prescription Request to English', 'Polite Window Request',
    'Three Boxes Logic Puzzle', 'Pulling My Leg Idiom', 'Scheduling Constraint Satisfaction'
  ];

  // Chars-per-token heuristic: ~4 for English, ~5-6 for Spanish/French prose.
  const charsPerToken = 4;

  console.log('Prompt'.padEnd(36) + 'exp_tok  model'.padEnd(38) + 'resp_chars  est_tok  trunc?  score');
  console.log('-'.repeat(110));

  for (const name of targets) {
    const p = byName.get(name);
    const expTok = p?.expected_tokens ?? '—';
    const docs = await R.find({ prompt_name: name }).sort({ timestamp: -1 }).limit(8).toArray();
    for (const d of docs) {
      const respLen = (d.response || '').length;
      const estTok = Math.round(respLen / charsPerToken);
      const ends = (d.response || '').slice(-3);
      // Heuristic for truncation: no sentence-ending punct at end AND near 2x expected_tokens budget.
      const noTerminator = !/[.!?\])}"]\s*$/.test((d.response || '').trim());
      const lookLong = typeof expTok === 'number' && estTok >= expTok * 1.8;
      const trunc = (noTerminator && respLen > 50) ? 'YES' : (lookLong ? 'maybe' : '');
      console.log(
        name.padEnd(36)
        + String(expTok).padStart(7)
        + '  ' + (d.model || '').padEnd(33)
        + String(respLen).padStart(10)
        + String(estTok).padStart(9)
        + '   ' + trunc.padEnd(6)
        + '  ' + String(d.quality_score ?? '—')
      );
    }
    console.log('');
  }

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
