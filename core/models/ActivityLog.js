const mongoose = require('mongoose');

const ActivityLogSchema = new mongoose.Schema({
  action: {
    type: String,
    required: true,
    index: true,
    enum: ['feature_flag_created', 'feature_flag_updated', 'feature_flag_deleted', 'feature_flag_toggled',
           'scan_codebase', 'clear_telemetry', 'export_report', 'sync_roadmap',
           'inventory_updated', 'feature_created', 'feature_deleted', 'system_action']
  },

  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UserProfile',
    index: true
  },

  username: String, // Snapshot for display

  target: String, // What was affected (feature name, flag name, etc.)

  details: mongoose.Schema.Types.Mixed, // Additional context

  status: {
    type: String,
    enum: ['success', 'failure', 'pending'],
    default: 'success'
  },

  errorMessage: String, // If status is 'failure'

  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  },

  ipAddress: String,

  userAgent: String
});

// Compound indexes for efficient queries
ActivityLogSchema.index({ action: 1, timestamp: -1 });
ActivityLogSchema.index({ userId: 1, timestamp: -1 });
ActivityLogSchema.index({ timestamp: -1 }); // Recent activity

// Helper methods

/**
 * Get recent activity log
 */
ActivityLogSchema.statics.getRecentActivity = async function(limit = 50, filters = {}) {
  const query = {};

  if (filters.action) query.action = filters.action;
  if (filters.userId) query.userId = filters.userId;
  if (filters.status) query.status = filters.status;

  return this.find(query)
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean();
};

/**
 * Get activity summary for a time period
 */
ActivityLogSchema.statics.getActivitySummary = async function(daysBack = 7) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  return this.aggregate([
    { $match: { timestamp: { $gte: cutoff } } },
    {
      $group: {
        _id: '$action',
        count: { $sum: 1 },
        lastOccurrence: { $max: '$timestamp' },
        successCount: {
          $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] }
        },
        failureCount: {
          $sum: { $cond: [{ $eq: ['$status', 'failure'] }, 1, 0] }
        }
      }
    },
    { $sort: { count: -1 } }
  ]);
};

/**
 * Log an activity
 */
ActivityLogSchema.statics.logActivity = async function(activityData) {
  const log = new this(activityData);
  return log.save();
};

module.exports = mongoose.model('ActivityLog', ActivityLogSchema);
