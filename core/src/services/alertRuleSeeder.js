'use strict';

const AlertRule = require('../../models/AlertRule');
const alertService = require('./alertService');

// The product-boundary cleanup removed the host-capacity route and producer.
// Retain only the IDs needed to disable records seeded by older installations;
// the builtIn filter below deliberately leaves operator-created rules alone.
const RETIRED_BUILT_IN_RULE_IDS = Object.freeze([
  'capacity-vram-pressure',
  'capacity-gpu-imbalance',
  'capacity-underused',
  'capacity-host-critical',
]);

/** Sync all enabled MongoDB rules into the in-memory alert engine */
async function syncRulesToEngine() {
  const dbRules = await AlertRule.find({ enabled: true }).lean();
  const engineRules = dbRules.map(r => ({
    id: r.ruleId,
    name: r.name,
    enabled: true,
    severity: r.severity,
    conditions: r.conditions,
    channels: r.channels,
    title: r.title || undefined,
    message: r.message || undefined,
    cooldownMs: r.cooldownMs,
    renotifyMs: r.renotifyMs,
  }));
  alertService.loadRules(engineRules);
}

/** Create built-in defaults if they don't exist yet */
async function seedDefaultRules() {
  const defaults = require('../../config/default-alert-rules.json');
  const retirement = await AlertRule.updateMany(
    {
      ruleId: { $in: RETIRED_BUILT_IN_RULE_IDS },
      builtIn: true,
      enabled: true,
    },
    { $set: { enabled: false } }
  );
  const retired = Number(retirement?.modifiedCount) || 0;
  let created = 0;
  let backfilled = 0;
  for (const rule of defaults) {
    const exists = await AlertRule.findOne({ ruleId: rule.id });
    if (!exists) {
      await AlertRule.create({
        ruleId: rule.id,
        name: rule.name,
        enabled: rule.enabled !== false,
        severity: rule.severity,
        conditions: rule.conditions,
        channels: rule.channels || ['local_log'],
        title: rule.title || '',
        message: rule.message || '',
        description: rule.description || '',
        renotifyMs: rule.renotifyMs || 0,
        builtIn: true,
      });
      created++;
    } else if (exists.builtIn && !exists.title && !exists.message && (rule.title || rule.message)) {
      // One-time backfill: built-in rules seeded before templates existed
      await AlertRule.updateOne(
        { ruleId: rule.id },
        { $set: { title: rule.title || '', message: rule.message || '' } }
      );
      backfilled++;
    } else if (exists.builtIn && (rule.renotifyMs || 0) > 0 && !(exists.renotifyMs > 0)) {
      // Backfill re-notification onto built-ins seeded before task 0541.
      // Without this the JSON change is inert in any environment where the
      // rule already exists — which is every deployed one.
      //
      // Only fills an unset/zero value, never overwrites a configured one.
      // Today that is unambiguous because the field is new; once an operator
      // has deliberately set 0 to silence a rule, this would re-enable it, so
      // prefer disabling the rule itself over zeroing this field.
      await AlertRule.updateOne(
        { ruleId: rule.id },
        { $set: { renotifyMs: rule.renotifyMs } }
      );
      backfilled++;
    }
  }
  if (created > 0 || backfilled > 0 || retired > 0) await syncRulesToEngine();
  return created;
}

module.exports = {
  seedDefaultRules,
  syncRulesToEngine,
  RETIRED_BUILT_IN_RULE_IDS,
};
