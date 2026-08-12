/**
 * Chat Prompt Helpers
 * System prompt assembly and active prompt resolution.
 */

const PromptConfig = require('../../../models/PromptConfig');
const logger = require('../../../config/logger');
const { isRemovedPersona } = require('../personaDisposition');

// Get active prompt config for a persona.
const getActivePrompt = async (system, personaName = 'default_chat', options = {}) => {
    if (options.preferSystem === true && typeof system === 'string' && system.trim()) {
        return {
            systemPrompt: system.trim(),
            version: 'request-override',
            name: personaName || 'default_chat',
            _id: null
        };
    }

    try {
        if (isRemovedPersona(personaName)) {
            personaName = 'default_chat';
        }

        const activePrompt = await PromptConfig.getActive(personaName);
        if (activePrompt) return activePrompt;

        if (personaName !== 'default_chat') {
            const defaultPrompt = await PromptConfig.getActive('default_chat');
            if (defaultPrompt) return defaultPrompt;
        }
    } catch (err) {
        logger.warn('Failed to fetch active prompt, falling back to default', { error: err.message });
    }

    return {
        systemPrompt: system || 'You are AgentX, a helpful AI assistant.',
        version: 'default',
        name: 'default_chat',
        _id: null
    };
};

// Build effective system prompt with RAG context and user profile
const buildSystemPrompt = (basePrompt, userProfile, ragContext) => {
    let effectiveSystemPrompt = basePrompt;

    if (ragContext) {
        effectiveSystemPrompt += `\n\n=== RETRIEVED CONTEXT ===\nYou have access to the following retrieved context from the user's files. \nCRITICAL INSTRUCTION: The user's question is likely about the data contained in this context. \n- If the context contains a list of "Available Ingested Documents", and the user asks what files are ingested, LIST THEM.\n- If the context contains JSON or structured data, READ IT CAREFULLY to find the specific value requested (e.g., "totalFiles", counts, names).\n- Answer the question DIRECTLY using the data found.\n- Cite the source file name.\n\n${ragContext}\n\n=== END CONTEXT ===`;
    }

    if (userProfile.about) {
        effectiveSystemPrompt += `\n\nUser Profile/Memory:\n${userProfile.about}`;
    }
    if (userProfile.preferences?.customInstructions) {
        effectiveSystemPrompt += `\n\nCustom Instructions:\n${userProfile.preferences.customInstructions}`;
    }

    return effectiveSystemPrompt;
};

module.exports = { getActivePrompt, buildSystemPrompt };
