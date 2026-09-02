'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { loadRepoTasks } = require('../../../src/services/qualification/repoTaskFixtures');
const {
  buildRepairPrompt,
  extractDiff,
  trimToDiff,
  readTaskContext,
  normalizeResponse,
  evaluateResponseContract,
  runQualification
} = require('../../../src/services/qualification/repoQualificationRunner');

const tasks = loadRepoTasks();
const qualificationCli = require('../../../scripts/repo-coding-qualification');

describe('repoQualificationRunner.readTaskContext / buildRepairPrompt', () => {
  const task = tasks.find((t) => t.id === 'sum-sign');

  test('exposes editable source + public test but NOT the hidden test', () => {
    const ctx = readTaskContext(task);
    expect(ctx.editable.map((f) => f.path)).toEqual(task.fixture.allowedPaths);
    expect(ctx.editable[0].content).toMatch(/function sum/);
    expect(ctx.publicTest.path).toBe('test/public.js');
    // The hidden test file must never leak into the shown context.
    const blob = JSON.stringify(ctx);
    expect(blob).not.toMatch(/hidden/);
  });

  test('prompt names the allowed files and forbids fences/extra files', () => {
    const prompt = buildRepairPrompt(task);
    expect(prompt).toContain('src/sum.js');
    expect(prompt).toMatch(/git apply -p1/);
    expect(prompt).toMatch(/Modify ONLY these files: src\/sum\.js/);
    expect(prompt).toMatch(/no markdown code fences/i);
  });
});

describe('repoQualificationRunner.extractDiff', () => {
  const GOLDEN = tasks.find((t) => t.id === 'sum-sign').solutionDiff;

  test('returns a raw diff unchanged (modulo trailing newline)', () => {
    expect(extractDiff(GOLDEN).trim()).toBe(GOLDEN.trim());
  });

  test('strips a ```diff fenced block with surrounding prose', () => {
    const wrapped = `Sure! Here is the fix:\n\n\`\`\`diff\n${GOLDEN}\`\`\`\n\nLet me know if that helps.`;
    expect(extractDiff(wrapped).trim()).toBe(GOLDEN.trim());
  });

  test('strips a bare ``` fence whose body looks like a diff', () => {
    const wrapped = `\`\`\`\n${GOLDEN}\`\`\``;
    expect(extractDiff(wrapped).trim()).toBe(GOLDEN.trim());
  });

  test('slices from the first marker when there is no fence', () => {
    const wrapped = `Here you go:\n${GOLDEN}\nthanks`;
    expect(extractDiff(wrapped)).toMatch(/^--- a\/src\/sum\.js/);
  });

  test('non-string / empty input yields empty string', () => {
    expect(extractDiff(null)).toBe('');
    expect(extractDiff('')).toBe('');
  });

  test('drops trailing prose after the diff (the "corrupt patch" bug)', () => {
    // A real model reply: correct diff followed by an explanation. Without the
    // trailing-trim, git apply reports "corrupt patch" at the prose line and a
    // correct fix is mis-scored as a format failure.
    const withProse = `${GOLDEN}\nThis fixes the sign bug by using + instead of -.`;
    const out = extractDiff(withProse);
    expect(out.trim()).toBe(GOLDEN.trim());
    expect(out).not.toMatch(/sign bug/);
  });

  test('trimToDiff keeps a multi-file diff intact but strips surrounding prose', () => {
    const twoFile = [
      'Here is the patch:',
      '--- a/src/a.js',
      '+++ b/src/a.js',
      '@@ -1,1 +1,1 @@',
      '-const a = 1;',
      '+const a = 2;',
      '--- a/src/b.js',
      '+++ b/src/b.js',
      '@@ -1,1 +1,1 @@',
      '-const b = 1;',
      '+const b = 2;',
      '',
      'Done!'
    ].join('\n');
    const out = trimToDiff(twoFile);
    expect(out).toMatch(/^--- a\/src\/a\.js/);
    expect(out.trim().endsWith('+const b = 2;')).toBe(true);
    expect(out).not.toMatch(/Here is the patch|Done!/);
  });
});

describe('repoQualificationRunner.evaluateResponseContract (7 model-reply shapes)', () => {
  const GOLDEN = tasks.find((t) => t.id === 'sum-sign').solutionDiff;
  const FENCED = '```diff\n' + GOLDEN + '```';
  const PROSE_AFTER = `${GOLDEN}\nThat should fix the sign bug.`;
  const DIFF_IN_THINKING = GOLDEN; // a full diff, but delivered in the thinking channel

  test('1. normal final response → ok, diff from content', () => {
    const c = evaluateResponseContract({ content: GOLDEN, thinking: '', doneReason: 'stop' });
    expect(c.ok).toBe(true);
    expect(c.violation).toBeNull();
    expect(c.diff.trim()).toBe(GOLDEN.trim());
  });

  test('2. native separated thinking → ok, uses content and IGNORES thinking', () => {
    const c = evaluateResponseContract({ content: GOLDEN, thinking: 'Let me reason about the bug...', doneReason: 'stop' });
    expect(c.ok).toBe(true);
    expect(c.diff.trim()).toBe(GOLDEN.trim());
  });

  test('3. thinking-only response → contract failure (thinking is NOT a diff substitute)', () => {
    const c = evaluateResponseContract({ content: '', thinking: DIFF_IN_THINKING, doneReason: 'stop' });
    expect(c.ok).toBe(false);
    expect(c.violation).toBe('thinking_only');
    expect(c.diff).toBeNull();
  });

  test('4. empty output → contract failure (empty_response)', () => {
    const c = evaluateResponseContract({ content: '', thinking: '', doneReason: 'stop' });
    expect(c.ok).toBe(false);
    expect(c.violation).toBe('empty_response');
  });

  test('5. truncated response (done_reason length, no final) → truncated_no_final', () => {
    const c = evaluateResponseContract({ content: '', thinking: 'partial reasoning cut off', doneReason: 'length' });
    expect(c.ok).toBe(false);
    expect(c.violation).toBe('truncated_no_final');
  });

  test('6. diff inside a fence → ok', () => {
    const c = evaluateResponseContract({ content: FENCED, thinking: '', doneReason: 'stop' });
    expect(c.ok).toBe(true);
    expect(c.diff.trim()).toBe(GOLDEN.trim());
  });

  test('7. prose after the diff → ok, trailing prose trimmed', () => {
    const c = evaluateResponseContract({ content: PROSE_AFTER, thinking: '', doneReason: 'stop' });
    expect(c.ok).toBe(true);
    expect(c.diff.trim()).toBe(GOLDEN.trim());
    expect(c.diff).not.toMatch(/sign bug/);
  });

  test('final answer that is prose with no diff → no_diff_in_final (not salvaged from thinking)', () => {
    const c = evaluateResponseContract({ content: 'I think you should change the operator.', thinking: DIFF_IN_THINKING, doneReason: 'stop' });
    expect(c.ok).toBe(false);
    expect(c.violation).toBe('no_diff_in_final');
    expect(c.diff).toBeNull();
  });

  test('normalizeResponse accepts a bare string as the final answer', () => {
    expect(normalizeResponse('hi')).toEqual({ content: 'hi', thinking: '', doneReason: null, metrics: null });
    expect(normalizeResponse(null)).toEqual({ content: '', thinking: '', doneReason: null, metrics: null });
  });
});

describe('repoQualificationRunner contract end-to-end (never grade thinking as a diff)', () => {
  const sumSign = tasks.find((t) => t.id === 'sum-sign');
  const run = (reply, params) => runQualification({
    tasks: [sumSign], models: ['m'], attempts: 1, dryRun: false,
    mode: 'final_only', params: params || { numPredict: 4096, numCtx: 8192, temperature: 0.2, think: false },
    callModel: async () => reply
  });

  test('a correct final diff passes and records mode + params', async () => {
    const r = await run({ content: sumSign.solutionDiff, thinking: 'reasoning', doneReason: 'stop' });
    const rec = r.records[0];
    expect(rec.grade.pass).toBe(true);
    expect(rec.contract).toEqual({ ok: true, violation: null, rankable: true });
    expect(rec.mode).toBe('final_only');
    expect(rec.params.numPredict).toBe(4096);
    expect(rec.thinkingChars).toBeGreaterThan(0);
  });

  test('thinking-only reply is a contract failure and NO test is run on the thinking diff', async () => {
    const r = await run({ content: '', thinking: sumSign.solutionDiff, doneReason: 'stop' });
    const rec = r.records[0];
    expect(rec.grade.pass).toBe(false);
    expect(rec.grade.applied).toBe(false); // the golden diff hidden in thinking was never applied
    expect(rec.grade.reason).toBe('contract_violation: thinking_only');
    expect(r.outcomes.m['contract:thinking_only']).toBe(1);
    expect(r.perModel[0]).toMatchObject({
      rankable: false,
      rankingStatus: 'unrankable_contract',
      unrankableSamples: 1,
      passAtK: null
    });
    expect(r.perTask[sumSign.id][0]).toMatchObject({ rankable: false, unrankableSamples: 1, passAtK: null });
  });

  test('truncated reply is classified as truncated_no_final', async () => {
    const r = await run({ content: '', thinking: 'cut off', doneReason: 'length' });
    expect(r.records[0].grade.reason).toBe('contract_violation: truncated_no_final');
    expect(r.perModel[0].rankable).toBe(false);
  });

  test('visible final prose with no diff is a rankable executable-format failure', async () => {
    const r = await run({ content: 'I cannot provide a patch.', thinking: sumSign.solutionDiff, doneReason: 'stop' });
    expect(r.records[0].contract).toEqual({ ok: false, violation: 'no_diff_in_final', rankable: true });
    expect(r.perModel[0]).toMatchObject({ rankable: true, observedPassRate: 0 });
    expect(r.perModel[0].passAtK['pass@1']).toBe(0);
  });
});

describe('repoQualificationRunner.runQualification (offline dry-run)', () => {
  test('grading every golden diff over all fixtures yields pass@1 = 1.0', async () => {
    const models = ['golden-a', 'golden-b'];
    const emitted = [];
    const result = await runQualification({
      tasks,
      models,
      attempts: 3,
      dryRun: true,
      onRecord: (rec) => emitted.push(rec)
    });

    // 2 models x 13 tasks x 3 attempts.
    expect(result.records).toHaveLength(2 * 13 * 3);
    expect(emitted).toHaveLength(result.records.length);
    expect(result.records.every((r) => r.grade.pass)).toBe(true);
    expect(result.records.every((r) => r.dryRun === true)).toBe(true);

    for (const row of result.perModel) {
      expect(row.passAtK['pass@1']).toBe(1);
      expect(row.passAtK['pass@3']).toBe(1);
      expect(row.observedPassRate).toBe(1);
    }
    // Per-task report also holds pass@1 = 1.0 for each model.
    for (const taskId of result.meta.tasks) {
      for (const row of result.perTask[taskId]) {
        expect(row.passAtK['pass@1']).toBe(1);
      }
    }
  });

  test('dry-run needs no callModel and every record is valid JSONL', async () => {
    const result = await runQualification({
      tasks,
      models: ['golden'],
      attempts: 1,
      dryRun: true
    });
    const { toJsonlLine } = require('../../../src/services/qualification/executableRepoGrader');
    for (const rec of result.records) {
      const line = toJsonlLine(rec);
      const parsed = JSON.parse(line);
      expect(parsed.grade.pass).toBe(true);
      expect(parsed.task).toBeTruthy();
      expect(parsed.model).toBe('golden');
    }
  });

  test('a failing (non-applying) model response is graded fail, not a crash', async () => {
    const result = await runQualification({
      tasks: [tasks[0]],
      models: ['flaky'],
      attempts: 1,
      dryRun: false,
      callModel: async () => 'no diff here, just prose'
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].grade.pass).toBe(false);
  });

  test('records deterministic seeds, task provenance, model provenance, and one drift guard per model', async () => {
    const beforeModel = jest.fn(async () => {});
    const result = await runQualification({
      tasks: [tasks[0]],
      models: ['a', 'b'],
      attempts: 2,
      dryRun: false,
      attemptSeeds: [101, 202],
      beforeModel,
      modelProvenance: (model) => ({ model, artifactDigest: `${model}-digest` }),
      callModel: async ({ task, seed }) => ({
        content: task.solutionDiff,
        doneReason: 'stop',
        metrics: { latencyMs: seed }
      })
    });

    expect(beforeModel).toHaveBeenCalledTimes(2);
    expect(result.records.map((record) => record.seed)).toEqual([101, 202, 101, 202]);
    expect(result.records[0]).toMatchObject({
      taskProvenance: {
        id: tasks[0].id,
        category: tasks[0].category,
        fixtureFingerprint: tasks[0].fixtureFingerprint
      },
      inferenceContract: { model: 'a', artifactDigest: 'a-digest' },
      modelCall: { latencyMs: 101 }
    });
    expect(result.records[0].promptFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test('macro-averages pass@k per task instead of pooling heterogeneous problems', async () => {
    const selected = tasks.slice(0, 2);
    const result = await runQualification({
      tasks: selected,
      models: ['candidate'],
      attempts: 3,
      dryRun: false,
      ks: [1, 3],
      callModel: async ({ task }) => task.id === selected[0].id ? task.solutionDiff : 'no patch'
    });
    expect(result.perModel[0]).toMatchObject({
      correct: 3,
      samples: 6,
      tasksPassedAtLeastOnce: 1,
      zeroPassTasks: [selected[1].id],
      passAtK: { 'pass@1': 0.5, 'pass@3': 0.5 }
    });
  });
});

describe('repo-coding-qualification.js CLI (--dry-run smoke test)', () => {
  test('the canonical Benchmark image packages the runner and its offline dependencies', () => {
    const dockerfilePath = path.resolve(__dirname, '..', '..', '..', '..', 'docker', 'benchmark.Dockerfile');
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
    expect(dockerfile).toContain('apt-get install -y --no-install-recommends ca-certificates git');
    expect(dockerfile).toContain('COPY scripts/bounded-response.js /scripts/bounded-response.js');
    expect(dockerfile).toContain("! -name 'repo-coding-qualification.js'");
  });

  test('bounds the live Core claim response and rejects redirects', async () => {
    const payload = Buffer.from(JSON.stringify({ data: { claims: [] } }));
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(payload.byteLength) },
      body: {
        async *[Symbol.asyncIterator]() {
          yield payload;
        }
      }
    }));

    await expect(qualificationCli.requestJson('http://core:3080/claims', fetchImpl))
      .resolves.toEqual({ data: { claims: [] } });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://core:3080/claims',
      expect.objectContaining({
        redirect: 'manual',
        signal: expect.any(AbortSignal)
      })
    );

    fetchImpl.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => String(qualificationCli.MAX_CORE_CLAIM_RESPONSE_BYTES + 1) },
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('{}');
        }
      }
    });
    await expect(qualificationCli.requestJson('http://core:3080/claims', fetchImpl))
      .rejects.toThrow(/Response body exceeded its byte limit/);
  });

  test('live defaults are the frozen 8K/4K five-seed matrix and require a claim id', () => {
    expect(() => qualificationCli.parseArgs([])).toThrow(/claim-id is required/);
    const args = qualificationCli.parseArgs([
      '--claim-id', 'coding-campaign',
      '--host', 'http://ollama:11434',
      '--core', 'http://core:3080',
      '--models', 'candidate'
    ]);
    expect(args).toMatchObject({
      attempts: 5,
      numCtx: 8192,
      numPredict: 4096,
      responseMode: 'final_only',
      seeds: [101, 202, 303, 404, 505]
    });
  });

  test('refuses live execution when the exact host claim is absent', async () => {
    const requestJson = jest.fn(async () => ({
      data: { claims: [{ hostUrl: 'http://exec:11434', batchId: 'other' }] }
    }));
    await expect(qualificationCli.assertExpectedActiveClaim({
      core: 'http://core:3080',
      host: 'http://exec:11434',
      claimId: 'expected'
    }, { requestJson })).rejects.toThrow(/requires active claim expected/);
    expect(requestJson).toHaveBeenCalledWith(
      'http://core:3080/api/nerve-center/host-preferences/benchmark-claims/active'
    );
  });

  test('rejects a Core contract that changes any frozen campaign setting', () => {
    const args = qualificationCli.parseArgs([
      '--claim-id', 'coding-campaign',
      '--host', 'http://ollama:11434',
      '--core', 'http://core:3080',
      '--models', 'candidate'
    ]);
    const exact = {
      num_ctx: 8192,
      response_max_tokens: 4096,
      temperature: 0.2,
      top_p: 0.95,
      top_k: 40,
      repeat_penalty: 1.1,
      think_mode: 'final_only',
      think: false,
      send_think: true
    };
    expect(qualificationCli.assertExactFrozenSettings(exact, args, 'm')).toBe(exact);
    expect(() => qualificationCli.assertExactFrozenSettings({ ...exact, num_ctx: 16384 }, args, 'm'))
      .toThrow(/num_ctx: expected 8192, got 16384/);
  });

  test('writes valid runs.jsonl + summary.json with pass@1 = 1.0', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-qual-cli-'));
    const script = path.join(__dirname, '..', '..', '..', 'scripts', 'repo-coding-qualification.js');
    const res = spawnSync(
      process.execPath,
      [script, '--dry-run', '--models', 'golden', '--attempts', '1', '--tasks', 'sum-sign,max-pick', '--out', outDir],
      { encoding: 'utf8', timeout: 60_000 }
    );
    expect(res.status).toBe(0);

    const lines = fs.readFileSync(path.join(outDir, 'runs.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2); // 1 model x 2 tasks x 1 attempt
    for (const line of lines) {
      expect(JSON.parse(line).grade.pass).toBe(true);
    }

    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
    expect(summary.mode).toBe('dry-run');
    const golden = summary.perModel.find((r) => r.model === 'golden');
    expect(golden.passAtK['pass@1']).toBe(1);

    fs.rmSync(outDir, { recursive: true, force: true });
  });
});
