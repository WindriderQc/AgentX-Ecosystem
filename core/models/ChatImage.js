'use strict';

const mongoose = require('mongoose');

// Keep image bytes out of Conversation documents and history list responses.
const ChatImageSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  mimeType: { type: String, required: true },
  data: { type: Buffer, required: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ChatImage', ChatImageSchema);
