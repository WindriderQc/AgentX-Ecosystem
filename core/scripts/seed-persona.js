#!/usr/bin/env node

/**
 * Seed Persona Script
 * Usage: node scripts/seed-persona.js <persona-file.json>
 * Example: node scripts/seed-persona.js personas/repo_watcher.json
 */

require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const PromptConfig = require('../models/PromptConfig');

async function seedPersona(personaFilePath) {
  try {
    // Connect to MongoDB
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✓ Connected to MongoDB');

    // Read persona file
    const fullPath = path.resolve(process.cwd(), personaFilePath);
    console.log(`Reading persona file: ${fullPath}`);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Persona file not found: ${fullPath}`);
    }

    const personaData = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
    console.log(`✓ Loaded persona: ${personaData.name} v${personaData.version}`);

    // Check if persona already exists
    const existing = await PromptConfig.findOne({
      name: personaData.name,
      version: personaData.version
    });

    if (existing) {
      console.log(`⚠ Persona ${personaData.name} v${personaData.version} already exists`);
      console.log('  Options:');
      console.log('  1. Delete existing and re-import');
      console.log('  2. Update existing in-place');
      console.log('  3. Create new version');

      // For now, update in place
      console.log('  → Updating existing persona...');
      Object.assign(existing, personaData);
      await existing.save();
      console.log('✓ Persona updated successfully');
    } else {
      // Create new persona
      const persona = new PromptConfig(personaData);
      await persona.save();
      console.log(`✓ Persona ${personaData.name} v${personaData.version} created successfully`);
    }

    // Display summary
    console.log('\n=== Persona Summary ===');
    console.log(`Name: ${personaData.name}`);
    console.log(`Version: ${personaData.version}`);
    console.log(`Active: ${personaData.isActive}`);
    console.log(`Description: ${personaData.description}`);
    if (personaData.uiConfig) {
      console.log(`UI Type: ${personaData.uiConfig.type}`);
      console.log(`UI Route: ${personaData.uiConfig.route}`);
    }

    process.exit(0);
  } catch (error) {
    console.error('✗ Error seeding persona:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node scripts/seed-persona.js <persona-file.json>');
  console.error('Example: node scripts/seed-persona.js personas/repo_watcher.json');
  process.exit(1);
}

const personaFile = args[0];
seedPersona(personaFile);
