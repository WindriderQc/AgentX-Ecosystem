#!/usr/bin/env node
/* eslint-disable no-console */
const mongoose = require('mongoose');
const Conversation = require('../../models/Conversation');

const args = process.argv.slice(2);

function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

function hasFlag(flag) {
  return args.includes(flag);
}

function parseIntArg(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function splitCount(total, parts) {
  const base = Math.floor(total / parts);
  const remainder = total % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
}

function buildMessages(negativeCount, positiveCount, seedOffset) {
  const messages = [];
  let idx = seedOffset;

  for (let i = 0; i < negativeCount; i += 1) {
    messages.push({ role: 'user', content: `Seed user message ${idx}` });
    messages.push({
      role: 'assistant',
      content: `Seed assistant response ${idx}`,
      feedback: { rating: -1, comment: 'seed-negative' }
    });
    idx += 1;
  }

  for (let i = 0; i < positiveCount; i += 1) {
    messages.push({ role: 'user', content: `Seed user message ${idx}` });
    messages.push({
      role: 'assistant',
      content: `Seed assistant response ${idx}`,
      feedback: { rating: 1, comment: 'seed-positive' }
    });
    idx += 1;
  }

  return messages;
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(`
Seed negative feedback conversations for PromptHealthMonitor testing.

Usage:
  node tests/scripts/seed-negative-feedback.js [options]

Options:
  --prompt <name>        Prompt name (default: default_chat)
  --version <number>     Prompt version (default: 1)
  --negative <number>    Negative feedback count (default: 40)
  --positive <number>    Positive feedback count (default: 10)
  --conversations <num>  Number of conversations to create (default: 1)
  --user <id>            userId (default: default)
  --model <name>         Model name (default: seed-model)
  --days-ago <num>       Backdate createdAt by N days (default: 0)
`);
    process.exit(0);
  }

  const promptName = getArg('--prompt', getArg('--name', 'default_chat'));
  const promptVersion = parseIntArg(getArg('--version', '1'), 1);
  const negativeCount = parseIntArg(getArg('--negative', '40'), 40);
  const positiveCount = parseIntArg(getArg('--positive', '10'), 10);
  const conversationCount = Math.max(1, parseIntArg(getArg('--conversations', '1'), 1));
  const userId = getArg('--user', 'default');
  const model = getArg('--model', 'seed-model');
  const daysAgo = Math.max(0, parseIntArg(getArg('--days-ago', '0'), 0));

  const totalFeedback = negativeCount + positiveCount;
  if (totalFeedback <= 0) {
    console.error('Nothing to seed: negative + positive must be > 0.');
    process.exit(1);
  }

  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx';
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 2000 });

  const negativeSplits = splitCount(negativeCount, conversationCount);
  const positiveSplits = splitCount(positiveCount, conversationCount);
  const now = new Date();
  const docs = [];
  let seedOffset = 1;

  for (let i = 0; i < conversationCount; i += 1) {
    const createdAt = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000 - i * 60 * 1000);
    const messages = buildMessages(negativeSplits[i], positiveSplits[i], seedOffset);
    seedOffset += negativeSplits[i] + positiveSplits[i];

    docs.push({
      userId,
      model,
      systemPrompt: `Seed prompt for ${promptName} v${promptVersion}`,
      messages,
      title: `Seeded conversation ${i + 1}`,
      createdAt,
      updatedAt: createdAt,
      promptName,
      promptVersion
    });
  }

  const inserted = await Conversation.insertMany(docs);

  console.log(`Seeded ${inserted.length} conversation(s) for ${promptName} v${promptVersion}.`);
  console.log(`Feedback: ${negativeCount} negative, ${positiveCount} positive.`);
  console.log(`userId: ${userId} | model: ${model} | days-ago: ${daysAgo}`);

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('Seed failed:', error.message);
  process.exit(1);
});
