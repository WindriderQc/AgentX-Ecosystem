const mongoose = require('mongoose');

const ACTION_CATEGORIES = ['Urgent', 'Needs Reply', 'Waiting'];

const EmailActionSchema = new mongoose.Schema({
  gmailThreadId: { type: String, required: true, unique: true, index: true },
  gmailMessageId: { type: String, default: '' },
  category: { type: String, enum: ACTION_CATEGORIES, required: true, index: true },
  action: { type: String, required: true },
  subject: { type: String, default: '' },
  sender: { type: String, default: '' },
  messageDate: { type: String, default: '' },
  dueAt: { type: Date, default: null, index: true },
  gmailUrl: { type: String, required: true },
  leantimeProjectId: { type: Number, required: true },
  leantimeTicketId: { type: Number, default: null, index: true },
  state: { type: String, enum: ['pending', 'active', 'error'], default: 'pending', index: true },
  lastError: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('EmailAction', EmailActionSchema);
module.exports.ACTION_CATEGORIES = ACTION_CATEGORIES;
