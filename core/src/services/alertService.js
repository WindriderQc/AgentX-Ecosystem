const Alert = require('../../models/Alert');
const logger = require('../../config/logger');
const EventEmitter = require('events');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { getNotificationService } = require('./notificationService');
const { modelsMatch } = require('../helpers/modelNameNormalization');
const {
  ACTIVE_ALERT_STATUS,
  normalizeAlertForRead
} = require('./alertFeedProjection');

class AlertService extends EventEmitter {
  constructor() {
    super();
    this.rules = [];
    this.config = {
      email: { enabled: false },
      slack: { enabled: false },
      webhook: { enabled: false },
      localLog: { enabled: true },
      cooldownMs: 300000, // 5 minutes
      maxOccurrences: 10,
      // Auto-resolve alerts whose condition stopped recurring (task 0361).
      // Must exceed cooldownMs so a still-firing alert is never swept.
      staleResolveMs: Number(process.env.ALERT_STALE_RESOLVE_MS) || 900000 // 15 minutes
    };
    this.testMode = process.env.NODE_ENV === 'test';
  }

  loadRules(rules) {
    if (!Array.isArray(rules)) {
      throw new Error('Rules must be an array');
    }

    this.rules = rules.filter(r => r && r.enabled !== false);
    return this.rules.length;
  }

  async evaluateEvent(event) {
    if (!event || typeof event !== 'object') return [];
    if (!Array.isArray(this.rules) || this.rules.length === 0) return [];

    const alerts = [];
    for (const rule of this.rules) {
      try {
        const materializedEvent = await this._materializeWindowFacts(rule, event);
        if (!materializedEvent || !this._ruleMatchesEvent(rule, materializedEvent)) continue;

        const alert = await this._createOrUpdateAlert(rule, materializedEvent);
        if (alert) alerts.push(alert);
      } catch (err) {
        logger.error('[AlertService] Failed to evaluate rule', {
          ruleId: rule?.id,
          error: err.message
        });
      }
    }

    return alerts;
  }

  _ruleMatchesEvent(rule, event) {
    // Support two rule formats:
    // 1) Simple threshold rules (unit tests): {metric, threshold, comparison, componentPattern}
    // 2) Rules-engine-like format (API tests): {conditions:{all:[{fact,operator,value}]}}
    const data = event.data && typeof event.data === 'object' ? event.data : event;

    if (rule?.conditions?.all && Array.isArray(rule.conditions.all)) {
      return rule.conditions.all.every((cond) => this._evaluateCondition(cond, data));
    }

    if (rule?.componentPattern) {
      const component = data.component || event.component || event.source || '';
      if (!this._matchesPattern(component, rule.componentPattern)) return false;
    }

    if (rule?.metric) {
      const metric = data.metric || event.metric;
      if (metric && metric !== rule.metric) return false;
      const value = data.value ?? event.value;
      return this._compare(value, rule.threshold, rule.comparison);
    }

    // If no explicit metric, allow matching by generic value/threshold if present
    if (rule?.threshold !== undefined) {
      const value = data.value ?? event.value;
      return this._compare(value, rule.threshold, rule.comparison);
    }

    return false;
  }

  _evaluateCondition(cond, data) {
    if (!cond || !data) return false;
    const actual = data[cond.fact];
    const expected = cond.value;

    switch (cond.operator) {
      case 'greaterThan':
      case 'greater_than':
        return typeof actual === 'number' && actual > expected;
      case 'lessThan':
      case 'less_than':
        return typeof actual === 'number' && actual < expected;
      case 'equal':
      case 'equals':
        return actual === expected;
      case 'notEqual':
        return actual !== expected;
      case 'greaterThanOrEqual':
        return typeof actual === 'number' && actual >= expected;
      case 'lessThanOrEqual':
        return typeof actual === 'number' && actual <= expected;
      case 'contains':
        return Array.isArray(actual)
          ? actual.includes(expected)
          : typeof actual === 'string' && actual.includes(String(expected));
      case 'matches':
        try {
          return new RegExp(String(expected)).test(String(actual ?? ''));
        } catch {
          return false;
        }
      default:
        return false;
    }
  }

  /**
   * Materialize allowlisted window facts before matching a rule.
   *
   * A window condition is deliberately declarative rather than a raw MongoDB
   * fragment. This makes "error rate > 5% over 1h" expressible without giving
   * persisted rules an arbitrary-query escape hatch.
   */
  async _materializeWindowFacts(rule, event) {
    const conditions = Array.isArray(rule?.conditions?.all) ? rule.conditions.all : [];
    const windowed = conditions.filter(condition => condition?.window);
    if (windowed.length === 0) return event;

    const sourceData = event?.data && typeof event.data === 'object'
      ? { ...event.data }
      : { ...(event || {}) };
    const sourceExtra = sourceData.additionalData && typeof sourceData.additionalData === 'object'
      ? sourceData.additionalData
      : {};
    const data = { ...sourceData, ...sourceExtra };

    // Cheap event-local predicates gate database work. Rate facts are only
    // queried for the event type that can make the rule relevant.
    const localConditions = conditions.filter(condition => !condition?.window);
    if (!localConditions.every(condition => this._evaluateCondition(condition, data))) return null;

    const computed = {};
    for (const condition of windowed) {
      const spec = condition.window || {};
      if (spec.source !== 'inferencelogs') {
        throw new Error(`Unsupported alert window source: ${spec.source || 'missing'}`);
      }

      const durationMs = Math.min(
        Math.max(Number(spec.durationMs) || 3600000, 60000),
        30 * 24 * 60 * 60 * 1000
      );
      const numeratorField = spec.numerator?.field;
      const allowedNumeratorFields = new Set(['status', 'caller', 'taskType', 'model', 'host', 'fallbackUsed']);
      if (!allowedNumeratorFields.has(numeratorField)) {
        throw new Error(`Unsupported inference rate numerator: ${numeratorField || 'missing'}`);
      }
      const values = Array.isArray(spec.numerator?.values)
        ? spec.numerator.values.slice(0, 20)
        : [spec.numerator?.value].filter(value => value !== undefined);
      if (values.length === 0) throw new Error('Inference rate numerator requires at least one value');

      const InferenceLog = require('../../models/InferenceLog');
      const match = { timestamp: { $gte: new Date(Date.now() - durationMs) } };
      const [total, numerator] = await Promise.all([
        InferenceLog.countDocuments(match),
        InferenceLog.countDocuments({
          ...match,
          [numeratorField]: values.length === 1 ? values[0] : { $in: values }
        })
      ]);
      const factName = String(condition.fact || 'rate').slice(0, 80);
      const rate = total > 0 ? Math.round((numerator / total) * 1000) / 10 : 0;
      computed[factName] = rate;
      computed[`${factName}Numerator`] = numerator;
      computed[`${factName}Total`] = total;
      computed.windowMs = durationMs;
      computed.windowLabel = this._formatWindow(durationMs);

      const minimumSamples = Math.max(0, Number(spec.minimumSamples) || 0);
      if (total < minimumSamples) return null;
    }

    const materialized = {
      ...sourceData,
      ...computed,
      additionalData: { ...sourceExtra, ...computed }
    };
    return event?.data && typeof event.data === 'object'
      ? { ...event, data: materialized }
      : materialized;
  }

  _formatWindow(durationMs) {
    if (durationMs % 3600000 === 0) return `${durationMs / 3600000}h`;
    if (durationMs % 60000 === 0) return `${durationMs / 60000}m`;
    return `${Math.round(durationMs / 1000)}s`;
  }

  _compare(value, threshold, comparison) {
    if (value === undefined || threshold === undefined) return false;
    if (typeof value !== 'number' || typeof threshold !== 'number') return false;

    switch (comparison) {
      case 'greater_than':
      case 'greaterThan':
      case undefined:
        return value > threshold;
      case 'less_than':
      case 'lessThan':
        return value < threshold;
      case 'equals':
      case 'equal':
        return value === threshold;
      default:
        return false;
    }
  }

  _matchesPattern(value, pattern) {
    if (!pattern) return true;
    if (pattern === '*') return true;
    const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const re = new RegExp(`^${escaped}$`);
    return re.test(String(value));
  }

  _templateValue(data, key) {
    return String(key).split('.').reduce((value, part) => value?.[part], data);
  }

  _templateContext(data) {
    const payloadKeys = /^(prompt|prompts|message|messages|transcript|completion|response|content|text|input|output|system)$/i;
    const safe = {};
    for (const [key, value] of Object.entries(data || {})) {
      if (payloadKeys.test(key) || key === 'additionalData') continue;
      if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) safe[key] = value;
    }
    const serialized = JSON.stringify(safe);
    return serialized.length > 800 ? `${serialized.slice(0, 797)}...` : serialized;
  }

  _renderTemplate(template, data) {
    if (!template) return '';
    const missing = new Set();
    const rendered = String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
      const v = this._templateValue(data, key);
      if (v === undefined || v === null || String(v).trim() === '') {
        missing.add(key);
        return `[missing:${key}]`;
      }
      return String(v);
    });
    if (missing.size === 0) return rendered;
    return `${rendered} [template_error missing=${[...missing].join(',')} context=${this._templateContext(data)}]`;
  }

  _severityFromRule(rule) {
    const sev = rule?.severity ?? rule?.event?.params?.severity;
    // Normalize to model enum
    if (sev === 'error') return 'error';
    if (sev === 'critical') return 'critical';
    if (sev === 'warning') return 'warning';
    return 'info';
  }

  _titleFromRule(rule, data) {
    const title = rule?.title ?? rule?.event?.params?.title ?? rule?.name ?? 'Alert Triggered';
    return this._renderTemplate(title, data);
  }

  _messageFromRule(rule, data) {
    const template = rule?.message ?? rule?.event?.params?.message;
    if (template) return this._renderTemplate(template, data);
    // No template on the rule — build a descriptive fallback from the event
    // instead of the useless "Alert conditions matched".
    const parts = [];
    const where = [data.model, data.host ? `on ${data.host}` : ''].filter(Boolean).join(' ');
    if (where) parts.push(where);
    else if (data.component) parts.push(data.component);
    if (data.metric) parts.push(data.value !== undefined && data.value !== null ? `${data.metric} = ${data.value}` : data.metric);
    if (data.threshold !== undefined && data.threshold !== null) parts.push(`threshold ${data.threshold}`);
    return parts.length ? parts.join(' · ') : 'Alert conditions matched';
  }

  _flapSeverity(severity) {
    return ({ info: 'warning', warning: 'error', error: 'critical', critical: 'critical' })[severity] || 'warning';
  }

  async _reopenFlappingAlert(rule, data, fingerprint, now) {
    const windowMs = 6 * 60 * 60 * 1000;
    const since = new Date(now.getTime() - windowMs);
    const previous = await Alert.findOne({
      fingerprint,
      status: 'resolved',
      'resolution.resolutionMethod': {
        $in: ['auto-recovery', 'auto-reachable', 'auto-stale']
      },
      'resolution.resolvedAt': { $gte: since }
    }).sort({ 'resolution.resolvedAt': -1 });
    if (!previous) return null;

    const flap = {
      detected: true,
      count: Math.max(1, Number(previous.metadata?.flapping?.count) || 1) + 1,
      windowMs,
      windowStartedAt: since
    };
    const baseSeverity = this._severityFromRule(rule);
    const presentation = this._flapPresentation(
      this._titleFromRule(rule, data),
      this._messageFromRule(rule, data),
      flap
    );
    const extra = data.additionalData && typeof data.additionalData === 'object'
      ? data.additionalData
      : null;

    // Re-open the same incident document. A host that alternates between
    // reachable and unreachable is one flapping condition, not a stream of
    // unrelated resolved alerts. The status predicate makes this an atomic
    // claim if two producers observe the same refire concurrently.
    const reopened = await Alert.findOneAndUpdate(
      { _id: previous._id, status: 'resolved' },
      {
        $set: {
          status: 'active',
          severity: this._flapSeverity(baseSeverity),
          title: presentation.title,
          message: presentation.message,
          lastOccurrence: now,
          'context.component': data.component,
          'context.metric': data.metric,
          'context.currentValue': data.value,
          'context.threshold': data.threshold,
          'context.additionalData': extra || data,
          'metadata.flapping': flap,
          'resolution.resolved': false,
          'resolution.resolvedAt': null,
          'resolution.resolvedBy': null,
          'resolution.resolutionMethod': null,
          'resolution.comment': null,
          lastNotifiedAt: now
        },
        $inc: { occurrenceCount: 1, notificationCount: 1 }
      },
      { new: true }
    );
    if (!reopened) return null;

    try {
      await this._sendNotifications(reopened, reopened.channels);
    } catch {
      // Notifications are best-effort; the incident state is authoritative.
    }
    return reopened;
  }

  _flapPresentation(title, message, flap) {
    if (!flap) return { title, message };
    const window = this._formatWindow(flap.windowMs);
    return {
      title: `FLAPPING — ${title} (${flap.count}× in ${window})`,
      message: `${message} · Repeated after automatic recovery; ${flap.count} fire cycles in ${window}.`
    };
  }

  _fingerprintFor(rule, data) {
    // host/model included so distinct hosts/models don't collapse into one alert
    // `incidentKey` lets a server-owned detector distinguish contracts or
    // campaigns without placing high-cardinality request IDs in the key.
    return crypto
      .createHash('md5')
      .update(`${rule?.id || rule?.ruleId || 'rule'}|${data.component || data.source || ''}|${data.host || ''}|${data.model || ''}|${data.metric || ''}|${data.incidentKey || ''}`)
      .digest('hex');
  }

  async _createOrUpdateAlert(rule, event) {
    const data = event.data && typeof event.data === 'object' ? { ...event.data } : { ...event };
    // Provide common fields for templating
    data.component = data.component || event.component || event.source || '';
    data.metric = data.metric || event.metric || '';
    data.value = data.value ?? event.value;
    data.threshold = data.threshold ?? rule.threshold;
    // Flatten producer additionalData (model, host, status, error, …) so
    // templates ({{model}}, {{host}}) and the fingerprint can see them.
    const extra = data.additionalData && typeof data.additionalData === 'object' ? data.additionalData : null;
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (data[k] === undefined) data[k] = v;
      }
    }

    const fingerprint = this._fingerprintFor(rule, data);
    const now = new Date();

    // One continuous incident per stable fingerprint. Recurrence updates the
    // same active/acknowledged document until verified recovery or the stale
    // resolver closes it; only a later recurrence creates a new incident.
    const updated = await Alert.findOneAndUpdate(
      {
        fingerprint,
        status: { $in: ['active', 'acknowledged'] }
      },
      {
        $set: {
          lastOccurrence: now,
          title: this._titleFromRule(rule, data),
          message: this._messageFromRule(rule, data),
          'context.currentValue': data.value,
          'context.threshold': data.threshold,
          'context.additionalData': extra || data
        },
        $inc: { occurrenceCount: 1 }
      },
      { new: true }
    );

    if (updated) {
      // A recurrence inside an already-open flap is another observation of
      // the same fire cycle, not a reason to erase the flapping presentation.
      const flap = updated.metadata?.flapping;
      if (flap?.detected) {
        const presentation = this._flapPresentation(
          this._titleFromRule(rule, data),
          this._messageFromRule(rule, data),
          flap
        );
        await Alert.findByIdAndUpdate(updated._id, {
          $set: { title: presentation.title, message: presentation.message }
        });
        updated.title = presentation.title;
        updated.message = presentation.message;
      }
      // Deduplicated. Historically this returned immediately, which meant a
      // condition that keeps failing is never re-announced: it stays active,
      // so the stale sweep never resolves it, so no new alert is ever created,
      // so no notification is ever sent again. Intermittent problems resolve
      // and re-fire (and do notify); constant ones go silent. Opt-in
      // re-notification (rule.renotifyMs > 0) closes that hole.
      await this._maybeRenotify(updated, rule);
      return updated;
    }

    const reopened = await this._reopenFlappingAlert(rule, data, fingerprint, now);
    if (reopened) return reopened;

    // Create new alert - use unique index to handle race conditions
    let alertDoc;
    try {
      const baseSeverity = this._severityFromRule(rule);
      const presentation = this._flapPresentation(
        this._titleFromRule(rule, data),
        this._messageFromRule(rule, data),
        null
      );
      alertDoc = await Alert.create({
        ruleId: rule?.id || 'rule',
        ruleName: rule?.name || 'Alert Rule',
        severity: baseSeverity,
        title: presentation.title,
        message: presentation.message,
        context: {
          component: data.component,
          metric: data.metric,
          currentValue: data.value,
          threshold: data.threshold,
          // producer's payload only — storing all of `data` here used to
          // double-nest additionalData (context.additionalData.additionalData.model)
          additionalData: extra || data
        },
        fingerprint,
        channels: rule?.channels || rule?.event?.params?.channels || ['local_log'],
        channelConfig: rule?.channelConfig || rule?.event?.params?.channelConfig,
        source: event.source || data.source || 'agentx',
        lastOccurrence: now,
        // Creation notifies below; stamping it here is what gives the
        // re-notification backoff its first anchor (task 0541).
        notificationCount: 1,
        lastNotifiedAt: now
      });
    } catch (err) {
      // Handle duplicate key error from concurrent creates - another thread won the race
      // Retry as update to increment the winner's occurrence count
      if (err.code === 11000) {
        alertDoc = await Alert.findOneAndUpdate(
          { fingerprint, status: 'active' },
          {
            $set: {
              lastOccurrence: now,
              title: this._titleFromRule(rule, data),
              message: this._messageFromRule(rule, data),
              'context.currentValue': data.value,
              'context.threshold': data.threshold,
              'context.additionalData': extra || data
            },
            $inc: { occurrenceCount: 1 }
          },
          { new: true }
        );
        return alertDoc;
      }
      throw err;
    }

    try {
      await this._sendNotifications(alertDoc, alertDoc.channels);
    } catch {
      // Notifications are best-effort; tests focus on DB behavior
    }

    return alertDoc;
  }

  /**
   * When the next notification for an ongoing incident becomes due.
   *
   * The interval doubles per notification already sent, so a long outage
   * escalates (15m, 30m, 60m, 2h, 4h …) instead of repeating forever at a
   * fixed rate. `ALERT_RENOTIFY_MAX_MS` caps the growth so a multi-day
   * incident still reports in rather than going quiet again.
   *
   * Anchored on `lastNotifiedAt` rather than `lastOccurrence`, because the
   * question is "how long since we last told anyone", not "how long since it
   * last failed" — the second is always ~now for a continuous failure, which
   * is exactly the case that used to stay silent.
   */
  _renotifyDueAt(alert, renotifyMs) {
    const sent = Math.max(0, Number(alert?.notificationCount) || 0);
    const anchor = alert?.lastNotifiedAt || alert?.createdAt;
    if (!anchor) return null;
    const maxMs = Math.max(
      renotifyMs,
      parseInt(process.env.ALERT_RENOTIFY_MAX_MS, 10) || 21600000 // 6h
    );
    // sent is 1 after the creation notification, so the first repeat waits
    // exactly renotifyMs rather than double it.
    const backoff = Math.min(renotifyMs * Math.pow(2, Math.max(0, sent - 1)), maxMs);
    return new Date(new Date(anchor).getTime() + backoff);
  }

  /**
   * Re-send notifications for an incident that is still open, if it is due.
   *
   * Opt-in per rule and best-effort: a notification failure must never break
   * the alert-recording path it is attached to.
   */
  async _maybeRenotify(alert, rule) {
    try {
      const renotifyMs = Number(rule?.renotifyMs) || 0;
      if (renotifyMs <= 0) return;
      if (!alert?.channels?.length) return;
      // Acknowledged means an operator already owns it; stop nagging.
      if (alert.status !== 'active') return;

      const dueAt = this._renotifyDueAt(alert, renotifyMs);
      if (!dueAt || Date.now() < dueAt.getTime()) return;

      // Claim the slot before sending so two concurrent producers hitting the
      // same fingerprint cannot both notify. The lastNotifiedAt guard makes
      // the update idempotent under that race.
      const claimed = await Alert.findOneAndUpdate(
        { _id: alert._id, status: 'active', lastNotifiedAt: alert.lastNotifiedAt || null },
        { $set: { lastNotifiedAt: new Date() }, $inc: { notificationCount: 1 } },
        { new: true }
      );
      if (!claimed) return;

      await this._sendNotifications(claimed, claimed.channels);
      logger.info('[AlertService] Re-notified ongoing alert', {
        fingerprint: claimed.fingerprint,
        occurrenceCount: claimed.occurrenceCount,
        notificationCount: claimed.notificationCount
      });
    } catch (err) {
      logger.warn('[AlertService] Re-notification failed (non-fatal)', { error: err.message });
    }
  }

  async _sendNotifications(alert, channels) {
    const results = {};
    const notificationService = getNotificationService();

    for (const channel of channels) {
      try {
        if (channel === 'local_log') {
          logger.info(`[AlertService] Sending to local log: ${alert.title}`);
          // In real impl, might call external API
          results[channel] = { sent: true };
        } else if (['email', 'slack', 'telegram', 'webhook'].includes(channel)) {
          // Use notification service for external channels
          logger.info(`[AlertService] Sending to ${channel}: ${alert.title}`);
          results[channel] = await notificationService.send(channel, alert);
        } else {
          logger.warn(`[AlertService] Channel ${channel} not implemented`);
          results[channel] = { sent: false, error: 'Not implemented' };
        }
      } catch (err) {
        logger.error(`[AlertService] Failed to send to ${channel}`, err);
        results[channel] = { sent: false, error: err.message };
      }
    }

    // Update alert delivery status
    // We need to update the alert document with the results
    try {
      const alertId = alert?._id;
      if (!alertId || !mongoose.isValidObjectId(alertId)) {
        return results;
      }
      const updates = {};
      for (const [channel, result] of Object.entries(results)) {
        updates[`delivery.${channel}.sent`] = result.sent;
        updates[`delivery.${channel}.sentAt`] = new Date();
        if (result.error) {
          updates[`delivery.${channel}.error`] = result.error;
        }
        if (channel === 'email' && result.recipients) {
          updates[`delivery.${channel}.recipients`] = String(result.recipients)
            .split(',')
            .map(recipient => recipient.trim())
            .filter(Boolean);
        }
        if (channel === 'webhook' && result.url) {
          updates[`delivery.${channel}.url`] = result.url;
        }
        if (channel === 'webhook' && result.statusCode) {
          updates[`delivery.${channel}.statusCode`] = result.statusCode;
        }
      }
      await Alert.findByIdAndUpdate(alert._id, { $set: updates });
    } catch (err) {
        logger.error('[AlertService] Failed to update alert delivery status', err);
    }

    return results;
  }

  async acknowledgeAlert(id, userId, comment) {
    const alert = await Alert.findById(id);
    if (!alert) throw new Error('Alert not found');
    return alert.acknowledge(userId, comment);
  }

  async resolveAlert(id, userId, method, resolution) {
    const alert = await Alert.findById(id);
    if (!alert) throw new Error('Alert not found');
    return alert.resolve(userId, method, resolution);
  }

  /**
   * Auto-resolve alerts whose condition has stopped recurring. Event-driven
   * alerts carry no explicit "cleared" signal — when e.g. a host becomes
   * reachable again, no new event fires, so the active alert would otherwise
   * linger forever (task 0361: an inference-proxy host-unreachable critical
   * from 2026-07-03 stayed active for days). This sweep resolves any
   * active/acknowledged alert not seen for maxAgeMs. Recovery-aware inference
   * producers can close incidents earlier through
   * resolveRecoveredInferenceAlerts().
   * @param {number} [maxAgeMs=this.config.staleResolveMs]
   * @returns {Promise<number>} count of alerts resolved
   */
  async resolveStaleAlerts(maxAgeMs = this.config.staleResolveMs) {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const now = new Date();
    const res = await Alert.updateMany(
      { status: { $in: ['active', 'acknowledged'] }, lastOccurrence: { $lt: cutoff } },
      { $set: {
          status: 'resolved',
          'resolution.resolved': true,
          'resolution.resolvedAt': now,
          'resolution.resolvedBy': 'system',
          'resolution.resolutionMethod': 'auto-stale'
      } }
    );
    const n = (res && (res.modifiedCount != null ? res.modifiedCount : res.nModified)) || 0;
    if (n > 0) logger.info('[AlertService] auto-resolved stale alerts', { count: n, maxAgeMs });
    return n;
  }

  /**
   * Resolve inference alerts after a successful request proves recovery.
   * Host/error alerts clear on any success for the same host/model. Latency
   * alerts clear only when the successful request is at or below threshold.
   */
  async resolveRecoveredInferenceAlerts({
    host,
    hostKey,
    model,
    latencyMs,
    latencyThresholdMs = 10000
  } = {}) {
    const identities = new Set(
      [host, hostKey]
        .filter(Boolean)
        .map(value => String(value).trim().replace(/\/+$/, '').toLowerCase())
    );
    if (identities.size === 0) return 0;

    const ruleIds = ['host-unreachable', 'inference-error'];
    if (Number.isFinite(latencyMs) && latencyMs <= latencyThresholdMs) {
      ruleIds.push('latency-spike');
    }

    const candidates = await Alert.find({
      status: { $in: ['active', 'acknowledged'] },
      ruleId: { $in: ruleIds }
    }).lean();

    const matchingIds = candidates
      .filter((alert) => {
        const context = alert.context || {};
        const extra = context.additionalData || {};
        const alertIdentities = [context.component, extra.host]
          .filter(Boolean)
          .map(value => String(value).trim().replace(/\/+$/, '').toLowerCase());
        if (!alertIdentities.some(value => identities.has(value))) return false;
        return !extra.model || !model || modelsMatch(extra.model, model);
      })
      .map(alert => alert._id);

    if (matchingIds.length === 0) return 0;

    const now = new Date();
    const result = await Alert.updateMany(
      { _id: { $in: matchingIds }, status: { $in: ['active', 'acknowledged'] } },
      { $set: {
        status: 'resolved',
        'resolution.resolved': true,
        'resolution.resolvedAt': now,
        'resolution.resolvedBy': 'system',
        'resolution.resolutionMethod': 'auto-recovery',
        'resolution.comment': `Verified successful inference on ${hostKey || host}`
      } }
    );
    const count = result?.modifiedCount ?? result?.nModified ?? 0;
    if (count > 0) {
      logger.info('[AlertService] auto-resolved recovered inference alerts', {
        count,
        host,
        hostKey,
        model
      });
    }
    return count;
  }

  async getStatistics(filters) {
    return Alert.getStatistics(filters);
  }

  /**
   * Read a bounded alert page and its counts from one Mongo aggregation.
   * Counts therefore describe the same persisted snapshot and filters as the
   * returned rows instead of racing a separate count/statistics request.
   */
  async getAlertSnapshot({ limit = 50, skip = 0, filters = {}, sort = 'severity', maxLimit = 100 } = {}) {
    const boundedMax = Math.min(Math.max(Number.parseInt(maxLimit, 10) || 100, 1), 500);
    const boundedLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), boundedMax);
    const boundedSkip = Math.max(Number.parseInt(skip, 10) || 0, 0);
    const match = {};
    if (filters.severity) match.severity = filters.severity;
    if (filters.status) match.status = filters.status;
    if (filters.ruleId) match.ruleId = filters.ruleId;

    const sortSpec = sort === 'recency'
      ? { lastOccurrence: -1, createdAt: -1 }
      : { __severityRank: -1, lastOccurrence: -1, createdAt: -1 };

    const [facet = {}] = await Alert.aggregate([
      { $match: match },
      {
        $addFields: {
          __severityRank: {
            $switch: {
              branches: [
                { case: { $eq: ['$severity', 'critical'] }, then: 3 },
                { case: { $eq: ['$severity', 'error'] }, then: 2 },
                { case: { $eq: ['$severity', 'warning'] }, then: 1 },
                { case: { $eq: ['$severity', 'info'] }, then: 0 }
              ],
              default: 0
            }
          }
        }
      },
      {
        $facet: {
          alerts: [
            { $sort: sortSpec },
            { $skip: boundedSkip },
            { $limit: boundedLimit },
            { $project: { __severityRank: 0 } }
          ],
          totals: [{ $count: 'count' }],
          bySeverity: [{ $group: { _id: '$severity', count: { $sum: 1 } } }],
          byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }]
        }
      }
    ]);

    const toCountObject = rows => (rows || []).reduce((counts, row) => {
      if (row?._id) counts[row._id] = row.count;
      return counts;
    }, {});
    const bySeverity = toCountObject(facet.bySeverity);
    const byStatus = toCountObject(facet.byStatus);
    const total = facet.totals?.[0]?.count || 0;
    const activeCount = filters.status === ACTIVE_ALERT_STATUS
      ? total
      : (byStatus[ACTIVE_ALERT_STATUS] || 0);

    return {
      alerts: (facet.alerts || []).map(normalizeAlertForRead),
      total,
      limit: boundedLimit,
      skip: boundedSkip,
      summary: {
        total,
        activeCount,
        bySeverity,
        byStatus,
        basis: {
          entity: 'persisted_alert',
          activePredicate: { status: ACTIVE_ALERT_STATUS },
          appliedFilters: { ...match }
        },
        observedAt: new Date().toISOString()
      }
    };
  }

  async getRecentAlerts(limit = 10, filters = {}) {
    const query = {};
    if (filters.severity) query.severity = filters.severity;
    if (filters.status) query.status = filters.status;
    if (filters.ruleId) query.ruleId = filters.ruleId;

    return Alert.find(query)
      .sort({ lastOccurrence: -1, createdAt: -1 })
      .limit(limit);
  }

}

// Singleton instance
const alertService = new AlertService();

module.exports = alertService;
