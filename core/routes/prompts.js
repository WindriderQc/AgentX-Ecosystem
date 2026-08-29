/**
 * Prompt Management Routes
 * CRUD operations for prompts with A/B testing support
 */

const express = require('express');
const router = express.Router();
const PromptConfig = require('../models/PromptConfig');
const logger = require('../config/logger');
const { validateObjectId } = require('../src/helpers/objectIdValidator');
const { classifyPersona, isRemovedPersona } = require('../src/services/personaDisposition');
const { requireTypedConfirmation } = require('../src/helpers/typedConfirmation');

const MAX_PROMPT_NAME_LENGTH = 120;
const MAX_PROMPT_DESCRIPTION_LENGTH = 500;
const MAX_VERSION_ALLOCATION_ATTEMPTS = 3;
const VERSION_ALLOCATION_CONFLICT_MESSAGE = 'Could not allocate a prompt version because of concurrent updates. Please retry.';

function validateCreatePromptBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { error: 'Request body must be a JSON object' };
    }

    if (typeof body.name !== 'string' || !body.name.trim()) {
        return { error: 'name must be a non-empty string' };
    }
    const name = body.name.trim();
    if (name.length > MAX_PROMPT_NAME_LENGTH) {
        return { error: `name must be ${MAX_PROMPT_NAME_LENGTH} characters or fewer` };
    }

    if (typeof body.systemPrompt !== 'string' || !body.systemPrompt.trim()) {
        return { error: 'systemPrompt must be a non-empty string' };
    }

    let description;
    if (body.description !== undefined) {
        if (typeof body.description !== 'string') {
            return { error: 'description must be a string' };
        }
        description = body.description.trim();
        if (description.length > MAX_PROMPT_DESCRIPTION_LENGTH) {
            return { error: `description must be ${MAX_PROMPT_DESCRIPTION_LENGTH} characters or fewer` };
        }
    }

    const isActive = body.isActive === undefined ? false : body.isActive;
    if (typeof isActive !== 'boolean') {
        return { error: 'isActive must be a boolean' };
    }

    const trafficWeight = body.trafficWeight === undefined ? 100 : body.trafficWeight;
    if (typeof trafficWeight !== 'number'
        || !Number.isFinite(trafficWeight)
        || trafficWeight < 0
        || trafficWeight > 100) {
        return { error: 'trafficWeight must be a number between 0 and 100' };
    }

    return {
        value: {
            name,
            systemPrompt: body.systemPrompt,
            description,
            isActive,
            trafficWeight
        }
    };
}

async function createPromptVersion({ name, systemPrompt, description, isActive, trafficWeight }) {
    for (let attempt = 1; attempt <= MAX_VERSION_ALLOCATION_ATTEMPTS; attempt += 1) {
        const existing = await PromptConfig.findOne({ name }).sort({ version: -1 });
        const newVersion = existing ? existing.version + 1 : 1;
        const prompt = new PromptConfig({
            name,
            systemPrompt,
            description: description || `${name} v${newVersion}`,
            version: newVersion,
            isActive,
            trafficWeight
        });

        try {
            await prompt.save();
            return prompt;
        } catch (err) {
            if (err?.code !== 11000) throw err;
        }
    }

    const error = new Error(VERSION_ALLOCATION_CONFLICT_MESSAGE);
    error.code = 'PROMPT_VERSION_ALLOCATION_CONFLICT';
    throw error;
}

function serializePrompt(prompt) {
    const obj = prompt.toObject ? prompt.toObject() : prompt;
    return {
        _id: obj._id,
        name: obj.name,
        version: obj.version,
        systemPrompt: obj.systemPrompt,
        isActive: obj.isActive,
        trafficWeight: obj.trafficWeight,
        description: obj.description,
        stats: obj.stats,
        uiConfig: obj.uiConfig,
        disposition: classifyPersona(obj),
        createdAt: obj.createdAt,
        updatedAt: obj.updatedAt
    };
}

/**
 * GET /api/prompts
 * List all prompts (grouped by name) */
router.get('/', async (req, res) => {
    try {
        const query = {};
        const includeRemoved = req.query.includeRemoved === 'true';

        const prompts = await PromptConfig.find(query).sort({ name: 1, version: -1 });

        // Group by name
        const grouped = {};
        prompts.forEach(p => {
            if (!includeRemoved && isRemovedPersona(p.name)) return;
            if (!grouped[p.name]) grouped[p.name] = [];
            grouped[p.name].push(serializePrompt(p));
        });

        res.json({
            status: 'success',
            data: grouped
        });
    } catch (err) {
        logger.error('List prompts error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * GET /api/prompts/:name
 * Get all versions of a prompt */
router.get('/:name', async (req, res) => {
    try {
        const name = req.params.name;
        const includeRemoved = req.query.includeRemoved === 'true';

        if (isRemovedPersona(name) && !includeRemoved) {
            return res.status(410).json({
                status: 'error',
                message: 'Persona has been removed from the runtime'
            });
        }

        const query = { name };

        const prompts = await PromptConfig.find(query).sort({ version: -1 });

        if (prompts.length === 0) {
            // The chat UI polls for default_chat during init; returning a 404 is noisy and not actionable.
            // Treat "missing default" as a valid state.
            if (name === 'default_chat') {
                return res.json({ status: 'success', data: [] });
            }
            return res.status(404).json({ status: 'error', message: 'Prompt not found' });
        }

        res.json({
            status: 'success',
            data: prompts.map(serializePrompt)
        });
    } catch (err) {
        logger.error('Get prompt error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * POST /api/prompts
 * Create a new prompt or new version * Body: { name, systemPrompt, description?, isActive?, trafficWeight? }
 */
router.post('/', async (req, res) => {
    const validation = validateCreatePromptBody(req.body);
    if (validation.error) {
        return res.status(400).json({ status: 'error', message: validation.error });
    }
    const { name, systemPrompt, description, isActive, trafficWeight } = validation.value;

    if (isRemovedPersona(name)) {
        return res.status(410).json({
            status: 'error',
            message: 'This persona name has been removed from the runtime'
        });
    }

    try {
        const prompt = await createPromptVersion({
            name,
            systemPrompt,
            description,
            isActive,
            trafficWeight
        });

        logger.info('Prompt created', { name, version: prompt.version });

        res.status(201).json({
            status: 'success',
            data: serializePrompt(prompt)
        });
    } catch (err) {
        if (err?.code === 'PROMPT_VERSION_ALLOCATION_CONFLICT') {
            logger.warn('Prompt version allocation conflict', {
                name,
                attempts: MAX_VERSION_ALLOCATION_ATTEMPTS
            });
            return res.status(409).json({
                status: 'error',
                message: VERSION_ALLOCATION_CONFLICT_MESSAGE
            });
        }
        logger.error('Create prompt error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * PUT /api/prompts/:id
 * Update a prompt (not the systemPrompt - create new version for that) * Body: { isActive?, trafficWeight?, description? }
 */
router.put('/:id', async (req, res) => {
    const { isActive, trafficWeight, description } = req.body;

    try {
        // Validate ObjectId to prevent NoSQL injection
        if (!validateObjectId(req.params.id, res, 'Prompt ID')) return;

        const prompt = await PromptConfig.findById(req.params.id);

        if (!prompt) {
            return res.status(404).json({ status: 'error', message: 'Prompt not found' });
        }

        if (isRemovedPersona(prompt.name)) {
            return res.status(410).json({
                status: 'error',
                message: 'Persona has been removed from the runtime'
            });
        }

        // Capture before state for audit log
        const beforeState = {
            isActive: prompt.isActive,
            trafficWeight: prompt.trafficWeight,
            description: prompt.description
        };

        if (typeof isActive === 'boolean') prompt.isActive = isActive;
        if (typeof trafficWeight === 'number') prompt.trafficWeight = trafficWeight;
        if (description) prompt.description = description;

        await prompt.save();

        logger.info('Prompt updated', { name: prompt.name, version: prompt.version });

        res.json({
            status: 'success',
            data: serializePrompt(prompt)
        });
    } catch (err) {
        logger.error('Update prompt error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * POST /api/prompts/:name/ab-test
 * Configure A/B test between versions * Body: { versions: [{ version: number, weight: number }] }
 */
router.post('/:name/ab-test', async (req, res) => {
    const { versions } = req.body;

    if (isRemovedPersona(req.params.name)) {
        return res.status(410).json({
            status: 'error',
            message: 'Persona has been removed from the runtime'
        });
    }

    if (!versions || !Array.isArray(versions)) {
        return res.status(400).json({
            status: 'error',
            message: 'versions array is required'
        });
    }

    const totalWeight = versions.reduce((sum, v) => sum + (v.weight || 0), 0);
    if (totalWeight !== 100) {
        return res.status(400).json({
            status: 'error',
            message: `Weights must sum to 100 (got ${totalWeight})`
        });
    }

    try {
        const abTestGroup = `ab_${req.params.name}_${Date.now()}`;
        const query = { name: req.params.name };

        // First, deactivate all versions
        await PromptConfig.updateMany(
            query,
            { isActive: false, abTestGroup: null, trafficWeight: 0 }
        );

        // Then activate and set weights for specified versions
        for (const v of versions) {
            await PromptConfig.findOneAndUpdate(
                { ...query, version: v.version },
                { isActive: true, trafficWeight: v.weight, abTestGroup }
            );
        }

        const updated = await PromptConfig.find(query).sort({ version: -1 });

        logger.info('A/B test configured', { name: req.params.name, versions, abTestGroup });

        res.json({
            status: 'success',
            message: 'A/B test configured',
            data: {
                abTestGroup,
                versions: updated.filter(p => p.isActive)
            }
        });
    } catch (err) {
        logger.error('A/B test config error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * DELETE /api/prompts/:id
 * Delete a prompt version (only if not active) */
router.delete('/:id', async (req, res) => {
    try {
        // Validate ObjectId to prevent NoSQL injection
        if (!validateObjectId(req.params.id, res, 'Prompt ID')) return;
        if (!requireTypedConfirmation(req, res, 'DELETE PROMPT', req.params.id)) return;

        const prompt = await PromptConfig.findById(req.params.id);

        if (!prompt) {
            return res.status(404).json({ status: 'error', message: 'Prompt not found' });
        }

        if (prompt.isActive) {
            return res.status(400).json({
                status: 'error',
                message: 'Cannot delete active prompt. Deactivate first.'
            });
        }

        await prompt.deleteOne();

        logger.info('Prompt deleted', { name: prompt.name, version: prompt.version });

        res.json({
            status: 'success',
            message: 'Prompt deleted'
        });
    } catch (err) {
        logger.error('Delete prompt error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * POST /api/prompts/render
 * Render a prompt template with variables * Supports Handlebars-like syntax: {{variable}}, {{#if condition}}...{{/if}}, {{#each items}}...{{/each}}
 */
router.post('/render', async (req, res) => {
    const { name, version, variables } = req.body;

    if (!name) {
        return res.status(400).json({ status: 'error', message: 'Prompt name required' });
    }

    try {
        const query = { name };

        if (isRemovedPersona(name)) {
            return res.status(410).json({
                status: 'error',
                message: 'Persona has been removed from the runtime'
            });
        }

        // Find the prompt (specific version or active version)
        let prompt;
        if (version) {
            prompt = await PromptConfig.findOne({ ...query, version });
        } else {
            prompt = await PromptConfig.findOne({ ...query, isActive: true });
        }

        if (!prompt) {
            return res.status(404).json({ status: 'error', message: 'Prompt not found' });
        }

        // Render the template
        const rendered = renderTemplate(prompt.systemPrompt, variables || {});

        // Update usage stats
        prompt.stats.impressions++;
        await prompt.save();

        logger.info('Prompt rendered', { name: prompt.name, version: prompt.version });

        res.json({
            status: 'success',
            data: {
                name: prompt.name,
                version: prompt.version,
                rendered,
                variables_used: variables || {}
            }
        });
    } catch (err) {
        logger.error('Render prompt error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * Simple template renderer with Handlebars-like syntax
 * Supports: {{variable}}, {{#if var}}...{{/if}}, {{#each items}}...{{/each}}
 */
function renderTemplate(template, variables) {
    let rendered = template;

    // Handle {{#if condition}}...{{/if}}
    rendered = rendered.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (match, varName, content) => {
        const value = variables[varName];
        return value ? content : '';
    });

    // Handle {{#each items}}...{{/each}}
    rendered = rendered.replace(/\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (match, varName, content) => {
        const items = variables[varName];
        if (!Array.isArray(items)) return '';

        return items.map((item, index) => {
            let itemContent = content;
            // Support {{this}} for simple arrays
            itemContent = itemContent.replace(/\{\{this\}\}/g, String(item));
            // Support {{@index}}
            itemContent = itemContent.replace(/\{\{@index\}\}/g, String(index));
            // Support object properties {{property}}
            if (typeof item === 'object') {
                Object.keys(item).forEach(key => {
                    // Escape regex special chars in key to prevent ReDoS
                    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(`\\{\\{${escaped}\\}\\}`, 'g');
                    itemContent = itemContent.replace(regex, String(item[key]));
                });
            }
            return itemContent;
        }).join('');
    });

    // Handle simple {{variable}} substitution
    rendered = rendered.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
        return variables.hasOwnProperty(varName) ? String(variables[varName]) : match;
    });

    return rendered;
}

/**
 * POST /api/prompts/:name/analyze-failures
 * Analyze negative feedback conversations and suggest improvements * Body: { version?: number, limit?: number }
 */
router.post('/:name/analyze-failures', async (req, res) => {
    const Conversation = require('../models/Conversation');
    const { analyzeFailurePatterns, callOllamaForAnalysis } = require('../src/helpers/promptAnalysis');

    try {
        const { name } = req.params;
        const { version, limit = 20 } = req.body;

        if (isRemovedPersona(name)) {
            return res.status(410).json({
                status: 'error',
                message: 'Persona has been removed from the runtime'
            });
        }

        const query = { name };

        // Find the prompt
        let prompt;
        if (version) {
            prompt = await PromptConfig.findOne({ ...query, version: parseInt(version, 10) });
        } else {
            prompt = await PromptConfig.findOne({ ...query, isActive: true });
        }

        if (!prompt) {
            return res.status(404).json({
                status: 'error',
                message: 'Prompt not found'
            });
        }

        logger.info('Analyzing prompt failures', { name, version: prompt.version, limit });

        const convQuery = {
            promptName: name,
            promptVersion: prompt.version,
            'messages.feedback.rating': -1
        };

        const conversations = await Conversation.find(convQuery)
            .sort({ createdAt: -1 })
            .limit(parseInt(limit, 10))
            .lean();

        if (conversations.length === 0) {
            const emptyAnalysis = analyzeFailurePatterns([]);
            return res.json({
                status: 'success',
                data: {
                    message: 'No negative feedback found for this prompt version',
                    prompt: {
                        name: prompt.name,
                        version: prompt.version,
                        systemPrompt: prompt.systemPrompt
                    },
                    conversations: 0,
                    patternAnalysis: emptyAnalysis,
                    llmAnalysis: null,
                    llmError: null,
                    rawLlmResponse: null
                }
            });
        }

        // Analyze failure patterns
        const patternAnalysis = analyzeFailurePatterns(conversations);

        // Get sample conversations for LLM analysis (max 5)
        const sampleConversations = conversations.slice(0, 5);

        // Call Ollama for deeper analysis
        const ollamaHost = process.env.OLLAMA_HOST;
        if (!ollamaHost) {
            throw new Error('OLLAMA_HOST environment variable is required for failure analysis');
        }
        const llmAnalysis = await callOllamaForAnalysis(
            prompt,
            patternAnalysis,
            sampleConversations,
            ollamaHost
        );

        logger.info('Failure analysis complete', {
            name,
            version: prompt.version,
            conversationsAnalyzed: conversations.length,
            patternsFound: patternAnalysis.patterns.length
        });

        res.json({
            status: 'success',
            data: {
                prompt: {
                    name: prompt.name,
                    version: prompt.version,
                    systemPrompt: prompt.systemPrompt
                },
                conversations: conversations.length,
                patternAnalysis,
                llmAnalysis: llmAnalysis.success ? llmAnalysis.analysis : null,
                llmError: llmAnalysis.success ? null : llmAnalysis.error,
                rawLlmResponse: llmAnalysis.raw_response
            }
        });

    } catch (err) {
        logger.error('Analyze failures error', { error: err.message, stack: err.stack });
        res.status(500).json({
            status: 'error',
            message: err.message
        });
    }
});

module.exports = router;
