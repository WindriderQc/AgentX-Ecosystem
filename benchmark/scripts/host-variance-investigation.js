require('dotenv').config({ path: '/home/agentx/codes/agentx-platform/benchmark/.env' });
const mongoose = require('mongoose');
const BR = require('/home/agentx/codes/agentx-platform/benchmark/models/BenchmarkResult');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://192.0.2.33:27017/agentx');
  const model = 'qwen2.5:7b-instruct-q5_K_M';
  const FRANK = 'http://192.0.2.99:11434';
  const BRUTAL = 'http://192.0.2.12:11434';

  console.log('\n== Execution settings / truncation / baselines ==');
  for (const host of [FRANK, BRUTAL]) {
    const rows = await BR.aggregate([
      { $match: { model, host, success: true } },
      { $group: {
          _id: null,
          n: { $sum: 1 },
          numCtx: { $addToSet: '$performance_baseline.numCtx' },
          numCtxSrc: { $addToSet: '$performance_baseline.numCtxSource' },
          numPredict: { $addToSet: '$execution_settings.num_predict' },
          truncN: { $sum: { $cond: ['$truncation.response_truncated', 1, 0] } },
          doneReasons: { $addToSet: '$truncation.done_reason' },
          avgRespTokens: { $avg: '$truncation.response_tokens' },
          avgLimit: { $avg: '$truncation.response_limit' },
          backends: { $addToSet: '$hardware_snapshot.backend' },
          quants: { $addToSet: '$hardware_snapshot.quantization' },
          vram: { $avg: '$hardware_snapshot.vram_usage_mb' }
      } }
    ]);
    console.log(host, JSON.stringify(rows[0], null, 2));
  }

  console.log('\n== Reasoning paired prompts ==');
  const rows = await BR.aggregate([
    { $match: { model, success: true, host: { $in: [FRANK, BRUTAL] }, prompt_category: 'reasoning', quality_score: { $ne: null } } },
    { $group: { _id: { p: '$prompt_name', host: '$host' }, q: { $avg: '$quality_score' }, t: { $avg: '$tokens' }, judges: { $addToSet: '$judge_host' }, n: { $sum: 1 } } },
    { $group: { _id: '$_id.p', r: { $push: { host: '$_id.host', q: '$q', t: '$t', judges: '$judges', n: '$n' } } } },
    { $match: { 'r.1': { $exists: true } } }
  ]);
  for (const r of rows) {
    const f = r.r.find(x => x.host === FRANK);
    const b = r.r.find(x => x.host === BRUTAL);
    if (!f || !b) continue;
    console.log(`${(r._id||'').padEnd(34)} frank=${f.q.toFixed(1)}/${Math.round(f.t)}t  brutal=${b.q.toFixed(1)}/${Math.round(b.t)}t  diff=${(f.q - b.q).toFixed(2)}  brutalJudges=${b.judges.join(',')}`);
  }

  console.log('\n== Coding paired prompts ==');
  const rows2 = await BR.aggregate([
    { $match: { model, success: true, host: { $in: [FRANK, BRUTAL] }, prompt_category: 'coding', quality_score: { $ne: null } } },
    { $group: { _id: { p: '$prompt_name', host: '$host' }, q: { $avg: '$quality_score' }, t: { $avg: '$tokens' }, judges: { $addToSet: '$judge_host' }, n: { $sum: 1 } } },
    { $group: { _id: '$_id.p', r: { $push: { host: '$_id.host', q: '$q', t: '$t', judges: '$judges', n: '$n' } } } },
    { $match: { 'r.1': { $exists: true } } }
  ]);
  for (const r of rows2) {
    const f = r.r.find(x => x.host === FRANK);
    const b = r.r.find(x => x.host === BRUTAL);
    if (!f || !b) continue;
    console.log(`${(r._id||'').padEnd(34)} frank=${f.q.toFixed(1)}/${Math.round(f.t)}t  brutal=${b.q.toFixed(1)}/${Math.round(b.t)}t  diff=${(f.q - b.q).toFixed(2)}  brutalJudges=${b.judges.join(',')}`);
  }

  console.log('\n== Picking one paired reasoning prompt to diff raw responses ==');
  // Find a prompt with both hosts
  const paired = await BR.aggregate([
    { $match: { model, success: true, host: { $in: [FRANK, BRUTAL] }, prompt_category: 'reasoning' } },
    { $group: { _id: '$prompt_name', hosts: { $addToSet: '$host' } } },
    { $match: { 'hosts.1': { $exists: true } } },
    { $limit: 3 }
  ]);
  for (const pr of paired) {
    console.log(`\n### Prompt: ${pr._id}`);
    for (const host of [FRANK, BRUTAL]) {
      const s = await BR.findOne({ model, host, prompt_name: pr._id, success: true })
        .sort({ createdAt: -1 })
        .select('response tokens quality_score quality_explanation judge_host execution_settings performance_baseline truncation.done_reason')
        .lean();
      if (!s) continue;
      console.log(`--- ${host} q=${s.quality_score} tokens=${s.tokens} judge=${s.judge_host} numCtx=${s.performance_baseline?.numCtx} numPredict=${s.execution_settings?.num_predict} doneReason=${s.truncation?.done_reason}`);
      console.log('RESPONSE:', (s.response || '').slice(0, 500));
      console.log('EXPL:', (s.quality_explanation || '').slice(0, 200));
    }
  }

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
