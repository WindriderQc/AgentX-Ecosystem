/**
 * Chat Prompt Helpers
 * System prompt assembly and active prompt resolution.
 */

const PromptConfig = require('../../../models/PromptConfig');
const logger = require('../../../config/logger');
const { isRemovedPersona } = require('../personaDisposition');

function requestedPromptVersion(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        const error = new Error('promptVersion must be a positive integer');
        error.statusCode = 400;
        error.code = 'INVALID_PROMPT_VERSION';
        throw error;
    }
    return parsed;
}

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

    const exactVersion = requestedPromptVersion(options.promptVersion);
    if (exactVersion !== null) {
        if (isRemovedPersona(personaName)) {
            const error = new Error('The requested persona is not available for chat');
            error.statusCode = 404;
            error.code = 'PROMPT_VERSION_UNAVAILABLE';
            throw error;
        }
        try {
            const exactPrompt = await PromptConfig.findOne({ name: personaName, version: exactVersion });
            if (exactPrompt) return exactPrompt;
        } catch (error) {
            if (error.code === 'PROMPT_VERSION_UNAVAILABLE') throw error;
            const unavailable = new Error('Exact prompt evidence is unavailable');
            unavailable.statusCode = 503;
            unavailable.code = 'PROMPT_EVIDENCE_UNAVAILABLE';
            unavailable.cause = error;
            throw unavailable;
        }
        const error = new Error(`Prompt ${personaName} v${exactVersion} was not found`);
        error.statusCode = 404;
        error.code = 'PROMPT_VERSION_UNAVAILABLE';
        throw error;
    }

    try {
        if (isRemovedPersona(personaName)) personaName = 'default_chat';

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

module.exports = { getActivePrompt, buildSystemPrompt, requestedPromptVersion };
