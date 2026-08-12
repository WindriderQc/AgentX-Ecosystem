'use strict';

const { extractAgentNames } = require('../../routes/operations');

/**
 * Task 0538. The production failure this pins down:
 *
 * `/api/operations/health` reported `openclaw.agentCount: 0` while eight agents
 * were live, because OpenClaw 2026.7.1-2 serves the Control UI (HTML) at
 * `/agents`. The probe got HTTP 200, `JSON.parse` threw, the body was kept as a
 * string, and the extractor found no array in a string — so it returned `[]` and
 * the route rendered a confident zero.
 *
 * The distinction being protected is the same one as task 0529: an unreadable
 * answer is `unknown`, never `0`.
 */
describe('agent list extraction distinguishes empty from unreadable (0538)', () => {
  test('returns null for the HTML Control UI that caused the incident', () => {
    const html = '<!doctype html>\n<html data-openclaw-terminal-enabled="false" lang="en">...';
    expect(extractAgentNames(html)).toBeNull();
  });

  test.each([
    ['a bare string', 'not json'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object with no recognizable list', { status: 'ok', note: 'nothing here' }],
  ])('returns null for %s', (_label, payload) => {
    expect(extractAgentNames(payload)).toBeNull();
  });

  test('returns an empty array when the source genuinely reports no agents', () => {
    // This IS a finding — "OpenClaw has no agents" — and must stay
    // distinguishable from "we could not read the answer".
    expect(extractAgentNames([])).toEqual([]);
    expect(extractAgentNames({ agents: [] })).toEqual([]);
  });

  test('reads the shapes OpenClaw actually returns', () => {
    expect(extractAgentNames([{ id: 'leadx' }, { id: 'overseer' }])).toEqual(['leadx', 'overseer']);
    expect(extractAgentNames({ agents: [{ name: 'main' }] })).toEqual(['main']);
    expect(extractAgentNames({ data: ['clawdx-coder'] })).toEqual(['clawdx-coder']);
    expect(extractAgentNames({ items: [{ slug: 'cloudx' }] })).toEqual(['cloudx']);
    expect(extractAgentNames({ result: [{ title: 'deepsearch' }] })).toEqual(['deepsearch']);
  });

  test('deduplicates and drops unnamed entries without collapsing to unknown', () => {
    const names = extractAgentNames([{ id: 'main' }, { id: 'main' }, {}, { id: 'leadx' }]);
    expect(names).toEqual(['main', 'leadx']);
  });
});
