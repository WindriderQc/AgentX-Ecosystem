'use strict';

const TASK_TYPE_METADATA = Object.freeze({
  quick_chat: { title: 'Quick Chat', description: 'Fast greetings, light conversation, and short factual replies.' },
  general_chat: { title: 'General Chat', description: 'Broader explanations, advice, and everyday knowledge work.' },
  code_generation: { title: 'Code Generation', description: 'Implementation requests, scaffolding, and writing new code.' },
  code_review: { title: 'Code Review', description: 'Bug hunting, critique, and improvement suggestions for existing code.' },
  deep_reasoning: { title: 'Deep Reasoning', description: 'Complex multi-step logic and planning routed to the configured high-capacity model.' },
  master_brain: { title: 'Master Brain', description: 'Maximum-intelligence routing for strategic, ambiguous, or high-stakes reasoning where quality matters more than latency.' },
  analysis: { title: 'Analysis', description: 'Comparisons, document breakdowns, and structured analytical work.' },
  summarization: { title: 'Summarization', description: 'Condensing source material into concise takeaways.' },
  translation: { title: 'Translation', description: 'Language conversion and light localization tasks.' },
  rag_query_expansion: { title: 'RAG Query Expansion', description: 'Generate alternate search phrasings before retrieval.' },
  rag_reranking: { title: 'RAG Re-Ranking', description: 'Score retrieved chunks for final relevance ordering.' },
  rag_compression: { title: 'RAG Compression', description: 'Extract only the most relevant sentences from retrieved chunks.' },
  buddy_reaction: { title: 'Buddy Reaction', description: 'Short 1-2 sentence companion quips reacting to platform events.' },
  buddy_chat: { title: 'Buddy Chat', description: 'Multi-turn companion chat through Buddy with full response metadata.' },
  voice_persona_chat: { title: 'Voice Persona Chat', description: 'Interactive Core-hosted voice assistant turns routed from file-backed persona packs.' },
  voice_persona_reader: { title: 'Voice Persona Reader', description: 'Low-latency kid reading-aid turns from the KidX Lecteur persona pack.' },
  janitor_ai: { title: 'Janitor AI', description: 'Disk janitor advisory reasoning for storage cleanup workflows.' },
  embeddings: { title: 'Embeddings', description: 'Vectorization requests for retrieval and similarity workflows.' },
  daily_operator: { title: 'Daily Operator', description: 'Direct-only external automation lane; hidden from user auto-routing.' },
  nestor_answer_light: { title: 'Nestor Answer Light', description: 'Low-latency local Nestor answers on the dedicated pinned model and host.' }
});

const ROUTING_EXPLAINER_STEPS = Object.freeze([
  'Your prompt enters the chat API with either auto-routing enabled or an explicit task type.',
  'A lightweight classifier maps the prompt to one routing category.',
  'That category resolves to a model and preferred host based on the current task map.',
  'The inference request runs on the selected host and the response carries routing metadata back to the UI.'
]);

const CLASSIFICATION_PROMPT = `You are a query classifier. Classify the user's query into exactly one category.

Categories:
- quick_chat: Simple greetings, small talk, basic questions with short answers
- general_chat: General knowledge questions, explanations, advice
- code_generation: Write code, implement features, create functions/classes
- code_review: Review code, find bugs, suggest improvements
- deep_reasoning: Complex multi-step problems, math, logic puzzles
- master_brain: Highest-stakes strategy, architecture, ambiguous synthesis, or requests where maximum intelligence matters more than latency
- analysis: Analyze data, documents, compare things, detailed breakdowns
- summarization: Summarize text, condense information
- translation: Translate between languages

Respond with ONLY the category name, nothing else.

User query: `;

module.exports = {
  TASK_TYPE_METADATA,
  ROUTING_EXPLAINER_STEPS,
  CLASSIFICATION_PROMPT
};
