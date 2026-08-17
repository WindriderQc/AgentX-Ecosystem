/**
 * Roundtable Quality Analyzer
 *
 * Scores agent turns + synthesis using an LLM-as-judge pattern. Calls core's
 * own inference proxy (self-contained — no cross-service dependency on the
 * benchmark judge service). Gracefully no-ops if the judge model can't be
 * reached, so roundtable completion is never blocked by scoring failure.
 */

const fetch = require('node-fetch');
const logger = require('../../../config/logger');
const Roundtable = require('../../../models/Roundtable');
const { getTargetForModel } = require('../modelRouter');

const { PRODUCT_DEFAULT_MODEL } = require('../modelRouterDefaults');
const JUDGE_MODEL = process.env.ROUNDTABLE_JUDGE_MODEL || PRODUCT_DEFAULT_MODEL;
const JUDGE_TIMEOUT_MS = Number(process.env.ROUNDTABLE_JUDGE_TIMEOUT_MS || 120000);

const AGENT_DIMENSIONS = [
  { name: 'clarity', desc: 'How clear, well-structured, and easy to follow is the response?' },
  { name: 'evidence_quality', desc: 'How well does the agent support claims with reasoning, examples, or evidence?' },
  { name: 'logical_coherence', desc: 'How logically consistent and well-reasoned is the argument?' }
];

const SYNTHESIS_DIMENSIONS = [
  { name: 'coverage', desc: 'How well does the synthesis cover all agent perspectives and key points?' },
  { name: 'fairness', desc: 'How fairly does the synthesis represent different viewpoints without bias?' },
  { name: 'actionability', desc: 'How actionable and useful is the final verdict/recommendation?' }
];

function buildJudgePrompt(dimensions, context, criteria, response) {
  const dimList = dimensions.map((d) => `- "${d.name}" (0-10): ${d.desc}`).join('\n');
  return `You are an impartial evaluator.

${context}

Evaluate the response below against these criteria:
${dimList}

Also provide an "overall" score (0-10) reflecting combined quality.

Criteria benchmark: ${criteria}

Response to evaluate:
---
${response}
---

Return STRICT JSON only (no prose, no markdown fences):
{${dimensions.map((d) => `"${d.name}": <0-10>`).join(', ')}, "overall": <0-10>}`;
}

function extractJson(text) {
  if (!text) return null;
  // Try to extract first balanced JSON object
  const firstBrace = text.indexOf('{');
  if (firstBrace < 0) return null;
  let depth = 0;
  for (let i = firstBrace; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.substring(firstBrace, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function callJudge(prompt) {
  const target = getTargetForModel(JUDGE_MODEL);
  if (!target) {
    return { success: false, error: `No host for judge model ${JUDGE_MODEL}` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
  try {
    const resp = await fetch(`${target}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: JUDGE_MODEL, prompt, stream: false, options: { temperature: 0.2 } }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!resp.ok) {
      return { success: false, error: `Judge ${resp.status}` };
    }
    const data = await resp.json();
    const scores = extractJson(data.response || '');
    if (!scores) return { success: false, error: 'Failed to parse judge JSON' };
    return { success: true, scores };
  } catch (err) {
    clearTimeout(timer);
    return { success: false, error: err.name === 'AbortError' ? `Timeout after ${JUDGE_TIMEOUT_MS}ms` : err.message };
  }
}

async function analyzeQuality(roundtableId) {
  const doc = await Roundtable.findById(roundtableId);
  if (!doc || doc.status !== 'completed') return null;
  const turns = doc.turns || [];
  if (turns.length === 0) return null;

  logger.info('Starting roundtable quality analysis', { roundtableId, turnsCount: turns.length });

  const agentScores = {};
  const errors = [];
  const agentIds = [...new Set(turns.map((t) => t.agentId))];

  for (const agentId of agentIds) {
    const turn = turns.filter((t) => t.agentId === agentId).sort((a, b) => b.round - a.round)[0];
    if (!turn || !turn.response || turn.error) {
      agentScores[agentId] = { clarity: 0, evidence_quality: 0, logical_coherence: 0, overall: 0, error: turn?.error || 'No response' };
      continue;
    }
    const prompt = buildJudgePrompt(
      AGENT_DIMENSIONS,
      `Evaluate this roundtable agent response (${turn.role}) to the question: "${doc.question}"`,
      "A well-reasoned, clear, evidence-based analysis from the agent's perspective",
      turn.response
    );
    const result = await callJudge(prompt);
    if (result.success && result.scores) {
      agentScores[agentId] = {
        clarity: result.scores.clarity ?? null,
        evidence_quality: result.scores.evidence_quality ?? null,
        logical_coherence: result.scores.logical_coherence ?? null,
        overall: result.scores.overall ?? null,
        role: turn.role,
        round: turn.round
      };
    } else {
      agentScores[agentId] = { clarity: 0, evidence_quality: 0, logical_coherence: 0, overall: 0, error: result.error };
      errors.push({ agentId, error: result.error });
    }
  }

  let synthesisScores = null;
  if (doc.synthesis?.response) {
    const prompt = buildJudgePrompt(
      SYNTHESIS_DIMENSIONS,
      `Evaluate this roundtable synthesis for the question: "${doc.question}"`,
      'A comprehensive, fair, and actionable synthesis of multiple agent perspectives',
      doc.synthesis.response
    );
    const result = await callJudge(prompt);
    if (result.success && result.scores) {
      synthesisScores = {
        coverage: result.scores.coverage ?? null,
        fairness: result.scores.fairness ?? null,
        actionability: result.scores.actionability ?? null,
        overall: result.scores.overall ?? null
      };
    } else {
      synthesisScores = { coverage: 0, fairness: 0, actionability: 0, overall: 0, error: result.error };
      errors.push({ agentId: 'synthesizer', error: result.error });
    }
  }

  // Agreement index — how much agents converge on their overall score.
  const overallScores = Object.values(agentScores).map((s) => s.overall).filter((s) => typeof s === 'number' && s > 0);
  let agreementIndex = null;
  if (overallScores.length >= 2) {
    const mean = overallScores.reduce((a, b) => a + b, 0) / overallScores.length;
    const variance = overallScores.reduce((sum, s) => sum + ((s - mean) ** 2), 0) / overallScores.length;
    agreementIndex = Math.max(0, 1 - Math.sqrt(variance) / 10);
  }

  const qualityScores = {
    agents: agentScores,
    synthesis: synthesisScores,
    agreementIndex,
    analyzedAt: new Date(),
    judgeModel: JUDGE_MODEL,
    errors: errors.length > 0 ? errors : undefined
  };

  await Roundtable.updateOne({ _id: roundtableId }, { $set: { qualityScores } });

  logger.info('Roundtable quality analysis completed', {
    roundtableId,
    agentCount: Object.keys(agentScores).length,
    synthesisScored: !!synthesisScores,
    agreementIndex,
    errorCount: errors.length
  });

  return qualityScores;
}

module.exports = { analyzeQuality, AGENT_DIMENSIONS, SYNTHESIS_DIMENSIONS };
