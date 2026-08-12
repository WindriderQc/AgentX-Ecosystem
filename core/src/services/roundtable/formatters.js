/**
 * Roundtable Formatters — markdown transcript + compact summary.
 */

function formatTranscript(doc) {
  const lines = [];
  const durationSec = doc.totalDurationMs ? (doc.totalDurationMs / 1000).toFixed(1) : '—';

  lines.push(`# Roundtable: ${doc.question}`);
  lines.push(`**Status:** ${doc.status} | **Duration:** ${durationSec}s | **Rounds:** ${doc.rounds} | **Decision:** ${doc.governance?.decisionStatus || 'advisory'}`);
  lines.push('');

  const allTurns = doc.turns || [];

  // Performance table (round 1 + synthesizer)
  if (allTurns.length > 0) {
    lines.push('## Performance');
    lines.push('| Agent | Runtime | Model | Host | Tokens/s | Latency |');
    lines.push('|-------|---------|-------|------|----------|---------|');
    const r1Turns = allTurns.filter((t) => t.round === 1);
    for (const turn of r1Turns) {
      const tps = turn.stats?.tokensPerSecond ? turn.stats.tokensPerSecond.toFixed(1) : '—';
      const lat = turn.stats?.latencyMs ? `${(turn.stats.latencyMs / 1000).toFixed(1)}s` : '—';
      const host = turn.hostName || '—';
      lines.push(`| ${turn.role} | ${turn.runtime || 'model'} | ${turn.model} | ${host} | ${tps} | ${lat} |`);
    }
    if (doc.synthesis?.model) {
      const sTps = doc.synthesis.stats?.tokensPerSecond ? doc.synthesis.stats.tokensPerSecond.toFixed(1) : '—';
      const sLat = doc.synthesis.stats?.latencyMs ? `${(doc.synthesis.stats.latencyMs / 1000).toFixed(1)}s` : '—';
      const sHost = doc.synthesis.hostName || '—';
      lines.push(`| Synthesizer | model | ${doc.synthesis.model} | ${sHost} | ${sTps} | ${sLat} |`);
    }
    lines.push('');
  }

  const maxRound = allTurns.reduce((max, t) => Math.max(max, t.round || 0), 0);
  for (let r = 1; r <= maxRound; r += 1) {
    const roundTurns = allTurns.filter((t) => t.round === r);
    const label = r === 1 ? 'Initial Analysis' : `Rebuttal Round ${r}`;
    lines.push(`## Round ${r} — ${label}`);
    lines.push('');
    for (const turn of roundTurns) {
      lines.push(`### ${turn.role} (${turn.runtime || 'model'} · ${turn.model})`);
      if (turn.error) {
        lines.push(`> **Error:** ${turn.error}`);
      } else {
        lines.push(turn.response || '*No response*');
      }
      if (turn.webSearchResults && turn.webSearchResults.length > 0) {
        lines.push('');
        lines.push('**Web Sources:**');
        for (const src of turn.webSearchResults) {
          lines.push(`- [${src.title}](${src.url})`);
        }
      }
      lines.push('');
    }
  }

  if (doc.synthesis?.response || doc.synthesis?.error) {
    lines.push('## Synthesis');
    if (doc.synthesis.error) {
      lines.push(`> **Error:** ${doc.synthesis.error}`);
    } else {
      lines.push(doc.synthesis.response);
    }
    lines.push('');
  }

  if (doc.interjections?.length) {
    lines.push('## Chair Interjections');
    for (const item of doc.interjections) {
      lines.push(`- **${item.author}** (${item.status}${item.appliedRound != null ? `, phase ${item.appliedRound}` : ''}): ${item.text}`);
    }
    lines.push('');
  }

  if (doc.governance) {
    lines.push('## Governance');
    lines.push(`- Approval required: ${doc.governance.requireApproval ? 'yes' : 'no'}`);
    lines.push(`- Decision: ${doc.governance.decisionStatus || 'advisory'}`);
    if (doc.governance.decidedBy) lines.push(`- Decided by: ${doc.governance.decidedBy}`);
    if (doc.governance.decisionNote) lines.push(`- Note: ${doc.governance.decisionNote}`);
    lines.push('');
  }

  return lines.join('\n');
}

function formatCompactSummary(doc) {
  const parts = [];
  const durationSec = doc.totalDurationMs ? (doc.totalDurationMs / 1000).toFixed(0) : '?';
  parts.push(`*Roundtable* [${doc.status}] (${durationSec}s)`);
  parts.push(`*Q:* ${doc.question.substring(0, 100)}${doc.question.length > 100 ? '...' : ''}`);

  const r1Turns = (doc.turns || []).filter((t) => t.round === 1);
  for (const turn of r1Turns) {
    if (turn.response) {
      const first = turn.response.split(/[.!?]\s/)[0];
      parts.push(`*${turn.role}:* ${first.substring(0, 80)}`);
    }
  }
  if (doc.synthesis?.response) {
    const verdict = doc.synthesis.response.split(/[.!?]\s/)[0];
    parts.push(`*Verdict:* ${verdict.substring(0, 120)}`);
  }
  parts.push(`*Decision:* ${doc.governance?.decisionStatus || 'advisory'}`);
  return parts.join('\n');
}

module.exports = { formatTranscript, formatCompactSummary };
