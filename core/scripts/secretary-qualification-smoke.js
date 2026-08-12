#!/usr/bin/env node
/**
 * Production qualification for Nestor's secretary list/complete behavior.
 *
 * The smoke creates self-cleaning personal canaries through the secretary API,
 * then asks the product-facing Nestor Auto lane to:
 *   1. list a canary title that exists only in the personal-task tool result;
 *   2. complete one exact personal task;
 *   3. refuse an ambiguous completion while leaving both candidates open.
 *
 * Pair this with nestor-toolcall-smoke.js, which independently proves that an
 * ordinary Nestor request selects add_personal_task instead of create_todo.
 *
 * Usage:
 *   node core/scripts/secretary-qualification-smoke.js --base http://192.0.2.99:3080
 *   node core/scripts/secretary-qualification-smoke.js --json
 *   node core/scripts/secretary-qualification-smoke.js --keep
 */

const BASE = argValue('--base') || process.env.AGENTX_CORE_URL || 'http://127.0.0.1:3080';
const DEADLINE_S = Math.max(30, Number(argValue('--deadline') || 120));
const JSON_OUT = process.argv.includes('--json');
const KEEP = process.argv.includes('--keep');
const CALLER = 'secretary-qualification-smoke';
const POLL_MS = 3000;

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function api(method, path, body, timeoutMs = (DEADLINE_S + 15) * 1000) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-service-caller': CALLER
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const payload = await response.json().catch(() => null);
  return { httpStatus: response.status, payload };
}

function dataOf(result) {
  if (result?.payload?.ok === true || result?.payload?.status === 'success') {
    return result.payload.data;
  }
  return null;
}

function requireData(result, label) {
  const data = dataOf(result);
  if (!data) {
    const message = result?.payload?.message || 'unexpected response';
    throw new Error(`${label} failed (HTTP ${result?.httpStatus}): ${message}`);
  }
  return data;
}

async function listTasks(includeDone = false) {
  const suffix = includeDone ? '?includeDone=true&limit=100' : '?limit=100';
  return requireData(await api('GET', `/api/secretary/tasks${suffix}`), 'secretary list');
}

async function createCanary(title, note) {
  const data = requireData(await api('POST', '/api/secretary/tasks', {
    title,
    note,
    priority: 3,
    source: CALLER
  }), `create ${title}`);
  return data.task;
}

async function completeCanary(id, note = 'Secretary qualification cleanup.') {
  return api('POST', '/api/secretary/tasks/complete', {
    ref: id,
    by: CALLER,
    note
  });
}

async function nestorTurn(text) {
  const data = requireData(await api('POST', '/api/nestor/turn', {
    text,
    lane: 'auto',
    surface: 'secretary-qualification',
    timeoutMs: DEADLINE_S * 1000
  }), 'Nestor turn');
  return {
    reply: String(data.reply || ''),
    lane: data.lane,
    route: data.laneSelection?.requestedLane === 'auto'
      ? `auto→${data.lane} (${data.laneSelection.reason || 'policy'})`
      : data.lane || 'unknown'
  };
}

async function pollTask(id, predicate) {
  const deadline = Date.now() + DEADLINE_S * 1000;
  while (Date.now() < deadline) {
    const task = (await listTasks(true)).tasks.find((candidate) => candidate.id === id);
    if (task && predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return null;
}

function emit(result) {
  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write([
    `secretary-qualification-smoke: ${result.verdict}`,
    `  base:       ${BASE}`,
    `  list:       ${result.list}`,
    `  complete:   ${result.complete}`,
    `  ambiguity:  ${result.ambiguity}`,
    `  cleanup:    ${result.cleanup}`,
    `  elapsed:    ${result.elapsedMs} ms`
  ].join('\n') + '\n');
}

async function main() {
  const startedAt = Date.now();
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const nonce = Math.random().toString(36).slice(2, 10);
  const exactTitle = `secretary qualification ${timestamp} ${nonce}`;
  const ambiguousStem = `secretary ambiguity ${timestamp} ${nonce}`;
  const created = [];
  const result = {
    verdict: 'ERROR',
    list: 'not run',
    complete: 'not run',
    ambiguity: 'not run',
    cleanup: 'not run',
    elapsedMs: 0
  };

  try {
    await listTasks();
    const exact = await createCanary(exactTitle, 'Self-cleaning secretary qualification canary.');
    created.push(exact);

    const listTurn = await nestorTurn(
      'Quelles sont les tâches sur ma liste personnelle en ce moment ? ' +
      'Donne le titre et l’identifiant de chacune.'
    );
    if (!listTurn.reply.toLowerCase().includes(exactTitle.toLowerCase())) {
      throw new Error(`list_personal_tasks canary missing from reply (${listTurn.route}): ${listTurn.reply}`);
    }
    result.list = `PASS ${exact.id}; ${listTurn.route}; unseen canary title returned`;

    const completeTurn = await nestorTurn(
      `Dans ma liste personnelle, marque exactement « ${exactTitle} » comme terminée. Ne crée rien.`
    );
    const completed = await pollTask(exact.id, (task) => task.status === 'done');
    if (!completed) {
      throw new Error(`complete_personal_task produced no completed side effect (${completeTurn.route})`);
    }
    result.complete = `PASS ${exact.id}; ${completeTurn.route}; status=done`;

    const alpha = await createCanary(`${ambiguousStem} alpha`, 'ambiguity proof alpha');
    const beta = await createCanary(`${ambiguousStem} beta`, 'ambiguity proof beta');
    created.push(alpha, beta);
    const ambiguityTurn = await nestorTurn(
      `Dans ma liste personnelle, marque « ${ambiguousStem} » comme terminée.`
    );
    const openAfter = await listTasks();
    const alphaOpen = openAfter.tasks.some((task) => task.id === alpha.id);
    const betaOpen = openAfter.tasks.some((task) => task.id === beta.id);
    const replyShowsDisambiguation = [alpha.id, beta.id].some((id) => ambiguityTurn.reply.includes(id))
      || /lequel|laquelle|pr[ée]cis|deux|ambigu/i.test(ambiguityTurn.reply);
    if (!alphaOpen || !betaOpen || !replyShowsDisambiguation) {
      throw new Error(
        `ambiguous completion was not fail-closed: alphaOpen=${alphaOpen} betaOpen=${betaOpen} ` +
        `reply=${ambiguityTurn.reply}`
      );
    }
    result.ambiguity = `PASS ${alpha.id}/${beta.id}; both open; clarification requested`;
    result.verdict = 'PASS';
  } catch (error) {
    result.verdict = 'FAIL';
    if (result.list === 'not run') result.list = `FAIL ${error.message}`;
    else if (result.complete === 'not run') result.complete = `FAIL ${error.message}`;
    else result.ambiguity = `FAIL ${error.message}`;
  } finally {
    if (KEEP) {
      result.cleanup = `kept ${created.map((task) => task.id).join(', ') || 'no canaries'} (--keep)`;
    } else {
      const outcomes = [];
      for (const task of created) {
        const cleanup = await completeCanary(task.id).catch((error) => ({ error }));
        outcomes.push(dataOf(cleanup) ? `${task.id}:done` : `${task.id}:FAILED`);
      }
      result.cleanup = outcomes.join(', ') || 'no canaries';
    }
    result.elapsedMs = Date.now() - startedAt;
  }

  emit(result);
  process.exit(result.verdict === 'PASS' ? 0 : 1);
}

main().catch((error) => {
  emit({
    verdict: 'ERROR',
    list: 'failed',
    complete: 'failed',
    ambiguity: error.message,
    cleanup: 'best effort attempted; inspect secretary list',
    elapsedMs: 0
  });
  process.exit(2);
});
