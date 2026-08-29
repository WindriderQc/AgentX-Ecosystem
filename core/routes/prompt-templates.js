/**
 * Prompt Template Routes
 * CRUD operations for user quick prompt templates
 * Separate from PromptConfig (system prompts with A/B testing)
 */

const express = require('express');
const router = express.Router();
const PromptTemplate = require('../models/PromptTemplate');
const { getUserId } = require('../src/helpers/userHelpers');
const logger = require('../config/logger');
const { validateObjectId } = require('../src/helpers/objectIdValidator');
const { requireTypedConfirmation } = require('../src/helpers/typedConfirmation');

/**
 * Reuse template rendering function from prompts.js
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
          const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
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
 * GET /api/prompt-templates
 * List all templates (system + user templates)
 * Query params: category, search, sortBy, sortOrder
 */
router.get('/', async (req, res) => {
  try {
    const userId = getUserId(res);

    const filters = {
      category: req.query.category,
      search: req.query.search,
      sortBy: req.query.sortBy || 'name',
      sortOrder: req.query.sortOrder || 'asc'
    };

    // Get templates for user
    const templates = await PromptTemplate.getTemplatesForUser(userId, filters);

    res.json({
      status: 'success',
      data: templates
    });
  } catch (err) {
    logger.error('List prompt templates error', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/prompt-templates/categories/stats
 * Get category statistics for user
 */
router.get('/categories/stats', async (req, res) => {
  try {
    const userId = getUserId(res);

    const stats = await PromptTemplate.getCategoryStats(userId);

    res.json({
      status: 'success',
      data: stats
    });
  } catch (err) {
    logger.error('Get category stats error', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/prompt-templates/:id
 * Get single template by ID
 */
router.get('/:id', async (req, res) => {
  try {
    // Validate ObjectId to prevent NoSQL injection
    if (!validateObjectId(req.params.id, res, 'Template ID')) return;

    const template = await PromptTemplate.findById(req.params.id);

    if (!template) {
      return res.status(404).json({ status: 'error', message: 'Template not found' });
    }

    const userId = getUserId(res);

    // Check access: system templates are public, user templates are private
    if (!template.isSystem && template.userId !== userId) {
      return res.status(403).json({ status: 'error', message: 'Access denied' });
    }

    res.json({
      status: 'success',
      data: template
    });
  } catch (err) {
    logger.error('Get template error', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/prompt-templates
 * Create new template
 * Body: { name, template, category, description, tags }
 */
router.post('/', async (req, res) => {
  const { name, template, category, description, tags } = req.body;

  if (!name || !template) {
    return res.status(400).json({
      status: 'error',
      message: 'name and template are required'
    });
  }

  if (!category || !['code', 'writing', 'analysis', 'general', 'custom'].includes(category)) {
    return res.status(400).json({
      status: 'error',
      message: 'Valid category is required (code, writing, analysis, general, custom)'
    });
  }

  try {
    const userId = getUserId(res);

    // Extract placeholders from template
    const placeholderNames = PromptTemplate.extractPlaceholders(template);
    const placeholders = placeholderNames.map(name => ({
      name,
      defaultValue: '',
      description: ''
    }));

    const newTemplate = new PromptTemplate({
      userId,
      name,
      template,
      category,
      description: description || '',
      tags: Array.isArray(tags) ? tags : [],
      placeholders,
      isSystem: false
    });

    await newTemplate.save();

    logger.info('Prompt template created', {
      templateId: newTemplate._id,
      name,
      category,
      userId
    });

    res.status(201).json({
      status: 'success',
      data: newTemplate
    });
  } catch (err) {
    logger.error('Create template error', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * PUT /api/prompt-templates/:id
 * Update template
 * Body: { name, template, category, description, tags }
 */
router.put('/:id', async (req, res) => {
  const { name, template, category, description, tags } = req.body;

  try {
    // Validate ObjectId to prevent NoSQL injection
    if (!validateObjectId(req.params.id, res, 'Template ID')) return;

    const existingTemplate = await PromptTemplate.findById(req.params.id);

    if (!existingTemplate) {
      return res.status(404).json({ status: 'error', message: 'Template not found' });
    }

    const userId = getUserId(res);

    // Cannot edit system templates
    if (existingTemplate.isSystem) {
      return res.status(403).json({
        status: 'error',
        message: 'Cannot edit system templates. Duplicate it first.'
      });
    }

    // Check ownership
    if (existingTemplate.userId !== userId) {
      return res.status(403).json({ status: 'error', message: 'Access denied' });
    }

    // Update fields
    if (name) existingTemplate.name = name;
    if (template) {
      existingTemplate.template = template;
      // Re-extract placeholders
      const placeholderNames = PromptTemplate.extractPlaceholders(template);
      existingTemplate.placeholders = placeholderNames.map(name => ({
        name,
        defaultValue: '',
        description: ''
      }));
    }
    if (category) existingTemplate.category = category;
    if (description !== undefined) existingTemplate.description = description;
    if (Array.isArray(tags)) existingTemplate.tags = tags;

    await existingTemplate.save();

    logger.info('Prompt template updated', {
      templateId: existingTemplate._id,
      name: existingTemplate.name
    });

    res.json({
      status: 'success',
      data: existingTemplate
    });
  } catch (err) {
    logger.error('Update template error', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * DELETE /api/prompt-templates/:id
 * Delete template (cannot delete system templates)
 */
router.delete('/:id', async (req, res) => {
  try {
    // Validate ObjectId to prevent NoSQL injection
    if (!validateObjectId(req.params.id, res, 'Template ID')) return;
    if (!requireTypedConfirmation(req, res, 'DELETE PROMPT TEMPLATE', req.params.id)) return;

    const template = await PromptTemplate.findById(req.params.id);

    if (!template) {
      return res.status(404).json({ status: 'error', message: 'Template not found' });
    }

    const userId = getUserId(res);

    // Cannot delete system templates
    if (template.isSystem) {
      return res.status(403).json({
        status: 'error',
        message: 'Cannot delete system templates'
      });
    }

    // Check ownership
    if (template.userId !== userId) {
      return res.status(403).json({ status: 'error', message: 'Access denied' });
    }

    await template.deleteOne();

    logger.info('Prompt template deleted', {
      templateId: template._id,
      name: template.name
    });

    res.json({
      status: 'success',
      message: 'Template deleted'
    });
  } catch (err) {
    logger.error('Delete template error', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/prompt-templates/:id/render
 * Render template with variables
 * Body: { variables: { key: value } }
 */
router.post('/:id/render', async (req, res) => {
  const { variables } = req.body;

  try {
    // Validate ObjectId to prevent NoSQL injection
    if (!validateObjectId(req.params.id, res, 'Template ID')) return;

    const template = await PromptTemplate.findById(req.params.id);

    if (!template) {
      return res.status(404).json({ status: 'error', message: 'Template not found' });
    }

    const userId = getUserId(res);

    // Check access: system templates are public, user templates are private
    if (!template.isSystem && template.userId !== userId) {
      return res.status(403).json({ status: 'error', message: 'Access denied' });
    }

    // Render template
    const rendered = renderTemplate(template.template, variables || {});

    // Record usage
    await template.recordUsage();

    logger.info('Template rendered', {
      templateId: template._id,
      name: template.name
    });

    res.json({
      status: 'success',
      data: {
        id: template._id,
        name: template.name,
        category: template.category,
        rendered,
        variables_used: variables || {}
      }
    });
  } catch (err) {
    logger.error('Render template error', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/prompt-templates/:id/duplicate
 * Duplicate template (useful for customizing system templates)
 */
router.post('/:id/duplicate', async (req, res) => {
  try {
    // Validate ObjectId to prevent NoSQL injection
    if (!validateObjectId(req.params.id, res, 'Template ID')) return;

    const sourceTemplate = await PromptTemplate.findById(req.params.id);

    if (!sourceTemplate) {
      return res.status(404).json({ status: 'error', message: 'Template not found' });
    }

    const userId = getUserId(res);

    // Check access
    if (!sourceTemplate.isSystem && sourceTemplate.userId !== userId) {
      return res.status(403).json({ status: 'error', message: 'Access denied' });
    }

    // Create duplicate
    const duplicate = new PromptTemplate({
      userId,
      name: `${sourceTemplate.name} (Copy)`,
      template: sourceTemplate.template,
      category: sourceTemplate.category,
      description: sourceTemplate.description,
      tags: [...sourceTemplate.tags],
      placeholders: sourceTemplate.placeholders.map(p => ({
        name: p.name,
        defaultValue: p.defaultValue,
        description: p.description
      })),
      isSystem: false // Duplicates are always user templates
    });

    await duplicate.save();

    logger.info('Template duplicated', {
      sourceId: sourceTemplate._id,
      duplicateId: duplicate._id,
      name: duplicate.name
    });

    res.status(201).json({
      status: 'success',
      data: duplicate
    });
  } catch (err) {
    logger.error('Duplicate template error', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
