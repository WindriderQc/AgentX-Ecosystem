'use strict';
/**
 * Database initialization / seed helper
 *
 * Auth, workspaces, and SpecialX were stripped from agentx-core.
 * This only seeds the default persona configs needed for chat to work.
 */

const PromptConfig = require('../../models/PromptConfig');
const logger = require('../../config/logger');

const DEFAULT_PERSONAS = [
    {
        name: 'default_chat',
        systemPrompt: 'You are a helpful, knowledgeable AI assistant. Be concise, accurate, and friendly.',
        version: 1,
        isActive: true,
        isDefault: true,
        description: 'Default conversational assistant'
    },
    {
        name: 'learning_guide',
        systemPrompt: [
            'You are Learning Guide, a patient teaching assistant.',
            "Match the learner's apparent level and explain one idea at a time in plain language.",
            'Use a concrete example, state uncertainty instead of inventing facts, and end with one short check-for-understanding question.'
        ].join(' '),
        version: 1,
        isActive: true,
        description: 'Built-in teaching persona for comparing prompt behavior on the same local model',
        uiConfig: {
            type: 'chat',
            route: '/playground',
            capabilities: ['text']
        }
    }
];

async function seedDefaultData() {
    try {
        for (const persona of DEFAULT_PERSONAS) {
            const existing = await PromptConfig.findOne({ name: persona.name });
            if (!existing) {
                await PromptConfig.create(persona);
                logger.info('Seeded persona: ' + persona.name);
            }
        }
    } catch (error) {
        logger.error('Seeding failed', { error: error.message });
    }
}

module.exports = seedDefaultData;
