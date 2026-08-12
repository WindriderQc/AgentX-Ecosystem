#!/usr/bin/env node
/**
 * Seed Judge Ground Truth Collection
 * Populates judgegroundtruths with curated prompt/response pairs and expert scores.
 *
 * Coverage: 4 entries per category × 7 categories = 28 entries
 * Each category has: 1 excellent (8-10), 1 good (6-7), 1 mediocre (3-5), 1 poor (0-2)
 *
 * Usage: node scripts/seed-judge-ground-truth.js [--force]
 *   --force: Drop existing entries before seeding
 */

'use strict';

const mongoose = require('mongoose');
const connectDB = require('../config/db');

// Must register model before use
require('../models/JudgeGroundTruth');
const JudgeGroundTruth = mongoose.model('JudgeGroundTruth');

const ENTRIES = [
    // ── CODING ──────────────────────────────────────────────
    {
        name: 'coding-excellent-sum',
        category: 'coding',
        difficulty: 1,
        prompt: 'Write a function that takes an array of numbers and returns their sum.',
        expected_answer: 'A function that iterates through array elements and accumulates their sum.',
        response: `function sum(numbers) {
  if (!Array.isArray(numbers)) return 0;
  return numbers.reduce((acc, n) => acc + (typeof n === 'number' && !isNaN(n) ? n : 0), 0);
}`,
        expert_scores: {
            overall: 9.5,
            dimensions: { correctness: 10, clarity: 9, efficiency: 10, robustness: 9 }
        },
        expert_rationale: 'Correct reduce-based solution, handles non-number inputs, descriptive naming. Minor: could document the NaN guard.',
        tags: ['level-1', 'excellent']
    },
    {
        name: 'coding-good-fizzbuzz',
        category: 'coding',
        difficulty: 2,
        prompt: 'Write a FizzBuzz function that returns an array of results for numbers 1 to n.',
        expected_answer: 'Function returning array where multiples of 3 are "Fizz", multiples of 5 are "Buzz", both are "FizzBuzz", otherwise the number.',
        response: `function fizzBuzz(n) {
  const result = [];
  for (let i = 1; i <= n; i++) {
    if (i % 15 === 0) result.push("FizzBuzz");
    else if (i % 3 === 0) result.push("Fizz");
    else if (i % 5 === 0) result.push("Buzz");
    else result.push(i);
  }
  return result;
}`,
        expert_scores: {
            overall: 7.0,
            dimensions: { correctness: 10, clarity: 7, efficiency: 8, robustness: 3 }
        },
        expert_rationale: 'Correct logic and output. Clear structure. No input validation — negative n or non-integer causes silent wrong output. No edge case handling.',
        tags: ['level-2', 'good']
    },
    {
        name: 'coding-mediocre-sort',
        category: 'coding',
        difficulty: 3,
        prompt: 'Write a function to sort an array of objects by a given key.',
        expected_answer: 'Generic sort function accepting array and key, handling string/number comparison.',
        response: `function sortByKey(arr, key) {
  return arr.sort((a, b) => a[key] > b[key] ? 1 : -1);
}`,
        expert_scores: {
            overall: 4.5,
            dimensions: { correctness: 5, clarity: 6, efficiency: 5, robustness: 2 }
        },
        expert_rationale: 'Mutates input array (should copy). No null/undefined handling. Equality case returns -1 (unstable). Does not handle mixed types. Works only for simple cases.',
        tags: ['level-3', 'mediocre']
    },
    {
        name: 'coding-poor-regex',
        category: 'coding',
        difficulty: 4,
        prompt: 'Write a function to validate email addresses using a regular expression.',
        expected_answer: 'Function with reasonable regex covering common email formats, returns boolean.',
        response: `function validateEmail(email) {
  if (email.includes("@")) return true;
  return false;
}`,
        expert_scores: {
            overall: 1.5,
            dimensions: { correctness: 1, clarity: 4, efficiency: 5, robustness: 0 }
        },
        expert_rationale: 'Does not use regex as requested. Accepts "@@" or "@" alone. No domain validation. Readable but fundamentally wrong approach.',
        tags: ['level-4', 'poor']
    },

    // ── REASONING ───────────────────────────────────────────
    {
        name: 'reasoning-excellent-syllogism',
        category: 'reasoning',
        difficulty: 1,
        prompt: 'If all cats are animals, and some animals are pets, can we conclude all cats are pets? Explain briefly.',
        expected_answer: 'No, we cannot conclude all cats are pets. While all cats are animals, only SOME animals are pets.',
        response: 'No. The premises tell us cats ⊂ animals and pets ∩ animals ≠ ∅. This does not entail cats ⊆ pets — the set of pets could exclude all cats without contradiction. The fallacy is "undistributed middle": knowing some animals are pets says nothing about which animals.',
        expert_scores: {
            overall: 9.0,
            dimensions: { accuracy: 10, logic_soundness: 10, completeness: 7, clarity: 9 }
        },
        expert_rationale: 'Correct conclusion with formal set notation, identifies the fallacy by name. Could mention a concrete counterexample for completeness.',
        tags: ['level-1', 'excellent']
    },
    {
        name: 'reasoning-good-sequence',
        category: 'reasoning',
        difficulty: 2,
        prompt: 'What comes next: 1, 1, 2, 3, 5, 8, ?',
        expected_answer: '13. This is the Fibonacci sequence where each number is the sum of the two preceding.',
        response: 'The next number is 13. Each number is the sum of the previous two numbers (5 + 8 = 13). This is the Fibonacci sequence.',
        expert_scores: {
            overall: 7.5,
            dimensions: { accuracy: 10, logic_soundness: 8, completeness: 5, clarity: 8 }
        },
        expert_rationale: 'Correct answer and identification. Shows one step of reasoning. Does not verify the pattern across earlier terms or discuss edge cases.',
        tags: ['level-2', 'good']
    },
    {
        name: 'reasoning-mediocre-probability',
        category: 'reasoning',
        difficulty: 3,
        prompt: 'You flip a fair coin 3 times. What is the probability of getting exactly 2 heads?',
        expected_answer: '3/8. There are 8 total outcomes (2^3), and 3 have exactly 2 heads: HHT, HTH, THH.',
        response: 'The probability is 50% because with 3 flips you are likely to get about half heads and half tails.',
        expert_scores: {
            overall: 2.0,
            dimensions: { accuracy: 0, logic_soundness: 2, completeness: 2, clarity: 5 }
        },
        expert_rationale: 'Wrong answer (37.5% not 50%). Reasoning is intuitive hand-waving, not combinatorial. Does not enumerate outcomes or use binomial formula. At least coherent English.',
        tags: ['level-3', 'mediocre']
    },
    {
        name: 'reasoning-poor-logic',
        category: 'reasoning',
        difficulty: 4,
        prompt: 'A farmer has 17 sheep. All but 9 die. How many sheep does the farmer have left?',
        expected_answer: '9. "All but 9 die" means 9 survive.',
        response: 'The farmer has 8 sheep left. 17 - 9 = 8.',
        expert_scores: {
            overall: 1.0,
            dimensions: { accuracy: 0, logic_soundness: 0, completeness: 3, clarity: 6 }
        },
        expert_rationale: 'Classic trick question failed. Subtracted instead of understanding "all but 9". Arithmetic is correct for the wrong interpretation. Clear but wrong.',
        tags: ['level-4', 'poor']
    },

    // ── MATH ────────────────────────────────────────────────
    {
        name: 'math-excellent-series',
        category: 'math',
        difficulty: 2,
        prompt: 'What is the sum of all integers from 1 to 100?',
        expected_answer: '5050. Using the formula n(n+1)/2 = 100*101/2 = 5050.',
        response: 'Using the arithmetic series formula: S = n(n+1)/2\nS = 100 × 101 / 2\nS = 10100 / 2\nS = 5050\n\nThe sum of all integers from 1 to 100 is 5050.',
        expert_scores: {
            overall: 9.5,
            dimensions: { answer_correctness: 10, method: 10, rigor: 8, clarity: 10 }
        },
        expert_rationale: 'Correct answer, correct formula, clear step-by-step. Could prove why the formula works for full rigor.',
        tags: ['level-2', 'excellent']
    },
    {
        name: 'math-good-percentage',
        category: 'math',
        difficulty: 1,
        prompt: 'A shirt costs $80 and is on sale for 25% off. What is the sale price?',
        expected_answer: '$60. Discount = 80 × 0.25 = $20. Sale price = 80 − 20 = $60.',
        response: '80 × 0.75 = $60',
        expert_scores: {
            overall: 7.0,
            dimensions: { answer_correctness: 10, method: 7, rigor: 4, clarity: 6 }
        },
        expert_rationale: 'Correct answer. Shortcut method (multiply by complement) is valid but skips showing the discount step. No units on intermediate value.',
        tags: ['level-1', 'good']
    },
    {
        name: 'math-mediocre-algebra',
        category: 'math',
        difficulty: 3,
        prompt: 'Solve for x: 3x + 7 = 22',
        expected_answer: 'x = 5. Subtract 7: 3x = 15. Divide by 3: x = 5.',
        response: '3x + 7 = 22\n3x = 15\nx = 15/3\nx = 5\n\nWait, let me double check: 3(5) + 7 = 22. Yes, x = 5.',
        expert_scores: {
            overall: 6.0,
            dimensions: { answer_correctness: 10, method: 7, rigor: 4, clarity: 3 }
        },
        expert_rationale: 'Correct answer with verification. But "Wait, let me double check" is thinking-out-loud noise. Steps skip explaining subtraction of 7. Verification is good practice but presentation is messy.',
        tags: ['level-3', 'mediocre']
    },
    {
        name: 'math-poor-fractions',
        category: 'math',
        difficulty: 3,
        prompt: 'What is 1/3 + 1/4?',
        expected_answer: '7/12. Common denominator is 12: 4/12 + 3/12 = 7/12.',
        response: '1/3 + 1/4 = 2/7',
        expert_scores: {
            overall: 0.5,
            dimensions: { answer_correctness: 0, method: 0, rigor: 0, clarity: 3 }
        },
        expert_rationale: 'Wrong answer. Added numerators and denominators separately (1+1)/(3+4) — a fundamental fraction error. No work shown.',
        tags: ['level-3', 'poor']
    },

    // ── KNOWLEDGE ───────────────────────────────────────────
    {
        name: 'knowledge-excellent-api-sdk',
        category: 'knowledge',
        difficulty: 1,
        prompt: 'Explain the difference between an API and an SDK in 3-4 simple sentences.',
        expected_answer: 'An API is a set of rules for how software communicates. An SDK is a toolkit that includes APIs plus tools, docs, and libraries.',
        response: 'An API (Application Programming Interface) defines a contract: the endpoints, parameters, and data formats one program uses to talk to another. An SDK (Software Development Kit) is a package that bundles one or more API clients together with helper libraries, documentation, and sometimes code generators to speed up integration. Think of the API as a restaurant menu and the SDK as the full meal kit with utensils. You can call an API directly with HTTP, but an SDK saves you from writing boilerplate.',
        expert_scores: {
            overall: 9.0,
            dimensions: { accuracy: 10, completeness: 9, clarity: 9, objectivity: 8 }
        },
        expert_rationale: 'Accurate definitions, good analogy, appropriate scope. Uses concrete example (HTTP). Minor: "code generators" is SDK-specific, not universal.',
        tags: ['level-1', 'excellent']
    },
    {
        name: 'knowledge-good-capital',
        category: 'knowledge',
        difficulty: 1,
        prompt: 'What is the capital of Australia?',
        expected_answer: 'Canberra.',
        response: 'The capital of Australia is Canberra, which was purpose-built as the capital in the early 20th century to resolve the rivalry between Sydney and Melbourne.',
        expert_scores: {
            overall: 8.5,
            dimensions: { accuracy: 10, completeness: 8, clarity: 8, objectivity: 8 }
        },
        expert_rationale: 'Correct with helpful context about why Canberra was chosen. Does not overstate or hallucinate.',
        tags: ['level-1', 'good']
    },
    {
        name: 'knowledge-mediocre-bigo',
        category: 'knowledge',
        difficulty: 2,
        prompt: 'Explain Big-O notation for a beginner and give two concrete examples.',
        expected_answer: 'Big-O describes how an algorithm\'s time or space grows with input size. O(1) is constant, O(n) is linear.',
        response: 'Big-O notation is used in computer science to measure how fast an algorithm is. O(n) means it takes n steps. O(n^2) means it takes n squared steps. It helps you compare algorithms.',
        expert_scores: {
            overall: 4.5,
            dimensions: { accuracy: 5, completeness: 4, clarity: 6, objectivity: 5 }
        },
        expert_rationale: '"Measure how fast" is imprecise — it measures growth rate, not absolute speed. "Takes n steps" conflates operations with steps. No concrete code examples as requested. Misses O(1) which is the most beginner-relevant case.',
        tags: ['level-2', 'mediocre']
    },
    {
        name: 'knowledge-poor-html',
        category: 'knowledge',
        difficulty: 2,
        prompt: 'What is the difference between HTML and CSS?',
        expected_answer: 'HTML defines page structure and content. CSS controls visual presentation and styling.',
        response: 'HTML and CSS are both programming languages used to make websites. HTML is for the backend and CSS is for the frontend.',
        expert_scores: {
            overall: 1.5,
            dimensions: { accuracy: 1, completeness: 2, clarity: 4, objectivity: 1 }
        },
        expert_rationale: 'Neither is a programming language (markup/stylesheet). HTML is not "backend". CSS is not exclusively "frontend" in the described sense. Fundamentally confused about what each technology does.',
        tags: ['level-2', 'poor']
    },

    // ── INSTRUCTION ─────────────────────────────────────────
    {
        name: 'instruction-excellent-json',
        category: 'instruction',
        difficulty: 1,
        prompt: 'Output the JSON array [true,false,null] exactly, with no spaces or newlines.',
        expected_answer: '[true,false,null]',
        response: '[true,false,null]',
        expert_scores: {
            overall: 10.0,
            dimensions: { instruction_adherence: 10, constraint_compliance: 10, format_accuracy: 10, completeness: 10 }
        },
        expert_rationale: 'Exact match. No extra text, no formatting, perfect compliance.',
        tags: ['level-1', 'excellent']
    },
    {
        name: 'instruction-good-bullets',
        category: 'instruction',
        difficulty: 2,
        prompt: 'Provide three bullet points using a "-" prefix. Each bullet must be a single word. The words must start with A, B, C respectively.',
        expected_answer: '- Apple\n- Banana\n- Cherry',
        response: '- Apple\n- Blueberry\n- Cherry',
        expert_scores: {
            overall: 8.0,
            dimensions: { instruction_adherence: 8, constraint_compliance: 9, format_accuracy: 10, completeness: 10 }
        },
        expert_rationale: 'Meets all structural requirements. "Blueberry" is arguably not a single word (compound), but commonly accepted. Format perfect.',
        tags: ['level-2', 'good']
    },
    {
        name: 'instruction-mediocre-summary',
        category: 'instruction',
        difficulty: 3,
        prompt: 'Summarize the following in exactly 2 sentences: "The quick brown fox jumps over the lazy dog. The dog did not react. The fox continued running through the forest until sunset."',
        expected_answer: 'Two sentences capturing the fox jumping over the dog and continuing to run.',
        response: 'A fox jumped over a lazy dog who did not react. The fox then ran through the forest. It was a peaceful scene.',
        expert_scores: {
            overall: 3.5,
            dimensions: { instruction_adherence: 3, constraint_compliance: 2, format_accuracy: 3, completeness: 6 }
        },
        expert_rationale: 'Three sentences, not two as required. Added "peaceful scene" which is not in the source text. Content is roughly correct but constraint violated.',
        tags: ['level-3', 'mediocre']
    },
    {
        name: 'instruction-poor-word',
        category: 'instruction',
        difficulty: 1,
        prompt: 'Reply with the word ALPHA in all caps. Do not add punctuation, spaces, or newlines.',
        expected_answer: 'ALPHA',
        response: 'Sure! The word is: ALPHA.',
        expert_scores: {
            overall: 1.0,
            dimensions: { instruction_adherence: 2, constraint_compliance: 0, format_accuracy: 0, completeness: 2 }
        },
        expert_rationale: 'Contains the word but violates every constraint: added preamble, colon, period. The instruction was to output ONLY the word.',
        tags: ['level-1', 'poor']
    },

    // ── CREATIVE ────────────────────────────────────────────
    {
        name: 'creative-excellent-metaphor',
        category: 'creative',
        difficulty: 1,
        prompt: 'Write a single metaphor comparing time to a river.',
        expected_answer: 'A metaphor that compares time to a river in a creative and coherent way.',
        response: 'Time is a river that never reverses its current — you can stand in it, but every second you feel is already downstream, pooling in a delta of memory you can visit but never re-enter.',
        expert_scores: {
            overall: 9.0,
            dimensions: { originality: 9, coherence: 10, engagement: 9, relevance: 10 }
        },
        expert_rationale: 'Extended metaphor with delta/memory imagery. "Re-enter" is philosophically resonant. Avoids cliché "flows" phrasing. One sentence as requested.',
        tags: ['level-1', 'excellent']
    },
    {
        name: 'creative-good-tagline',
        category: 'creative',
        difficulty: 1,
        prompt: 'Create a catchy tagline for a coffee shop.',
        expected_answer: 'Any creative, memorable tagline related to coffee.',
        response: 'Life happens. Coffee helps.',
        expert_scores: {
            overall: 7.0,
            dimensions: { originality: 6, coherence: 8, engagement: 8, relevance: 8 }
        },
        expert_rationale: 'Punchy rhythm, relatable. But "Life happens" is a common phrase (bumper sticker territory). Functional but not distinctive.',
        tags: ['level-1', 'good']
    },
    {
        name: 'creative-mediocre-story',
        category: 'creative',
        difficulty: 2,
        prompt: 'Write a 3-sentence horror story.',
        expected_answer: 'A brief horror story with buildup and a frightening twist.',
        response: 'It was a dark and stormy night. A man heard a noise in his house. He was scared.',
        expert_scores: {
            overall: 2.5,
            dimensions: { originality: 1, coherence: 5, engagement: 2, relevance: 5 }
        },
        expert_rationale: 'Opens with the most clichéd line in fiction. No twist, no tension, no sensory detail. Tells emotion ("scared") instead of showing it. Technically 3 sentences about horror.',
        tags: ['level-2', 'mediocre']
    },
    {
        name: 'creative-poor-poem',
        category: 'creative',
        difficulty: 2,
        prompt: 'Write a haiku about autumn.',
        expected_answer: 'A 5-7-5 syllable poem about autumn.',
        response: 'Autumn is here now\nThe leaves are falling from trees\nIt is very cold and windy outside today',
        expert_scores: {
            overall: 1.5,
            dimensions: { originality: 1, coherence: 3, engagement: 1, relevance: 4 }
        },
        expert_rationale: 'Third line violates 5-syllable constraint (~12 syllables). No imagery — purely declarative. "Very cold and windy" is generic weather reporting, not poetry.',
        tags: ['level-2', 'poor']
    },

    // ── TRANSLATION ─────────────────────────────────────────
    {
        name: 'translation-excellent-french',
        category: 'translation',
        difficulty: 1,
        prompt: 'Translate to French: "Where is the station?"',
        expected_answer: 'Où est la gare ?',
        response: 'Où est la gare ?',
        expert_scores: {
            overall: 10.0,
            dimensions: { accuracy: 10, fluency: 10, grammar: 10, cultural_fit: 10 }
        },
        expert_rationale: 'Perfect translation. Natural phrasing, correct French punctuation with space before question mark.',
        tags: ['level-1', 'excellent']
    },
    {
        name: 'translation-good-spanish',
        category: 'translation',
        difficulty: 2,
        prompt: 'Translate to Spanish: "I called you yesterday, but you were at work."',
        expected_answer: 'Te llamé ayer, pero estabas en el trabajo.',
        response: 'Te llamé ayer, pero estabas trabajando.',
        expert_scores: {
            overall: 7.5,
            dimensions: { accuracy: 7, fluency: 9, grammar: 10, cultural_fit: 7 }
        },
        expert_rationale: '"Estabas trabajando" (you were working) vs "estabas en el trabajo" (you were at work) — subtle meaning shift. Grammatically perfect, natural Spanish. Slight semantic deviation.',
        tags: ['level-2', 'good']
    },
    {
        name: 'translation-mediocre-german',
        category: 'translation',
        difficulty: 3,
        prompt: 'Translate to German: "The early bird catches the worm."',
        expected_answer: 'Der frühe Vogel fängt den Wurm. (or the German proverb: Morgenstund hat Gold im Mund.)',
        response: 'Der frühe Vogel fängt den Wurm.',
        expert_scores: {
            overall: 5.0,
            dimensions: { accuracy: 7, fluency: 5, grammar: 8, cultural_fit: 2 }
        },
        expert_rationale: 'Literal translation is grammatically correct but misses the German equivalent proverb "Morgenstund hat Gold im Mund" which would be culturally appropriate. A good translator adapts idioms.',
        tags: ['level-3', 'mediocre']
    },
    {
        name: 'translation-poor-japanese',
        category: 'translation',
        difficulty: 3,
        prompt: 'Translate to Japanese: "Thank you very much for your help."',
        expected_answer: 'ご協力いただきありがとうございます。 or お手伝いいただき誠にありがとうございます。',
        response: 'ありがとう。',
        expert_scores: {
            overall: 2.0,
            dimensions: { accuracy: 2, fluency: 5, grammar: 5, cultural_fit: 0 }
        },
        expert_rationale: '"ありがとう" is casual thanks — drops "very much" and "for your help" entirely. In Japanese culture, the formality level matters enormously. This is inappropriate for a polite/formal context.',
        tags: ['level-3', 'poor']
    }
];

async function seed(force = false) {
    await connectDB();

    if (force) {
        const deleted = await JudgeGroundTruth.deleteMany({});
        console.log(`Cleared ${deleted.deletedCount} existing ground truth entries`);
    }

    let created = 0;
    let skipped = 0;

    for (const entry of ENTRIES) {
        const existing = await JudgeGroundTruth.findOne({ name: entry.name });
        if (existing) {
            skipped++;
            continue;
        }

        await JudgeGroundTruth.create({
            ...entry,
            created_by: 'seed-script',
            active: true
        });
        created++;
    }

    console.log(`Seeded ${created} entries, skipped ${skipped} existing`);

    // Summary by category
    const summary = await JudgeGroundTruth.aggregate([
        { $match: { active: true } },
        { $group: { _id: '$category', count: { $sum: 1 }, avg_score: { $avg: '$expert_scores.overall' } } },
        { $sort: { _id: 1 } }
    ]);

    console.log('\nGround truth coverage:');
    for (const cat of summary) {
        console.log(`  ${cat._id}: ${cat.count} entries, avg expert score: ${cat.avg_score.toFixed(1)}`);
    }

    await mongoose.disconnect();
}

const force = process.argv.includes('--force');
seed(force).catch(err => {
    console.error('Seed failed:', err);
    process.exit(1);
});
