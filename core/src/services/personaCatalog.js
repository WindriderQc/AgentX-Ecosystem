'use strict';

// A selectable projection of PromptConfig, not another persona store.
const crypto = require('node:crypto');
const PromptConfig = require('../../models/PromptConfig');
const { classifyPersona } = require('./personaDisposition');

const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const project = (row) => ({ ...row, _id: String(row._id), disposition: classifyPersona(row) });

async function list() {
  const rows = await PromptConfig.find({ isActive: true }).sort({ name: 1, version: -1 }).lean();
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.name) || !classifyPersona(row).selectable) return false;
    seen.add(row.name);
    return true;
  }).map(project);
}

async function resolve(name, version) {
  if (typeof name !== 'string' || !name.trim()) throw error('A persona name is required');
  const query = { name: name.trim() };
  if (version != null) {
    if (!Number.isInteger(Number(version)) || Number(version) < 1) throw error('Invalid persona version');
    query.version = Number(version);
  } else query.isActive = true;
  const row = await PromptConfig.findOne(query).sort({ version: -1 }).lean();
  if (!row || !classifyPersona(row).selectable) throw error('Persona is unavailable', 404);
  return project(row);
}

// Private extensions publish generated definitions into the same versioned
// catalog. Source-owned rows are regenerated, never separately hand-authored.
async function publish(sourceId, definitions) {
  if (typeof sourceId !== 'string' || !sourceId.trim() || !Array.isArray(definitions)) throw error('Invalid persona source');
  const published = [];
  for (const definition of definitions) {
    const { name, systemPrompt, description = '', uiConfig = {} } = definition;
    if (!/^[a-z][a-z0-9_-]{0,119}$/.test(name) || typeof systemPrompt !== 'string' || !systemPrompt.trim()) throw error('Invalid persona definition');
    const hash = crypto.createHash('sha256').update(JSON.stringify({ name, systemPrompt, description, uiConfig })).digest('hex');
    // Unique (name,version) index arbitrates concurrent extension starts.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = await PromptConfig.findOne({ name }).sort({ version: -1 }).lean();
      if (latest && latest.uiConfig?.layoutConfig?.source?.id !== sourceId) throw error(`Persona ${name} has another author`, 409);
      let row = latest;
      if (!row || row.uiConfig.layoutConfig.source.hash !== hash) {
        try {
          row = await PromptConfig.create({ name, systemPrompt, description,
            version: (latest?.version || 0) + 1, isActive: false,
            uiConfig: { ...uiConfig, layoutConfig: { ...uiConfig.layoutConfig, source: { id: sourceId, hash } } }
          });
        } catch (err) {
          if (err.code === 11000 && attempt < 2) continue;
          throw err;
        }
      }
      if (!row.isActive) await PromptConfig.activate(row._id);
      published.push({ name, version: row.version });
      break;
    }
  }
  return published;
}

module.exports = { list, resolve, publish };
