'use strict';
const mongoose = require('mongoose');

const conditionSchema = new mongoose.Schema({
  fact: { type: String, required: true },
  operator: { type: String, required: true, enum: ['equal', 'greaterThan', 'lessThan', 'greaterThanOrEqual', 'lessThanOrEqual', 'notEqual', 'contains', 'matches'] },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
}, { _id: false });

const alertRuleSchema = new mongoose.Schema({
  ruleId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  enabled: { type: Boolean, default: true },
  severity: { type: String, required: true, enum: ['info', 'warning', 'error', 'critical'] },
  conditions: {
    all: [conditionSchema],
  },
  channels: { type: [String], default: ['dataapi_log'] },
  // Optional {{var}} templates rendered against the event (component, metric,
  // value, threshold, host, model, …). Empty → alertService builds a fallback.
  title: { type: String, default: '' },
  message: { type: String, default: '' },
  cooldownMs: { type: Number, default: 300000 },
  // Re-notify while this rule's alert stays unresolved (task 0541).
  //
  // Dedup keys one incident per fingerprint and skips notification on every
  // recurrence, so a CONTINUOUSLY failing condition never goes stale, never
  // resolves, and therefore never notifies again — the more constantly
  // something fails, the quieter it gets. Measured: one .12 Ollama outage
  // held 323 occurrences over 26 hours behind a single Telegram message.
  //
  // 0 disables re-notification, which is the default precisely because most
  // rules are intermittent: they resolve via the stale sweep and re-fire,
  // which already notifies. Set this only where sustained silence is the
  // dangerous outcome. Interval doubles per notification (see
  // alertService._renotifyDueAt) so a long incident escalates instead of
  // repeating at a fixed rate.
  renotifyMs: { type: Number, default: 0 },
  description: { type: String, default: '' },
  builtIn: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('AlertRule', alertRuleSchema);
