const { proposeDraft } = require('../../src/services/pipelineDraftService');
const current = { title: 'Task', spec: 'Preserve the existing constraint.', service: 'rag', priority: 4 };
const proposal = { title: 'A clearer task', spec: 'Preserve the existing constraint.\nVerify the result.', service: 'rag', priority: 4 };
const response = text => ({ ok: true, body: { response: text }, headers: { 'X-Resolved-Model': 'local-model' } });

test('uses configured inference and returns a reviewable proposal with current context intact', async () => {
  const execute = jest.fn().mockResolvedValue(response('```json\n' + JSON.stringify(proposal) + '\n```'));
  const signal = new AbortController().signal;
  const input = { instruction: 'Clarify this task', current, model: 'untrusted', host: 'http://untrusted' };
  expect(await proposeDraft(input, { execute, signal })).toEqual({ draft: proposal, model: 'local-model' });
  const [body, options] = execute.mock.calls[0];
  expect(JSON.parse(body.prompt)).toEqual({ instruction: input.instruction, current });
  expect(body).toMatchObject({ callerDetail: 'pipeline-editor', stream: false, think: false });
  expect(body.model).toBeUndefined(); expect(body.host).toBeUndefined(); expect(body.tools).toBeUndefined();
  expect(options).toEqual({ signal, timeoutMs: 90000 });
  expect(current.spec).toBe('Preserve the existing constraint.');
});

test.each(['broken JSON', '{"title":"Incomplete"}', JSON.stringify({ ...proposal, priority: 99 }), JSON.stringify({ ...proposal, title: '' })])('rejects unusable proposals without changing the input', async text => {
  const execute = jest.fn().mockResolvedValue(response(text));
  await expect(proposeDraft({ instruction: 'Help', current }, { execute })).rejects.toMatchObject({ code: 'INVALID_TASK_PROPOSAL', status: 502 });
  expect(current.title).toBe('Task');
});

test('returns model unavailability and allows cancellation without a proposal', async () => {
  await expect(proposeDraft({ instruction: 'Help', current }, { execute: async () => ({ ok: false, status: 503 }) })).rejects.toMatchObject({ status: 503 });
  const controller = new AbortController();
  const result = await proposeDraft({ instruction: 'Help', current }, { signal: controller.signal, execute: async () => { controller.abort(); return response(JSON.stringify(proposal)); } });
  expect(result).toBeNull();
});

test('oversized context and empty instructions fail before inference', async () => {
  const execute = jest.fn();
  await expect(proposeDraft({ instruction: 'Help', current: { ...current, spec: 'x'.repeat(24001) } }, { execute })).rejects.toMatchObject({ status: 400 });
  await expect(proposeDraft({ instruction: '' }, { execute })).rejects.toMatchObject({ status: 400 });
  expect(execute).not.toHaveBeenCalled();
});
