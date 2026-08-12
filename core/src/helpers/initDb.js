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
