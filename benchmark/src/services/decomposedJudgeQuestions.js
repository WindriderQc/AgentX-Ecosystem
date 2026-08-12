'use strict';
/**
 * Decomposed Judge — Static Question Bank
 *
 * Pure data: category → dimension → [{q, weight, invert?}]
 * Extracted from decomposedJudge.js to keep service files within 600-line limit.
 *
 * Consumed by: src/services/decomposedJudge.js
 */

/**
 * Decomposed questions for each category/dimension.
 * Each question has a weight that contributes to the final score.
 */
const DECOMPOSED_QUESTIONS = {
    coding: {
        correctness: [
            { q: 'Does the solution address the requested coding task or bug?', weight: 0.20 },
            { q: 'Is the bug or root cause correctly identified when debugging is required?', weight: 0.20 },
            { q: 'Would the code or fix produce correct output for typical inputs?', weight: 0.35 },
            { q: 'Does it preserve intended behavior without introducing obvious regressions?', weight: 0.25 }
        ],
        clarity: [
            { q: 'Is the fix readable enough for a reviewer to verify quickly, even if names stay terse?', weight: 0.30 },
            { q: 'Is the code organized into logical sections or blocks rather than one long unstructured sequence?', weight: 0.25 },
            { q: 'If literals are used, are they context-appropriate and not hiding logic mistakes?', weight: 0.25 },
            { q: 'Is the overall structure readable without needing extensive comments to understand the flow?', weight: 0.20 }
        ],
        efficiency: [
            { q: 'Does the solution avoid obviously inefficient patterns?', weight: 0.35 },
            { q: 'For the stated task size, is the time and space complexity acceptable?', weight: 0.35 },
            { q: 'Does the solution avoid unnecessary complexity or over-engineering?', weight: 0.30 }
        ],
        robustness: [
            { q: 'Does the solution handle null, empty, or invalid inputs appropriately?', weight: 0.30 },
            { q: 'Are failure paths or guard checks sufficient for the requested change scope?', weight: 0.30 },
            { q: 'Are important edge cases still handled after the change?', weight: 0.20 },
            { q: 'Would unexpected input likely cause a crash or obvious failure?', weight: 0.20, invert: true }
        ]
    },
    reasoning: {
        accuracy: [
            { q: 'Is the final conclusion or answer correct?', weight: 0.40 },
            { q: 'Are the intermediate steps and use of prior context accurate?', weight: 0.35 },
            { q: 'Does it avoid factual or interpretive errors while reasoning?', weight: 0.25 }
        ],
        logic_soundness: [
            { q: 'Does each reasoning step logically follow from the previous one?', weight: 0.25 },
            { q: 'Are there contradictions or logical fallacies present?', weight: 0.25, invert: true },
            { q: 'Does the response distinguish between what it knows and what it assumes?', weight: 0.25 },
            { q: 'Are alternative explanations or counterarguments acknowledged when relevant?', weight: 0.25 }
        ],
        completeness: [
            { q: 'Does it address all parts of the question or task?', weight: 0.35 },
            { q: 'Are important edge cases, failure modes, or boundary conditions considered?', weight: 0.35 },
            { q: 'Is there enough detail to justify the conclusion?', weight: 0.30 }
        ],
        clarity: [
            { q: 'Is the conclusion clearly stated and easy to locate in the response?', weight: 0.35 },
            { q: 'Are key assumptions or dependencies stated rather than left entirely implicit?', weight: 0.35 },
            { q: 'Does the response use at least one specific example, number, or piece of evidence to support its reasoning?', weight: 0.30 }
        ]
    },
    math: {
        answer_correctness: [
            { q: 'Is the final numeric answer correct and consistent with the shown derivation?', weight: 0.50 },
            { q: 'Is the answer in the expected format?', weight: 0.25 },
            { q: 'Are units correct (if applicable)?', weight: 0.25 }
        ],
        method: [
            { q: 'Is the solution approach valid for this problem?', weight: 0.35 },
            { q: 'Are the right formulas or methods used?', weight: 0.35 },
            { q: 'Are the critical calculation steps shown and numerically consistent?', weight: 0.30 }
        ],
        rigor: [
            { q: 'Are the key steps mathematically valid and free of algebraic or arithmetic contradictions?', weight: 0.40 },
            { q: 'Does the solution address any constraints or boundary conditions stated in the problem?', weight: 0.35 },
            { q: 'Is the solution complete — does it reach a final answer without leaving steps unfinished?', weight: 0.25 }
        ],
        clarity: [
            { q: 'Does each major step clearly and correctly transform from the previous one?', weight: 0.40 },
            { q: 'Are variables defined before they are used in equations?', weight: 0.30 },
            { q: 'Is notation used correctly and consistently throughout?', weight: 0.30 }
        ]
    },
    knowledge: {
        accuracy: [
            { q: 'Are the stated facts, dates, names, or numbers correct?', weight: 0.40 },
            { q: 'When claims are made about external facts, are those claims accurate? (Skip this if the response makes no factual claims.)', weight: 0.20 },
            { q: 'Does the response avoid common misconceptions or unsupported claims?', weight: 0.20 },
            { q: 'Are claims grounded in established knowledge rather than fabricated?', weight: 0.20 }
        ],
        completeness: [
            { q: 'Does the response directly answer the question? For a specific factual question (e.g., "What is X?"), a brief correct answer counts as a full answer; only mark down if the core answer is missing or wrong.', weight: 0.40 },
            { q: 'Are the key facts the question asked for present in the response? Do not penalize for omitting tangential information that was not requested.', weight: 0.35 },
            { q: 'Is the response appropriately scoped to the question — neither truncated below what is needed nor padded with irrelevant detail?', weight: 0.25 }
        ],
        clarity: [
            { q: 'Is the main answer clearly stated rather than buried in tangential detail?', weight: 0.35 },
            { q: 'Does the response use specific facts or examples rather than vague generalities?', weight: 0.35 },
            { q: 'Is the response understandable to someone without deep domain expertise?', weight: 0.30 }
        ],
        objectivity: [
            { q: 'Is the response balanced and free of unsupported personal opinions presented as fact?', weight: 0.35 },
            { q: 'Where the topic is genuinely uncertain or contested, is that uncertainty acknowledged? (Confidently stating well-established facts is correct, not a flaw — do not penalize confidence on settled facts.)', weight: 0.35 },
            { q: 'Does the response avoid hallucinating context or claiming confidence about things that are actually unknown?', weight: 0.30 }
        ]
    },
    instruction: {
        instruction_adherence: [
            { q: 'Does the response produce the exact type of output requested (e.g., list, paragraph, JSON, single word)?', weight: 0.35 },
            { q: 'Does the response address every distinct sub-task or requirement in the instruction?', weight: 0.30 },
            { q: 'When summarization or transformation is requested, are the key points preserved without adding new information?', weight: 0.20 },
            { q: 'When constraints are explicit, does the response satisfy them without speculative extras?', weight: 0.15 }
        ],
        constraint_compliance: [
            { q: 'Does the response satisfy measurable constraints (count, length, ordering, allowed language/tone)?', weight: 0.40 },
            { q: 'Does the response contain content that was explicitly forbidden?', weight: 0.35, invert: true },
            { q: 'Does the response include extra content that meaningfully violates the requested output scope?', weight: 0.25, invert: true }
        ],
        format_accuracy: [
            { q: 'Does the response use the same structural format as the expected answer?', weight: 0.50 },
            { q: 'Does the response match the requested separators, delimiters, and key names?', weight: 0.50 }
        ],
        completeness: [
            { q: 'Does the response include all required fields or sections?', weight: 0.35 },
            { q: 'Are any required output elements entirely missing from the response?', weight: 0.25, invert: true },
            { q: 'For transformation tasks, are all mandatory content elements preserved?', weight: 0.25 },
            { q: 'Is the response appropriately brief for the task and constraints?', weight: 0.15 }
        ]
    },
    creative: {
        // 0137 reword: creative prompts include narrative AND dialog / clarifying-question forms.
        // Questions now evaluate the response against the form the prompt actually requested,
        // so a well-formed dialog or Q&A reply is not penalized for lacking narrative structure.
        originality: [
            { q: 'Does the response introduce at least one idea, angle, or framing not directly stated in the prompt (including a fresh question, observation, or perspective)?', weight: 0.35 },
            { q: 'Does it avoid cliches, stock phrases, and predictable devices for the requested form?', weight: 0.35 },
            { q: 'Would removing this response leave a gap that a generic template could not fill?', weight: 0.30 }
        ],
        coherence: [
            { q: 'Is the piece logically organized for the form the prompt requested (narrative arc, dialog exchange, Q&A, or other stated structure)?', weight: 0.35 },
            { q: 'Are there any contradictions, dangling threads, or unexplained jumps?', weight: 0.35, invert: true },
            { q: 'Do transitions between ideas, lines, or scenes feel earned rather than abrupt?', weight: 0.30 }
        ],
        engagement: [
            { q: 'Does the opening line (sentence, question, or exchange) establish a clear tone or hook the reader?', weight: 0.35 },
            { q: 'Does the writing use concrete specifics (sensory detail, dialogue, examples, or pointed questions) rather than vague abstractions?', weight: 0.35 },
            { q: 'Does the piece build toward a payoff, insight, emotional beat, or useful resolution appropriate to the requested form?', weight: 0.30 }
        ],
        relevance: [
            { q: 'Does it address the specific scenario, constraints, or characters described in the prompt?', weight: 0.40 },
            { q: 'Does it stay within the genre, tone, or format requested (e.g., dialog when dialog asked for, story when story asked for)?', weight: 0.35 },
            { q: 'Does the response match the requested output form (narrative prose, dialog, clarifying questions, list, etc.) rather than defaulting to a different shape?', weight: 0.25 }
        ]
    },
    translation: {
        accuracy: [
            { q: 'Is the meaning of the original text preserved?', weight: 0.40 },
            { q: 'Are there any mistranslated words or phrases?', weight: 0.35, invert: true },
            { q: 'Are numbers, names, and technical terms correctly handled?', weight: 0.25 }
        ],
        fluency: [
            { q: 'Does the translation read naturally in the target language?', weight: 0.50 },
            { q: 'Is the sentence structure appropriate for the target language?', weight: 0.50 }
        ],
        grammar: [
            { q: 'Is the grammar correct in the target language?', weight: 0.50 },
            { q: 'Is punctuation and capitalization appropriate?', weight: 0.50 }
        ],
        cultural_fit: [
            { q: 'Are idioms and expressions adapted appropriately?', weight: 0.50 },
            { q: 'Is the tone suitable for the target audience?', weight: 0.50 }
        ]
    }
};

module.exports = { DECOMPOSED_QUESTIONS };
