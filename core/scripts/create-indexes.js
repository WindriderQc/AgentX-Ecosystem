#!/usr/bin/env node
/**
 * MongoDB Index Creation Script
 * Creates performance indexes for AgentX collections
 *
 * Usage: node scripts/create-indexes.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx';

async function createIndexes() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✓ Connected to MongoDB\n');

    const db = mongoose.connection.db;

    // =========================================================================
    // CONVERSATIONS COLLECTION
    // =========================================================================
    console.log('Creating indexes for conversations...');
    const conversationsCollection = db.collection('conversations');

    // User conversations sorted by update time (most common query)
    await conversationsCollection.createIndex(
      { userId: 1, updatedAt: -1 },
      { name: 'userId_updatedAt', background: true }
    );
    console.log('  ✓ userId_updatedAt index created');

    // Time-based queries (analytics, date ranges)
    try {
      await conversationsCollection.createIndex(
        { createdAt: 1 },
        { name: 'createdAt', background: true }
      );
      console.log('  ✓ createdAt index created');
    } catch (error) {
      if (error.code === 85 || error.codeName === 'IndexOptionsConflict') {
        console.log('  ✓ createdAt index already exists');
      } else {
        throw error;
      }
    }

    // Model usage analytics
    try {
      await conversationsCollection.createIndex(
        { model: 1, createdAt: 1 },
        { name: 'model_createdAt', background: true }
      );
      console.log('  ✓ model_createdAt index created');
    } catch (error) {
      if (error.code === 85 || error.codeName === 'IndexOptionsConflict') {
        console.log('  ✓ model_createdAt index already exists');
      } else {
        throw error;
      }
    }

    // RAG usage tracking
    try {
      await conversationsCollection.createIndex(
        { ragUsed: 1 },
        { name: 'ragUsed', background: true }
      );
      console.log('  ✓ ragUsed index created');
    } catch (error) {
      if (error.code === 85 || error.codeName === 'IndexOptionsConflict') {
        console.log('  ✓ ragUsed index already exists');
      } else {
        throw error;
      }
    }

    // Feedback analytics (compound index for filtered queries)
    await conversationsCollection.createIndex(
      { 'messages.feedback.rating': 1, createdAt: -1 },
      { name: 'feedback_rating_createdAt', background: true }
    );
    console.log('  ✓ feedback_rating_createdAt index created');

    // Prompt versioning queries
    try {
      await conversationsCollection.createIndex(
        { promptConfigId: 1 },
        { name: 'promptConfigId', background: true }
      );
      console.log('  ✓ promptConfigId index created');
    } catch (error) {
      if (error.code === 85 || error.codeName === 'IndexOptionsConflict') {
        console.log('  ✓ promptConfigId index already exists');
      } else {
        throw error;
      }
    }

    try {
      await conversationsCollection.createIndex(
        { promptName: 1, promptVersion: 1 },
        { name: 'promptName_version', background: true }
      );
      console.log('  ✓ promptName_version index created');
    } catch (error) {
      if (error.code === 85 || error.codeName === 'IndexOptionsConflict') {
        console.log('  ✓ promptName_version index already exists');
      } else {
        throw error;
      }
    }

    // Full-text search on title + message content (conversationSearchService)
    try {
      await conversationsCollection.createIndex(
        { title: 'text', 'messages.content': 'text' },
        {
          name: 'conversation_text_search',
          weights: { title: 10, 'messages.content': 5 },
          background: true
        }
      );
      console.log('  ✓ conversation_text_search index created');
    } catch (error) {
      if (error.code === 85 || error.codeName === 'IndexOptionsConflict') {
        console.log('  ✓ conversation_text_search index already exists');
      } else {
        throw error;
      }
    }

    // =========================================================================
    // USERPROFILES COLLECTION
    // =========================================================================
    console.log('\nCreating indexes for userprofiles...');
    const userProfilesCollection = db.collection('userprofiles');

    // Email lookup (login, registration)
    try {
      await userProfilesCollection.createIndex(
        { email: 1 },
        { name: 'email_unique', unique: true, sparse: true, background: true }
      );
      console.log('  ✓ email_unique index created');
    } catch (error) {
      if (error.code === 85 || error.codeName === 'IndexOptionsConflict') {
        console.log('  ✓ email_unique index already exists');
      } else {
        throw error;
      }
    }

    // userId lookup (already has unique index from model, but ensuring it exists)
    try {
      await userProfilesCollection.createIndex(
        { userId: 1 },
        { name: 'userId_unique', unique: true, background: true }
      );
      console.log('  ✓ userId_unique index created');
    } catch (error) {
      if (error.code === 85 || error.codeName === 'IndexOptionsConflict') {
        console.log('  ✓ userId_unique index already exists');
      } else {
        throw error;
      }
    }

    // Admin user queries
    try {
      await userProfilesCollection.createIndex(
        { isAdmin: 1 },
        { name: 'isAdmin', background: true }
      );
      console.log('  ✓ isAdmin index created');
    } catch (error) {
      if (error.code === 85 || error.codeName === 'IndexOptionsConflict') {
        console.log('  ✓ isAdmin index already exists');
      } else {
        throw error;
      }
    }

    // =========================================================================
    // SESSIONS COLLECTION
    // =========================================================================
    console.log('\nCreating indexes for sessions...');
    const sessionsCollection = db.collection('sessions');

    // TTL index for automatic session cleanup
    try {
      await sessionsCollection.createIndex(
        { expires: 1 },
        { name: 'expires_ttl', expireAfterSeconds: 0, background: true }
      );
      console.log('  ✓ expires_ttl index created (TTL for auto-cleanup)');
    } catch (error) {
      if (error.code === 85 || error.codeName === 'IndexOptionsConflict') {
        console.log('  ✓ expires_ttl index already exists');
      } else {
        throw error;
      }
    }

    // Session ID (_id) index exists automatically, no need to create
    console.log('  ✓ session_id (_id) index exists automatically');

    // =========================================================================
    // PROMPTCONFIGS COLLECTION
    // =========================================================================
    console.log('\nCreating indexes for promptconfigs...');
    const promptConfigsCollection = db.collection('promptconfigs');

    // Name and version lookup (compound unique index)
    try {
      await promptConfigsCollection.createIndex(
        { name: 1, version: 1 },
        { name: 'name_version_unique', unique: true, background: true }
      );
      console.log('  ✓ name_version_unique index created');
    } catch (error) {
      if (error.code === 85 || error.codeName === 'IndexOptionsConflict') {
        console.log('  ✓ name_version_unique index already exists');
      } else {
        throw error;
      }
    }

    // Active prompts query
    try {
      await promptConfigsCollection.createIndex(
        { isActive: 1 },
        { name: 'isActive', background: true }
      );
      console.log('  ✓ isActive index created');
    } catch (error) {
      if (error.code === 85 || error.codeName === 'IndexOptionsConflict') {
        console.log('  ✓ isActive index already exists');
      } else {
        throw error;
      }
    }

    // =========================================================================
    // SUMMARY
    // =========================================================================
    console.log('\n' + '='.repeat(70));
    console.log('INDEX CREATION SUMMARY');
    console.log('='.repeat(70));

    const collections = [
      { name: 'conversations', expectedIndexes: 9 },
      { name: 'userprofiles', expectedIndexes: 4 },
      { name: 'sessions', expectedIndexes: 2 },
      { name: 'promptconfigs', expectedIndexes: 3 }
    ];

    for (const { name, expectedIndexes } of collections) {
      const collection = db.collection(name);
      const indexes = await collection.indexes();
      console.log(`\n${name}:`);
      console.log(`  Total indexes: ${indexes.length} (expected: ${expectedIndexes})`);
      indexes.forEach(index => {
        const keyStr = Object.keys(index.key).map(k => `${k}:${index.key[k]}`).join(', ');
        const extra = [];
        if (index.unique) extra.push('UNIQUE');
        if (index.sparse) extra.push('SPARSE');
        if (index.expireAfterSeconds !== undefined) extra.push(`TTL:${index.expireAfterSeconds}s`);
        const extraStr = extra.length > 0 ? ` [${extra.join(', ')}]` : '';
        console.log(`    - ${index.name}: {${keyStr}}${extraStr}`);
      });
    }

    console.log('\n' + '='.repeat(70));
    console.log('✓ All indexes created successfully!');
    console.log('='.repeat(70) + '\n');

    // Performance tips
    console.log('PERFORMANCE TIPS:');
    console.log('  • Indexes are created in background mode (non-blocking)');
    console.log('  • Sessions auto-expire via TTL index');
    console.log('  • Use .explain() to verify index usage in queries');
    console.log('  • Monitor index size with db.collection.stats()');
    console.log('  • Re-run this script after schema changes\n');

  } catch (error) {
    console.error('Error creating indexes:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed.');
  }
}

// Run the script
createIndexes();
