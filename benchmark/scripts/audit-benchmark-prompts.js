#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROMPTS_PATH = path.join(ROOT, 'data', 'benchmark-prompts.json');
const OUT_DIR = path.join(ROOT, 'reports', 'benchmarks');
const OUT_JSON = path.join(OUT_DIR, 'prompt-audit.json');
const OUT_MD = path.join(OUT_DIR, 'prompt-audit.md');

const VALID_CATEGORIES = new Set([
    'coding', 'creative', 'instruction', 'knowledge', 'math', 'reasoning', 'translation'
]);
const VALID_DETERMINISTIC = new Set(['exact', 'numeric', 'json', 'regex']);
const VALID_CONTRACTS = new Set(['number_only', 'exact', 'regex', 'json_schema', 'structured_text', 'none']);
const RUNTIME_EXPECTED_TOKENS_MIN = 10;

function readPrompts() {
    return JSON.parse(fs.readFileSync(PROMPTS_PATH, 'utf8'));
}

function words(text) {
    return String(text || '').match(/[A-Za-z0-9$]+(?:[.'-][A-Za-z0-9$]+)*/g) || [];
}

function approxTokens(text) {
    return Math.ceil(String(text || '').length / 4);
}

function tryParseJson(text) {
    try {
        return { ok: true, value: JSON.parse(String(text || '')) };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

function joinedText(prompt) {
    return [
        prompt.name,
        prompt.prompt,
        prompt.expected_answer,
        prompt.reference_answer,
        ...(prompt.judge_criteria || [])
    ].filter(Boolean).join(' ').toLowerCase();
}

function issue(severity, code, field, message, recommendation) {
    return { severity, code, field, message, recommendation };
}

function canonicalExpectedAnswer(prompt) {
    return String(prompt.expected_answer || '')
        .replace(/\s*\(also acceptable:[^)]+\)\s*$/i, '')
        .trim();
}

function compactExpectedTokenFloor(prompt) {
    const expected = canonicalExpectedAnswer(prompt);
    const wordCount = words(expected).length;
    if (wordCount > 0) return wordCount;
    return Math.max(1, approxTokens(expected));
}

function hasStrictOutputLanguage(text) {
    return Boolean(
        /\b(output|reply|answer|return|produce)\b[^.?!\n]*(only|exactly|with no|no extra|single word|json object|json array|keys in this order|covered,uncovered)/i.test(text)
        || /\b(no extra whitespace|no extra lines|no spaces|no spaces or newlines|do not add punctuation|do not add .*newlines)\b/i.test(text)
        || /\boutput\s+[A-Za-z0-9_, -]+[.?!]?$/i.test(text)
    );
}

function contractHasChecks(contract) {
    if (!contract || !contract.type || contract.type === 'none') return false;
    if (contract.type === 'number_only') return true;
    if (contract.type === 'exact') return !!contract.template;
    if (contract.type === 'regex') return !!contract.pattern;
    if (contract.type === 'json_schema') {
        return Boolean(
            (contract.schema_keys && contract.schema_keys.length)
            || (contract.required_keys && contract.required_keys.length)
            || contract.forbidden_extra_keys
        );
    }
    if (contract.type === 'structured_text') {
        return Object.keys(contract).some(key => key !== 'type');
    }
    return false;
}

function expectedTokenFloor(prompt) {
    const promptText = String(prompt.prompt || '').toLowerCase();
    if (prompt.output_contract?.type === 'number_only') return 1;
    if (prompt.output_contract?.type === 'regex' && prompt.expected_answer) return compactExpectedTokenFloor(prompt);
    if (prompt.output_contract?.type === 'regex' && /\^-?\d/.test(prompt.output_contract.pattern || '')) return 3;
    if (prompt.output_contract?.type === 'exact') return compactExpectedTokenFloor(prompt);
    if (prompt.output_contract?.type === 'json_schema') return Math.max(20, approxTokens(prompt.expected_answer || '') + 10);
    if (prompt.category === 'translation') {
        return Math.max(6, Math.ceil(compactExpectedTokenFloor(prompt) * 1.25));
    }
    const sentenceLimit = promptText.match(/\bin\s+\d+(?:-(\d+))?\s+(?:simple\s+)?sentences?\b/);
    if (sentenceLimit) return Number(sentenceLimit[1] || 1) * 25;
    if (promptText.includes('brief')) return 60;
    if (promptText.includes('paragraph')) return 60;
    if (promptText.includes('design') || promptText.includes('refactor')) return 120;
    if (promptText.includes('explain')) return 80;
    return 10;
}

function auditPrompt(prompt, index) {
    const issues = [];
    const text = joinedText(prompt);
    const promptText = String(prompt.prompt || '').toLowerCase();
    const name = prompt.name || `(index ${index})`;
    const category = prompt.category;
    const scoringType = prompt.scoring_type || category;
    const det = prompt.deterministic_scoring || null;
    const contract = prompt.output_contract || null;
    const criteria = Array.isArray(prompt.judge_criteria) ? prompt.judge_criteria : [];
    const expectedTokens = Number(prompt.expected_tokens);
    const promptTokenEstimate = approxTokens(prompt.prompt || '');
    const judgeContextEstimate = promptTokenEstimate
        + approxTokens(prompt.expected_answer || '')
        + approxTokens(prompt.reference_answer || '')
        + approxTokens(criteria.join('\n'));

    if (!prompt.name) {
        issues.push(issue('error', 'missing-name', 'name', 'Prompt is missing a name.', 'Add a stable prompt name.'));
    }
    if (!prompt.prompt) {
        issues.push(issue('error', 'missing-prompt', 'prompt', `${name} is missing prompt text.`, 'Add prompt text.'));
    }
    if (!VALID_CATEGORIES.has(category)) {
        issues.push(issue('error', 'invalid-category', 'category', `${name} has invalid category "${category}".`, 'Use a canonical benchmark category.'));
    }
    if (scoringType && !VALID_CATEGORIES.has(scoringType)) {
        issues.push(issue('error', 'invalid-scoring-type', 'scoring_type', `${name} has invalid scoring_type "${scoringType}".`, 'Use a canonical benchmark category.'));
    }
    if (category && scoringType && category !== scoringType) {
        issues.push(issue('warn', 'category-mismatch', 'scoring_type', `${name} category and scoring_type differ.`, 'Only diverge intentionally; otherwise align them.'));
    }

    if (!Number.isFinite(expectedTokens) || expectedTokens <= 0) {
        issues.push(issue('error', 'missing-expected-tokens', 'expected_tokens', `${name} has no usable expected_tokens.`, 'Set expected_tokens to the intended answer length.'));
    } else {
        if (expectedTokens < RUNTIME_EXPECTED_TOKENS_MIN) {
            issues.push(issue('warn', 'expected-tokens-below-runtime-floor', 'expected_tokens', `${name} expected_tokens=${expectedTokens} is below the runtime persistence floor.`, `Set expected_tokens to at least ${RUNTIME_EXPECTED_TOKENS_MIN} or lower the BenchmarkPrompt schema/initializer floor.`));
        }
        const floor = expectedTokenFloor(prompt);
        if (expectedTokens < floor) {
            issues.push(issue('warn', 'expected-tokens-too-small', 'expected_tokens', `${name} expected_tokens=${expectedTokens} looks too small for its prompt/contract.`, `Consider at least ${floor} tokens or tighten the output contract.`));
        }
        if (expectedTokens > 2000 && !text.includes('long') && !text.includes('comprehensive')) {
            issues.push(issue('info', 'expected-tokens-large', 'expected_tokens', `${name} has a large expected_tokens budget (${expectedTokens}).`, 'Confirm the prompt really needs this much output.'));
        }
    }

    if (!Array.isArray(prompt.judge_criteria) || criteria.length === 0) {
        issues.push(issue('warn', 'missing-criteria', 'judge_criteria', `${name} has no judge criteria.`, 'Add 3-6 concrete criteria describing what earns credit.'));
    } else if (criteria.length < 3 && !det) {
        issues.push(issue('info', 'thin-criteria', 'judge_criteria', `${name} has fewer than 3 judge criteria.`, 'Add enough criteria to make judging stable.'));
    }

    if (det) {
        if (!VALID_DETERMINISTIC.has(det.type)) {
            issues.push(issue('error', 'invalid-deterministic-type', 'deterministic_scoring.type', `${name} has invalid deterministic type "${det.type}".`, 'Use exact, numeric, json, or regex.'));
        }
        if (det.type === 'json') {
            const parsed = tryParseJson(prompt.expected_answer);
            if (!parsed.ok) {
                issues.push(issue('error', 'json-expected-not-parseable', 'expected_answer', `${name} uses JSON scoring but expected_answer is not parseable JSON.`, 'Fix expected_answer or do not use JSON scoring.'));
            }
        }
        if (det.type === 'exact' && !hasStrictOutputLanguage(promptText)) {
            issues.push(issue('warn', 'exact-without-strict-language', 'deterministic_scoring.type', `${name} uses exact scoring without strict output language.`, 'Use numeric/json/regex/decomposed scoring, or make exact-output requirements explicit.'));
        }
        if (det.type === 'numeric' && !prompt.expected_answer) {
            issues.push(issue('error', 'numeric-missing-expected', 'expected_answer', `${name} uses numeric scoring without expected_answer.`, 'Add the expected numeric answer.'));
        }
    }

    if (contract) {
        if (!VALID_CONTRACTS.has(contract.type)) {
            issues.push(issue('error', 'invalid-contract-type', 'output_contract.type', `${name} has invalid output_contract type "${contract.type}".`, 'Use a supported output contract type.'));
        } else if (!contractHasChecks(contract)) {
            issues.push(issue('warn', 'empty-contract', 'output_contract', `${name} has an output_contract with no effective checks.`, 'Add required fields/checks or remove the contract.'));
        }
        if (contract.type === 'exact' && det?.type !== 'exact') {
            issues.push(issue('warn', 'exact-contract-nonexact-scorer', 'output_contract', `${name} has exact output contract but non-exact deterministic scoring.`, 'Align scoring with the exact contract or loosen the contract.'));
        }
        if (contract.type === 'json_schema' && det?.type === 'exact') {
            issues.push(issue('warn', 'json-contract-exact-scorer', 'deterministic_scoring.type', `${name} has JSON contract but exact string scoring.`, 'Use deterministic JSON scoring for semantic JSON comparison.'));
        }
        if (contract.type === 'regex') {
            try {
                new RegExp(contract.pattern || '');
            } catch (error) {
                issues.push(issue('error', 'invalid-regex-contract', 'output_contract.pattern', `${name} has an invalid regex contract.`, error.message));
            }
        }
    } else if (hasStrictOutputLanguage(promptText)) {
        issues.push(issue('warn', 'strict-language-no-contract', 'output_contract', `${name} has strict output language but no output_contract.`, 'Add a contract so format requirements are executable.'));
    }

    if (prompt.expected_answer) {
        const expectedTokenEstimate = approxTokens(prompt.expected_answer);
        if (Number.isFinite(expectedTokens) && expectedTokenEstimate > expectedTokens * 2.5 && !hasStrictOutputLanguage(promptText)) {
            issues.push(issue('info', 'expected-answer-longer-than-budget', 'expected_answer', `${name} expected_answer is much longer than expected_tokens.`, 'Confirm expected_tokens describes the model response, not just a short answer key.'));
        }
    }

    if (['knowledge', 'coding', 'reasoning', 'math', 'translation'].includes(category)
        && !prompt.reference_answer
        && !det
        && criteria.length < 4) {
        issues.push(issue('info', 'no-reference-thin-criteria', 'reference_answer', `${name} has no reference answer and thin criteria.`, 'Add a reference answer or richer criteria for stable judging.'));
    }

    if (judgeContextEstimate > 6000) {
        issues.push(issue('warn', 'large-judge-context', 'prompt', `${name} judge context estimate is ${judgeContextEstimate} tokens before response.`, 'Use a larger judge num_ctx or shorten prompt/reference/criteria.'));
    }

    return {
        index,
        name,
        category,
        scoring_type: scoringType,
        level: prompt.level,
        expected_tokens: prompt.expected_tokens,
        prompt_token_estimate: promptTokenEstimate,
        judge_context_estimate: judgeContextEstimate,
        deterministic_type: det?.type || null,
        output_contract_type: contract?.type || null,
        issue_count: issues.length,
        max_severity: issues.some(i => i.severity === 'error') ? 'error'
            : issues.some(i => i.severity === 'warn') ? 'warn'
            : issues.some(i => i.severity === 'info') ? 'info'
            : 'ok',
        issues
    };
}

function severityRank(severity) {
    return { error: 0, warn: 1, info: 2, ok: 3 }[severity] ?? 4;
}

function makeMarkdown(report) {
    const lines = [];
    lines.push('# Benchmark Prompt Audit');
    lines.push('');
    lines.push(`Generated: ${report.generated_at}`);
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push(`- Prompts audited: ${report.summary.prompts}`);
    lines.push(`- Errors: ${report.summary.errors}`);
    lines.push(`- Warnings: ${report.summary.warnings}`);
    lines.push(`- Info: ${report.summary.info}`);
    lines.push(`- Clean prompts: ${report.summary.clean}`);
    lines.push('');
    lines.push('## Findings');
    lines.push('');
    for (const item of report.prompts.filter(p => p.issue_count > 0)) {
        lines.push(`### ${item.name}`);
        lines.push('');
        lines.push(`- Category: ${item.category}`);
        lines.push(`- Scoring: ${item.deterministic_type || 'judge'} / contract ${item.output_contract_type || 'none'}`);
        lines.push(`- Expected tokens: ${item.expected_tokens}; prompt estimate: ${item.prompt_token_estimate}; judge-context estimate: ${item.judge_context_estimate}`);
        for (const found of item.issues) {
            lines.push(`- ${found.severity.toUpperCase()} ${found.code} (${found.field}): ${found.message}`);
            lines.push(`  Recommendation: ${found.recommendation}`);
        }
        lines.push('');
    }
    if (!report.prompts.some(p => p.issue_count > 0)) {
        lines.push('No findings.');
        lines.push('');
    }
    return lines.join('\n');
}

function main() {
    const prompts = readPrompts();
    const audited = prompts.map(auditPrompt)
        .sort((a, b) => severityRank(a.max_severity) - severityRank(b.max_severity)
            || b.issue_count - a.issue_count
            || a.index - b.index);

    const summary = audited.reduce((acc, item) => {
        acc.prompts += 1;
        if (item.issue_count === 0) acc.clean += 1;
        for (const found of item.issues) {
            if (found.severity === 'error') acc.errors += 1;
            else if (found.severity === 'warn') acc.warnings += 1;
            else acc.info += 1;
        }
        return acc;
    }, { prompts: 0, clean: 0, errors: 0, warnings: 0, info: 0 });

    const report = {
        generated_at: new Date().toISOString(),
        prompt_file: path.relative(ROOT, PROMPTS_PATH).replace(/\\/g, '/'),
        summary,
        prompts: audited
    };

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(OUT_MD, `${makeMarkdown(report)}\n`);

    console.log(JSON.stringify({
        summary,
        json: path.relative(ROOT, OUT_JSON).replace(/\\/g, '/'),
        markdown: path.relative(ROOT, OUT_MD).replace(/\\/g, '/')
    }, null, 2));
}

main();
