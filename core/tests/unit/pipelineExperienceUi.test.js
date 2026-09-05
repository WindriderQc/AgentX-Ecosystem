'use strict';

const fs = require('node:fs');
const path = require('node:path');

describe('Pipeline open-work experience', () => {
  const view = fs.readFileSync(path.resolve(__dirname, '../../views/pages/pipeline.ejs'), 'utf8');
  const script = fs.readFileSync(path.resolve(__dirname, '../../public/js/pipeline.js'), 'utf8');

  test('offers visible service, lane, and status-card filters', () => {
    for (const id of ['pipelineServiceFilter', 'pipelineLaneFilter']) {
      expect(view).toContain(`id="${id}"`);
    }
    for (const status of ['queued', 'in_progress', 'review', 'blocked', 'done']) {
      expect(view).toContain(`data-status-filter="${status}"`);
    }
    expect(script).toContain('function matchesFilters(task)');
    expect(script).toContain("task.source || 'unspecified'");
    expect(script).toMatch(/\$\{tasks\.length\} matching loaded \$\{scope\}/);
  });

  test('keeps the exact task title available even when layout constrains it', () => {
    expect(script).toMatch(/class="pipeline-title" title=/);
    expect(view).toContain('<th scope="col">Activity</th>');
    expect(script).toContain('return `Heartbeat ${relativeTime(task.heartbeatAt)}`');
  });

  test('labels exact MongoDB count evidence separately from loaded rows', () => {
    expect(view).toContain('id="pipelineCountEvidence"');
    expect(script).toContain("fetchJson('/api/pipeline/tasks?limit=1000&view=summary&includeDone=true')");
    expect(script).toContain("evidence?.authority !== 'core.pipeline'");
    expect(script).toMatch(/exact full-scope totals/);
  });

  test('shows an evidence-honest Coding Team scorecard and recent attempt timeline', () => {
    for (const id of [
      'pipelineTeamWindow',
      'pipelineTeamAccepted',
      'pipelineTeamFirstPass',
      'pipelineTeamCycle',
      'pipelineTeamInterventions',
      'pipelineTeamCost',
      'pipelineTeamCoverage',
      'pipelineTeamAttemptRows',
    ]) {
      expect(view).toContain(`id="${id}"`);
    }
    expect(script).toContain('/api/pipeline/performance?window=');
    expect(script).toContain("return 'Unknown'");
    expect(script).toContain('missing fields remain unknown');
    expect(view).toContain('Provider spend, measured energy, and electricity estimates stay distinct');
    expect(script).toContain('GPU incremental lower bound · electricity tariff not configured');
    expect(script).toContain('electricityByCurrency');
    expect(script).toContain('Billing unverified · OpenClaw session receipt');
    expect(script).toContain("? 'Mixed evidence'");
    expect(script).toContain('data-pipeline-task=');
  });

  test('shows a privacy-safe attempt dossier inside each coding task drawer', () => {
    expect(script).toContain('Operator attempt dossier');
    expect(script).toContain('Prompts, inference transcripts, tool payloads, raw verifier output');
    expect(script).toContain("metaRow('Editable scope'");
    expect(script).toContain("metaRow('Authority sources'");
    expect(script).toContain("metaRow('Local energy'");
    expect(script).toContain("metaRow('Electricity'");
    expect(script).toContain('function attemptHumanSummary(attempt, evidence)');
    expect(script).toContain("codes.has('independent_verification_failed')");
    expect(script).toContain("codes.has('attribution_request_count_mismatch')");
    expect(script).toContain("metaRow('What happened'");
    expect(script).toContain("metaRow('Impact'");
    expect(script).toContain("metaRow('Next action'");
    expect(script).toContain("metaRow('Failure codes'");
    expect(script).toContain('it has not been approved, merged, or deployed');
    expect(script).toContain('readDeepLinkedTask()');
    expect(script).toContain('openDrawer(pipelineId, null)');
  });

  test('distinguishes legacy review dossiers from current Coding Team receipts', () => {
    expect(script).toContain('function reviewContext(task)');
    expect(script).toContain('Human review required · legacy dossier without receipt');
    expect(script).toContain('has no recorded review decision');
    expect(script).toContain('record a decision or re-queue it under the current reviewed automation');
    expect(script).toContain('Human review required · Coding Team receipt present');
    expect(view).toContain('Human review required; receipt status shown in dossier');
    expect(view).not.toContain('Waiting for overseer confirmation');
  });

  test('offers an explicit operator-only one-shot launch without implying a scheduler', () => {
    for (const id of [
      'pipelineTeamLaunchForm',
      'pipelineTeamLaunchTask',
      'pipelineTeamLaunchConfirm',
      'pipelineTeamLaunchButton',
      'pipelineTeamLaunchState',
    ]) {
      expect(view).toContain(`id="${id}"`);
    }
    expect(view).toContain('Starts one bounded local worker');
    expect(view).toContain('scheduling, merge, and deploy stay off');
    expect(script).toContain('/api/runtime-bridges/coding-dispatch/status');
    expect(script).toContain('/api/runtime-bridges/coding-dispatch/runs');
    expect(script).toContain('provider spend ceiling $0');
    expect(script).toContain('task.automation?.sourceFiles');
    expect(script).toContain('declared authority sources');
    expect(script).toContain("task.automation?.mode !== 'review_only'");
    expect(script).toContain('JSON.stringify({ pipelineId, confirm: true })');
  });

  test('puts the complete Coding Team operator inbox before generic task counts', () => {
    for (const id of [
      'pipelineDeliveryInbox',
      'pipelineDeliveryTitle',
      'pipelineDeliveryHumanCount',
      'pipelineDeliveryState',
      'pipelineDeliveryList',
      'pipelineDeliveryMeta',
    ]) {
      expect(view).toContain(`id="${id}"`);
    }
    expect(view.indexOf('id="pipelineDeliveryInbox"')).toBeLessThan(view.indexOf('class="pipeline-metrics"'));
    expect(view).toContain('Human actions first');
    expect(script).toContain('/api/runtime-bridges/coding-delivery/status');
    for (const stage of [
      'review_ready',
      'correction_requested',
      'accepted_waiting_pr',
      'ci_running',
      'ci_failed',
      'pr_ready_to_merge',
      'deployment_in_progress',
      'deployed',
      'deployment_rolled_back',
    ]) {
      expect(script).toContain(`${stage}:`);
    }
    for (const summary of ['What changes', 'Tests &amp; proof', 'Risks', 'Recommendation', 'Exact next action']) {
      expect(script).toContain(summary);
    }
  });

  test('keeps review acceptance and a reasoned correction request inside Pipeline', () => {
    expect(script).toContain('data-drawer-action="confirm-done"');
    expect(script).toContain('data-drawer-action="request-correction"');
    expect(script).toContain('<span>Accept result</span>');
    expect(script).toContain('<span>Request correction</span>');
    expect(script).toContain('Correction requested: ${reason}');
    expect(script).toContain("body: JSON.stringify({ status: 'queued', by })");
    expect(script).toContain('The reviewer identity must differ from the worker.');
  });

  test('renders one fail-closed exact-identity merge click and secondary expert links', () => {
    expect(script).toContain('data-delivery-merge');
    expect(script).toContain('/api/runtime-bridges/coding-delivery/merge');
    expect(script).toContain('MERGE PR #${pullRequestNumber} @ ${expectedHeadSha}');
    expect(script).toContain('item?.gate?.ready !== true');
    for (const gate of ['Accepted task', 'Exact PR', 'Exact SHA', 'Sealed receipt', 'Required CI green', 'GitHub mergeable']) {
      expect(script).toContain(gate);
    }
    expect(script).toContain("url.protocol === 'https:' && url.hostname === 'github.com'");
    expect(script).toContain('target="_blank" rel="noopener noreferrer"');
    expect(view).toContain('Merge always requires one explicit operator click');
    expect(view).toContain('Deployment remains a separate protected workflow after merge');
  });
});
