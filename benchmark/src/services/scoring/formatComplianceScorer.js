/**
 * Format Compliance Scorer
 * Evaluates raw response against an output_contract spec.
 * Returns { format_score, format_compliant } or nulls when no contract.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 0149 — Weighted-soft aggregator (contract §2.5)
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   For each declared structural check, produce (sub_score ∈ [0,10], weight ∈ (0,1]).
 *   avg = Σ(sub_score × weight) / Σ(weight)
 *   min_sub = min(sub_scores)
 *   format_score = FORMAT_SCORE_AGGREGATOR_WEIGHTS.avg × avg
 *                + FORMAT_SCORE_AGGREGATOR_WEIGHTS.minPenalty × min_sub
 *
 * Properties (verified in tests):
 *   - Single-check contract that fails at 0  → format_score = 0     (gate fires)
 *   - Single-check contract that fails at 2  → format_score = 2     (gate fires)
 *   - Compound (3 passes, 1 missing keyword) → format_score ≥ 9     (compound safety)
 *   - Compound (3 passes, 1 fails at 0)      → avg 7.5, min 0 → 5.25 (gate MAY fire)
 *   - Compound (2 passes, 2 soft-fails at 6) → format_score ≈ 6.6  (gate doesn't fire)
 *   - Compound (1 pass, 1 hard-fail at 0)    → avg 5, min 0 → 3.5   (gate fires)
 *
 * Hard constraint (from 0146 post-mortem): aggregator MUST NOT collapse a
 * compound contract with one soft miss to 0. Pure min() is forbidden. The
 * 0.7/0.3 blend keeps catastrophic-floor signal without crushing compound
 * contracts — sub_score ≥ 2 contributes upward.
 */

const logger = require('../../../config/logger');

// Aggregator tunable. Kept at module level so future tuning work (different
// blend, per-category weights) can override without touching call sites.
const FORMAT_SCORE_AGGREGATOR_WEIGHTS = Object.freeze({ avg: 0.7, minPenalty: 0.3 });

// Soft gradient on count fields: responses within ±SOFT_COUNT_TOLERANCE of the
// declared range earn a partial score (not a cliff). 10% tolerance, min 1 unit.
const SOFT_COUNT_TOLERANCE = 0.1;

function scoreFormatCompliance(response, contract) {
    if (!contract || !contract.type || contract.type === 'none') {
        return { format_score: null, format_compliant: null };
    }

    const trimmed = (response || '').trim();
    if (!trimmed) {
        return { format_score: 0, format_compliant: false };
    }

    switch (contract.type) {
        case 'number_only':
            return scoreNumberOnly(trimmed, contract);
        case 'exact':
            return scoreExact(trimmed, contract);
        case 'regex':
            return scoreRegex(trimmed, contract);
        case 'json_schema':
            return scoreJsonSchema(trimmed, contract);
        case 'structured_text':
            return scoreStructuredText(trimmed, contract);
        default:
            logger.warn('Unknown output_contract type', { type: contract.type });
            return { format_score: null, format_compliant: null };
    }
}

function scoreNumberOnly(response, contract) {
    const allowLatex = contract.allow_latex !== false;

    const plainNumberPattern = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;
    if (plainNumberPattern.test(response)) {
        return { format_score: 10, format_compliant: true };
    }

    const latexBoxedPattern = /^\$?\\boxed\{[^}]+\}\$?$/;
    if (allowLatex && latexBoxedPattern.test(response)) {
        return { format_score: 8, format_compliant: true };
    }

    const latexWrapped = /^\$[^$]+\$$/;
    if (allowLatex && latexWrapped.test(response)) {
        return { format_score: 7, format_compliant: true };
    }

    const hasNumber = /-?\d+(\.\d+)?/.test(response);
    if (hasNumber) {
        return { format_score: 4, format_compliant: false };
    }

    return { format_score: 0, format_compliant: false };
}

function scoreExact(response, contract) {
    const template = contract.template || '';
    if (!template) {
        return { format_score: null, format_compliant: null };
    }

    if (response === template) {
        return { format_score: 10, format_compliant: true };
    }

    const normalize = s => s.toLowerCase().trim().replace(/\s+/g, ' ');
    if (normalize(response) === normalize(template)) {
        return { format_score: 7, format_compliant: true };
    }

    if (normalize(response).includes(normalize(template))) {
        return { format_score: 3, format_compliant: false };
    }

    return { format_score: 0, format_compliant: false };
}

function scoreRegex(response, contract) {
    const pattern = contract.pattern;
    if (!pattern) {
        return { format_score: null, format_compliant: null };
    }

    try {
        const re = new RegExp(pattern, 'i');
        if (re.test(response)) {
            return { format_score: 10, format_compliant: true };
        }
        return { format_score: 0, format_compliant: false };
    } catch (err) {
        logger.warn('Invalid regex pattern in output_contract', { pattern, error: err.message });
        return { format_score: null, format_compliant: null };
    }
}

function scoreJsonSchema(response, contract) {
    const requiredKeys = contract.required_keys || contract.schema_keys || [];

    const firstBrace = response.indexOf('{');
    const lastBrace = response.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        return { format_score: 0, format_compliant: false };
    }

    try {
        const parsed = JSON.parse(response.substring(firstBrace, lastBrace + 1));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { format_score: 2, format_compliant: false };
        }

        if (requiredKeys.length === 0) {
            return { format_score: 10, format_compliant: true };
        }

        const presentKeys = Object.keys(parsed);
        const hasAllRequired = requiredKeys.every(k => presentKeys.includes(k));
        const hasNoForbiddenExtras = contract.forbidden_extra_keys
            ? presentKeys.every(k => requiredKeys.includes(k))
            : true;
        if (hasAllRequired && hasNoForbiddenExtras) {
            return { format_score: 10, format_compliant: true };
        }

        if (hasAllRequired) {
            return { format_score: 7, format_compliant: false };
        }

        return { format_score: 5, format_compliant: false };
    } catch {
        return { format_score: 0, format_compliant: false };
    }
}

function splitLines(text) {
    return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function splitParagraphs(text) {
    return text
        .split(/\r?\n\s*\r?\n/)
        .map(paragraph => paragraph.trim())
        .filter(Boolean);
}

function normalizeForSentenceSplit(text) {
    return text
        .replace(/\b([ap])\.m\./gi, '$1m')
        .replace(/\be\.g\./gi, 'eg')
        .replace(/\bi\.e\./gi, 'ie');
}

function splitSentences(text) {
    const normalized = normalizeForSentenceSplit(text).trim();
    if (!normalized) return [];
    return normalized
        .split(/(?<=[.!?])\s+(?=[A-Z"'])/)
        .map(sentence => sentence.trim())
        .filter(Boolean);
}

function countWords(text) {
    return (text.match(/[A-Za-z0-9$]+(?:[.'-][A-Za-z0-9$]+)*/g) || []).length;
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsTerm(text, term) {
    const source = String(text || '');
    const needle = String(term || '');
    if (!needle) return false;

    if (/^[A-Za-z0-9 ]+$/.test(needle)) {
        return new RegExp(`\\b${escapeRegex(needle)}\\b`, 'i').test(source);
    }

    return source.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Resolve a range-shaped declaration, accepting:
 *   { min, max }         — canonical
 *   { exact }            — alias for { min:exact, max:exact }
 *   scalar integer       — alias for { min:n, max:n }
 * Returns { min, max } with Infinity/−Infinity for missing bounds, or null if
 * the caller supplied nothing meaningful.
 */
function resolveRange(value, fallback) {
    if (value === undefined || value === null) {
        return fallback || null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return { min: value, max: value };
    }
    if (typeof value === 'object') {
        const min = Number.isFinite(value.min) ? value.min
            : Number.isFinite(value.exact) ? value.exact : -Infinity;
        const max = Number.isFinite(value.max) ? value.max
            : Number.isFinite(value.exact) ? value.exact : Infinity;
        if (min === -Infinity && max === Infinity) return fallback || null;
        return { min, max };
    }
    return fallback || null;
}

/**
 * Score a numeric value against a {min,max} range using a soft gradient.
 * Inside range → 10; within ±SOFT_COUNT_TOLERANCE of the nearest bound → 9.5
 * to ~7 linear; outside tolerance → 0. The gradient prevents a 1-unit cliff
 * (e.g., 46 words for min=45 should not score 0).
 */
function scoreRange(value, range) {
    if (!range) return null;
    const { min, max } = range;
    if (value >= min && value <= max) return 10;

    // Tolerance sized to the range magnitude (use max of bounds or the value).
    const magnitude = Math.max(
        Number.isFinite(max) ? max : 0,
        Number.isFinite(min) ? min : 0,
        value,
        1
    );
    const tol = Math.max(1, Math.ceil(magnitude * SOFT_COUNT_TOLERANCE));

    let distance;
    if (value < min) distance = min - value;
    else distance = value - max;

    if (distance <= tol) {
        // Linear from 10 → 6 across [0, tol] with a floor that keeps the gate
        // firing when distance > tol. Pick 6 at the tolerance edge so values
        // just outside can still contribute meaningfully in compound contracts.
        return Math.round((10 - (4 * distance / tol)) * 10) / 10;
    }
    return 0;
}

/**
 * Weighted-soft aggregator — see header comment for formula.
 * Input: array of { score: 0..10, weight: >0, label?: string }.
 * Returns { format_score, format_compliant, breakdown } where breakdown is
 * the sub-scores array for diagnostics.
 */
function aggregateWeightedSoft(subScores) {
    if (!subScores.length) {
        return { format_score: null, format_compliant: null, breakdown: [] };
    }

    let weightedSum = 0;
    let totalWeight = 0;
    let minSub = Infinity;
    let allPerfect = true;

    for (const entry of subScores) {
        const w = Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 1;
        const s = Math.max(0, Math.min(10, Number(entry.score) || 0));
        weightedSum += s * w;
        totalWeight += w;
        if (s < minSub) minSub = s;
        if (s < 10) allPerfect = false;
    }

    const avg = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const blended = FORMAT_SCORE_AGGREGATOR_WEIGHTS.avg * avg
        + FORMAT_SCORE_AGGREGATOR_WEIGHTS.minPenalty * minSub;
    const formatScore = Math.round(Math.max(0, Math.min(10, blended)) * 10) / 10;

    return {
        format_score: formatScore,
        format_compliant: allPerfect,
        breakdown: subScores.map(e => ({
            label: e.label || null,
            score: Math.max(0, Math.min(10, Number(e.score) || 0)),
            weight: Number.isFinite(e.weight) && e.weight > 0 ? e.weight : 1
        }))
    };
}

function scoreStructuredText(response, contract) {
    const lines = splitLines(response);
    const paragraphs = splitParagraphs(response);
    const sentences = splitSentences(response);
    const subScores = [];

    const addSub = (label, score, weight = 1) => {
        subScores.push({ label, score, weight });
    };
    const addBinary = (label, passed, weight = 1) => {
        addSub(label, passed ? 10 : 0, weight);
    };

    // ─── Count-style fields (range-aware, soft gradient) ─────────────────
    //
    // word_count aliases: word_count {min,max,exact} | min_words+max_words | words
    const wordRange = resolveRange(
        contract.word_count,
        resolveRange(contract.words,
            (Number.isFinite(contract.min_words) || Number.isFinite(contract.max_words))
                ? { min: Number.isFinite(contract.min_words) ? contract.min_words : -Infinity,
                    max: Number.isFinite(contract.max_words) ? contract.max_words : Infinity }
                : null)
    );
    if (wordRange) {
        const n = countWords(response);
        addSub('word_count', scoreRange(n, wordRange));
    }

    // sentence_count aliases: sentence_count (int or {min,max}) | sentences | min_sentences+max_sentences
    let sentenceRange = null;
    if (Number.isInteger(contract.sentence_count)) {
        sentenceRange = { min: contract.sentence_count, max: contract.sentence_count };
    } else {
        sentenceRange = resolveRange(
            contract.sentence_count,
            resolveRange(contract.sentences,
                (Number.isFinite(contract.min_sentences) || Number.isFinite(contract.max_sentences))
                    ? { min: Number.isFinite(contract.min_sentences) ? contract.min_sentences : -Infinity,
                        max: Number.isFinite(contract.max_sentences) ? contract.max_sentences : Infinity }
                    : null)
        );
    }
    if (sentenceRange) {
        addSub('sentence_count', scoreRange(sentences.length, sentenceRange));
    }

    // line_count / paragraph_count — exact integer checks (legacy shape).
    if (Number.isInteger(contract.line_count)) {
        addBinary('line_count', lines.length === contract.line_count);
    }
    if (Number.isInteger(contract.paragraph_count)) {
        addBinary('paragraph_count', paragraphs.length === contract.paragraph_count);
    }

    // ─── Keyword membership (graded) ─────────────────────────────────────
    //
    // must_include is the 0149 alias for required_terms. Same semantics.
    const mustInclude = []
        .concat(Array.isArray(contract.required_terms) ? contract.required_terms : [])
        .concat(Array.isArray(contract.must_include) ? contract.must_include : []);
    if (mustInclude.length > 0) {
        const missing = mustInclude.filter(term => !containsTerm(response, term)).length;
        const score = Math.max(0, 10 - 2 * missing);
        addSub('must_include', score);
    }

    if (Array.isArray(contract.required_term_groups) && contract.required_term_groups.length > 0) {
        const missingGroups = contract.required_term_groups.filter(
            group => !group.some(term => containsTerm(response, term))
        ).length;
        const score = Math.max(0, 10 - 2 * missingGroups);
        addSub('required_term_groups', score);
    }

    // must_not_include is the 0149 alias for forbidden_terms.
    const mustNotInclude = []
        .concat(Array.isArray(contract.forbidden_terms) ? contract.forbidden_terms : [])
        .concat(Array.isArray(contract.must_not_include) ? contract.must_not_include : []);
    if (mustNotInclude.length > 0) {
        const violations = mustNotInclude.filter(term => containsTerm(response, term)).length;
        const score = Math.max(0, 10 - 3 * violations);
        addSub('must_not_include', score);
    }

    // ─── Line-level structural checks (unchanged semantics, binary sub-scores) ─
    if (Array.isArray(contract.line_regexes) && contract.line_regexes.length > 0) {
        const sameLength = lines.length === contract.line_regexes.length;
        const allMatched = sameLength && contract.line_regexes.every((pattern, index) => new RegExp(pattern).test(lines[index] || ''));
        addBinary('line_regexes', allMatched);
    }

    if (Array.isArray(contract.line_starts_with) && contract.line_starts_with.length > 0) {
        const sameLength = lines.length === contract.line_starts_with.length;
        const allMatched = sameLength && contract.line_starts_with.every((prefix, index) => (lines[index] || '').startsWith(prefix));
        addBinary('line_starts_with', allMatched);
    }

    if (Array.isArray(contract.line_initials) && contract.line_initials.length > 0) {
        const sameLength = lines.length === contract.line_initials.length;
        const allMatched = sameLength && contract.line_initials.every((initial, index) => {
            const line = (lines[index] || '').trim();
            return line.charAt(0).toUpperCase() === String(initial).toUpperCase();
        });
        addBinary('line_initials', allMatched);
    }

    if (contract.line_word_count && (Number.isFinite(contract.line_word_count.min) || Number.isFinite(contract.line_word_count.max))) {
        const passed = lines.every((line) => {
            const words = countWords(line);
            const minOk = !Number.isFinite(contract.line_word_count.min) || words >= contract.line_word_count.min;
            const maxOk = !Number.isFinite(contract.line_word_count.max) || words <= contract.line_word_count.max;
            return minOk && maxOk;
        });
        addBinary('line_word_count', passed);
    }

    if (contract.each_line_ends_with) {
        addBinary('each_line_ends_with', lines.every(line => line.endsWith(contract.each_line_ends_with)));
    }

    if (contract.second_sentence_starts_with) {
        addBinary(
            'second_sentence_starts_with',
            sentences.length >= 2 && sentences[1].startsWith(contract.second_sentence_starts_with)
        );
    }

    if (Number.isInteger(contract.sentences_per_paragraph)) {
        addBinary(
            'sentences_per_paragraph',
            paragraphs.every(paragraph => splitSentences(paragraph).length === contract.sentences_per_paragraph)
        );
    }

    if (Array.isArray(contract.paragraph_required_terms) && contract.paragraph_required_terms.length > 0) {
        const sameLength = paragraphs.length === contract.paragraph_required_terms.length;
        const allMatched = sameLength && contract.paragraph_required_terms.every((terms, index) => terms.every(term => containsTerm(paragraphs[index] || '', term)));
        addBinary('paragraph_required_terms', allMatched);
    }

    if (Array.isArray(contract.paragraph_required_any) && contract.paragraph_required_any.length > 0) {
        const sameLength = paragraphs.length === contract.paragraph_required_any.length;
        const allMatched = sameLength && contract.paragraph_required_any.every((terms, index) => terms.some(term => containsTerm(paragraphs[index] || '', term)));
        addBinary('paragraph_required_any', allMatched);
    }

    if (contract.forbidden_line_pattern) {
        const linePattern = new RegExp(contract.forbidden_line_pattern, 'i');
        addBinary('forbidden_line_pattern', lines.every(line => !linePattern.test(line)));
    }

    // max_length: single-axis length cap (char-count). Pass-through if no limit.
    if (Number.isFinite(contract.max_length)) {
        addBinary('max_length', response.length <= contract.max_length);
    }

    if (subScores.length === 0) {
        return { format_score: null, format_compliant: null };
    }

    const { format_score, format_compliant } = aggregateWeightedSoft(subScores);
    return { format_score, format_compliant };
}

module.exports = {
    scoreFormatCompliance,
    // exported for test introspection / future tuning
    FORMAT_SCORE_AGGREGATOR_WEIGHTS,
    _internal: {
        aggregateWeightedSoft,
        scoreRange,
        resolveRange,
        countWords,
        splitSentences
    }
};
