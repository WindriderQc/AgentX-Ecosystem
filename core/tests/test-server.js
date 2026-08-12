// Test Server for E2E testing
// Uses MongoDB Memory Server instead of real MongoDB

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const logger = require('../config/logger');

const PORT = process.env.PORT || 3080;
const HOST = process.env.HOST || 'localhost';

async function startServer() {
  console.log('🚀 Starting Test Server with In-Memory MongoDB...');

  // 1. Start MongoDB Memory Server
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  console.log(`   ✓ In-Memory MongoDB started at ${uri}`);

  // 2. Connect Mongoose
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 2000,
    family: 4
  });
  console.log('   ✓ Mongoose connected');

  // Seed default user profile
  try {
    const UserProfile = require('../models/UserProfile');
    await UserProfile.deleteMany({});
    await UserProfile.create({
        userId: 'test_user',
        username: 'test_user',
        email: 'test@example.com'
    });
    console.log('   ✓ Seeded default user profile (test_user)');
  } catch (e) { console.error('Seeding failed', e); }

  if (process.env.AGENTX_GATE_C_SEED_BUDDY === 'true') {
    const fs = require('fs');
    const path = require('path');
    const Buddy = require('../models/Buddy');
    await Buddy.deleteMany({});
    await Buddy.create({
      seed: 'global',
      version: 2,
      name: 'Gate C Nestor',
      species: 'owl',
      rarity: 'rare',
      pickedSpriteId: 'gate-c-owl',
      soul: 'Gate C migration soul.',
      personality: { source: 'standalone', agentId: '' },
      memory: { sources: ['agentx'], k: 5 },
      mood: 'happy',
      totalReactions: 3,
      facts: [{ text: 'Mongo Gate C fact', weight: 1 }],
    });
    const buddyHome = process.env.BUDDY_HOME;
    if (!buddyHome) throw new Error('BUDDY_HOME is required for the Gate C seed.');
    fs.mkdirSync(buddyHome, { recursive: true });
    fs.writeFileSync(
      path.join(buddyHome, 'notes.md'),
      Buffer.from(process.env.AGENTX_GATE_C_NOTES_BASE64 || '', 'base64'),
    );
    console.log('   ✓ Seeded Gate C Buddy profile and exact notes archive');
  }

  // 3. Start Express
  // Set NODE_ENV to test_e2e to trigger session store creation with the new URI
  process.env.NODE_ENV = 'test_e2e';
  process.env.MONGODB_URI = uri;

  // Require app NOW so it sees the environment variables
  const { app, systemHealth } = require('../src/app');

  systemHealth.mongodb = { status: 'connected', lastCheck: new Date().toISOString(), error: null };
  // Mock Ollama health for tests
  systemHealth.ollama = { status: 'connected', lastCheck: new Date().toISOString(), error: null };

  // Re-require app to pick up new env vars if needed (though require cache might block this,
  // but we modified app.js to read env at runtime for store creation? No, it runs on module load).
  // We need to reload app.js or structure it so we can inject store.
  // For now, let's rely on the fact that app.js is already loaded? No, if we loaded it at top, it ran.
  // We need to restart the process with env vars OR modify app.js to be a function.
  // BUT: since this script IS the process, we can set env vars before requiring app.js?
  // We required app.js at the top. This is the problem.

  // FIX: We will not require app at top. We will require it after setting env.

  const server = require('../src/app').app.listen(PORT, () => {
    console.log(`\n✅ Test Server running on http://${HOST}:${PORT}`);
    console.log(`   Health: http://${HOST}:${PORT}/health`);
  });

  // Handle shutdown
  const shutdown = async () => {
    console.log('\n🛑 Stopping Test Server...');
    await mongoose.disconnect();
    await mongod.stop();
    server.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer().catch(err => {
  console.error('Failed to start test server:', err);
  process.exit(1);
});
