const mongoose = require('mongoose');

/**
 * Alert Model - Track 1: Alerts & Notifications
 *
 * Stores alert history, delivery status, and acknowledgment tracking
 * Used by AlertService to evaluate rules and trigger notifications
 */
const AlertSchema = new mongoose.Schema({
  // Alert identification
  ruleId: {
    type: String,
    default: 'manual',
    index: true
  },
  ruleName: {
    type: String,
    default: 'Manual Alert'
  },

  // Severity and status
  severity: {
    type: String,
    enum: ['info', 'warning', 'error', 'critical'],
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['active', 'acknowledged', 'resolved', 'suppressed'],
    default: 'active',
    index: true
  },

  // Alert content
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },

  // Context data from detection
  context: {
    component: String,           // e.g., "ollama-99", "prompt:default_chat"
    metric: String,              // e.g., "avg_response_time", "positive_rate"
    currentValue: mongoose.Schema.Types.Mixed,
    threshold: mongoose.Schema.Types.Mixed,
    trend: String,               // e.g., "degrading", "improving", "stable"
    relatedEvents: [String],     // Related event IDs or log references
    additionalData: mongoose.Schema.Types.Mixed
  },

  // Notification channels and delivery
  channels: [{
    type: String,
    enum: ['email', 'slack', 'telegram', 'webhook', 'dataapi_log']
  }],
  channelConfig: {
    email: {
      recipients: {
        type: [String],
        validate: {
          validator: function(recipients) {
            if (!Array.isArray(recipients) || recipients.length === 0) return true;
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            return recipients.every(email => emailRegex.test(email));
          },
          message: 'All email recipients must be valid email addresses'
        }
      },
      subject: String,
      from: {
        type: String,
        validate: {
          validator: function(email) {
            if (!email) return true;
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            return emailRegex.test(email);
          },
          message: 'From address must be a valid email address'
        }
      },
      replyTo: {
        type: String,
        validate: {
          validator: function(email) {
            if (!email) return true;
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            return emailRegex.test(email);
          },
          message: 'ReplyTo address must be a valid email address'
        }
      }
    },
    webhook: {
      url: {
        type: String,
        validate: {
          validator: function(url) {
            if (!url) return true;
            try {
              const parsed = new URL(url);
              return ['http:', 'https:'].includes(parsed.protocol);
            } catch {
              return false;
            }
          },
          message: 'Webhook URL must be a valid HTTP/HTTPS URL'
        }
      },
      method: { type: String, default: 'POST' },
      headers: mongoose.Schema.Types.Mixed,
      template: String
    }
  },
  delivery: {
    email: {
      sent: { type: Boolean, default: false },
      sentAt: Date,
      recipients: [String],
      error: String
    },
    slack: {
      sent: { type: Boolean, default: false },
      sentAt: Date,
      channelId: String,
      messageTs: String,          // Slack message timestamp for threading
      error: String
    },
    telegram: {
      sent: { type: Boolean, default: false },
      sentAt: Date,
      chatId: String,
      messageId: String,
      error: String,
      attempts: { type: Number, default: 0 },
      lastError: String
    },
    webhook: {
      sent: { type: Boolean, default: false },
      sentAt: Date,
      url: String,
      statusCode: Number,
      error: String,
      attempts: { type: Number, default: 0 },
      lastError: String
    },
    dataapi_log: {
      sent: { type: Boolean, default: false },
      sentAt: Date,
      eventId: String,
      error: String
    }
  },

  // Acknowledgment tracking
  acknowledgment: {
    acknowledged: { type: Boolean, default: false },
    acknowledgedBy: String,
    acknowledgedAt: Date,
    comment: String
  },

  // Resolution tracking
  resolution: {
    resolved: { type: Boolean, default: false },
    resolvedAt: Date,
    resolvedBy: String,
    resolutionMethod: String,    // e.g., "auto", "manual", "remediation"
    comment: String
  },

  // Deduplication tracking
  fingerprint: {
    type: String,
    required: true
  },
  occurrenceCount: {
    type: Number,
    default: 1
  },
  lastOccurrence: {
    type: Date,
    default: Date.now,
    index: true
  },

  // Re-notification escalation state (task 0541). Distinct from
  // occurrenceCount: an incident can recur hundreds of times while being
  // notified a handful of times. `notificationCount` drives the doubling
  // backoff, so it is the field that decides WHEN the next notification is
  // allowed — not how often the condition was observed.
  notificationCount: {
    type: Number,
    default: 0
  },
  lastNotifiedAt: {
    type: Date,
    default: null
  },

  // Related alerts and incidents
  parentAlertId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Alert'
  },
  relatedAlertIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Alert'
  }],
  incidentId: String,            // For incident management system integration

  // Metadata
  source: {
    type: String,
    default: 'agentx'
  },
  tags: [String],
  metadata: mongoose.Schema.Types.Mixed
}, {
  timestamps: true,
  autoIndex: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for common queries
AlertSchema.index({ status: 1, severity: 1, createdAt: -1 });
AlertSchema.index({ ruleId: 1, status: 1, createdAt: -1 });
AlertSchema.index({ fingerprint: 1, status: 1, lastOccurrence: -1 });
AlertSchema.index({ 'context.component': 1, status: 1, createdAt: -1 });

// Unique partial index to prevent duplicate active alerts with same fingerprint
// This enables atomic upsert deduplication under concurrent load
AlertSchema.index(
  { fingerprint: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'active' },
    name: 'fingerprint_active_unique'
  }
);

// Virtual for time since last occurrence
AlertSchema.virtual('timeSinceLastOccurrence').get(function() {
  return Date.now() - this.lastOccurrence.getTime();
});

// Back-compat virtual alias used by some routes/tests
AlertSchema.virtual('deliveryStatus')
  .get(function() {
    return this.delivery;
  })
  .set(function(value) {
    this.delivery = value;
  });

// Method to check if alert should be deduplicated
AlertSchema.methods.shouldDeduplicate = function(cooldownMs) {
  return this.timeSinceLastOccurrence < cooldownMs;
};

// Method to acknowledge alert
AlertSchema.methods.acknowledge = function(userId, comment) {
  this.status = 'acknowledged';
  this.acknowledgment = {
    acknowledged: true,
    acknowledgedBy: userId,
    acknowledgedAt: new Date(),
    comment: comment || ''
  };
  return this.save();
};

// Method to resolve alert
AlertSchema.methods.resolve = function(userId, method, comment) {
  this.status = 'resolved';
  this.resolution = {
    resolved: true,
    resolvedAt: new Date(),
    resolvedBy: userId,
    resolutionMethod: method || 'manual',
    comment: comment || ''
  };
  return this.save();
};

// Static method to find active alerts by rule
AlertSchema.statics.findActiveByRule = function(ruleId) {
  return this.find({
    ruleId,
    status: 'active'
  }).sort({ createdAt: -1 });
};

// Static method to find recent alerts by fingerprint
AlertSchema.statics.findRecentByFingerprint = function(fingerprint, hoursAgo = 1) {
  const since = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  return this.findOne({
    fingerprint,
    lastOccurrence: { $gte: since }
  }).sort({ lastOccurrence: -1 });
};

// Static method to get alert statistics
AlertSchema.statics.getStatistics = async function(filters = {}) {
  const match = {};
  if (filters.from) match.createdAt = { $gte: new Date(filters.from) };
  if (filters.to) match.createdAt = { ...match.createdAt, $lte: new Date(filters.to) };
  if (filters.severity) match.severity = filters.severity;
  if (filters.status) match.status = filters.status;

  const results = await this.aggregate([
    { $match: match },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 }
            }
          }
        ],
        bySeverity: [
          { $group: { _id: '$severity', count: { $sum: 1 } } }
        ],
        byStatus: [
          { $group: { _id: '$status', count: { $sum: 1 } } }
        ]
      }
    }
  ]);

  return results.map((r) => ({
    total: r.totals?.[0]?.total ?? 0,
    bySeverity: (r.bySeverity || []).reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {}),
    byStatus: (r.byStatus || []).reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {})
  }));
};

// Static method to get active alerts (common query)
AlertSchema.statics.getActive = function(limit = 50) {
  return this.find({ status: 'active' })
    .sort({ severity: 1, createdAt: -1 }) // Critical first
    .limit(limit);
};

// Static method to suppress alert temporarily
AlertSchema.methods.suppress = function(durationMs, reason) {
  this.status = 'suppressed';
  this.metadata = this.metadata || {};
  this.metadata.suppressedUntil = new Date(Date.now() + durationMs);
  this.metadata.suppressReason = reason;
  return this.save();
};

const Alert = mongoose.model('Alert', AlertSchema);

// Convenience helper used by self-healing + tests.
// Implemented as a getter alias so when tests do `jest.spyOn(Alert, 'create')`,
// `Alert.createAlert` resolves to the same mock function.
Object.defineProperty(Alert, 'createAlert', {
  configurable: true,
  enumerable: true,
  get() {
    return this.create;
  }
});

module.exports = Alert;
