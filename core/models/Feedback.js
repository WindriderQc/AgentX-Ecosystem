/**
 * Feedback Model
 * Stores user feedback on AI responses for analytics and A/B testing
 */

const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema({
    conversationId: {
        type: String,
        required: true,
        index: true
    },
    messageId: {
        type: String,
        required: true
    },
    rating: {
        type: String,
        enum: ['positive', 'negative', 'neutral'],
        required: true,
        index: true
    },
    comment: {
        type: String,
        maxlength: 1000
    },
    model: {
        type: String,
        index: true
    },
    promptName: {
        type: String,
        index: true
    },
    promptVersion: {
        type: String,
        index: true
    },
    promptConfigId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'PromptConfig'
    },
    userId: {
        type: String,
        index: true
    },
    sessionId: {
        type: String
    },
    metadata: {
        responseTime: Number,      // ms
        tokenCount: Number,
        temperature: Number,
        taskType: String,
        host: String               // which Ollama host was used
    }
}, {
    timestamps: true
});

// Compound indexes for efficient queries
feedbackSchema.index({ promptName: 1, promptVersion: 1 });
feedbackSchema.index({ rating: 1, createdAt: -1 });
feedbackSchema.index({ model: 1, rating: 1 });

// Static methods for analytics
feedbackSchema.statics.getSummary = async function(options = {}) {
    const { startDate, endDate, promptName, model } = options;

    const match = {};

    if (startDate || endDate) {
        match.createdAt = {};
        if (startDate) match.createdAt.$gte = new Date(startDate);
        if (endDate) match.createdAt.$lte = new Date(endDate);
    }

    if (promptName) match.promptName = promptName;
    if (model) match.model = model;

    const pipeline = [
        { $match: match },
        {
            $group: {
                _id: null,
                totalFeedback: { $sum: 1 },
                positiveCount: {
                    $sum: { $cond: [{ $eq: ['$rating', 'positive'] }, 1, 0] }
                },
                negativeCount: {
                    $sum: { $cond: [{ $eq: ['$rating', 'negative'] }, 1, 0] }
                },
                neutralCount: {
                    $sum: { $cond: [{ $eq: ['$rating', 'neutral'] }, 1, 0] }
                }
            }
        },
        {
            $project: {
                _id: 0,
                totalFeedback: 1,
                positiveCount: 1,
                negativeCount: 1,
                neutralCount: 1,
                positiveRate: {
                    $cond: [
                        { $gt: ['$totalFeedback', 0] },
                        { $divide: ['$positiveCount', '$totalFeedback'] },
                        0
                    ]
                }
            }
        }
    ];

    const result = await this.aggregate(pipeline);
    return result[0] || { totalFeedback: 0, positiveCount: 0, negativeCount: 0, neutralCount: 0, positiveRate: 0 };
};

feedbackSchema.statics.getByModel = async function(options = {}) {
    const { startDate, endDate } = options;

    const match = {};
    if (startDate || endDate) {
        match.createdAt = {};
        if (startDate) match.createdAt.$gte = new Date(startDate);
        if (endDate) match.createdAt.$lte = new Date(endDate);
    }

    const pipeline = [
        { $match: match },
        {
            $group: {
                _id: '$model',
                total: { $sum: 1 },
                positive: {
                    $sum: { $cond: [{ $eq: ['$rating', 'positive'] }, 1, 0] }
                },
                negative: {
                    $sum: { $cond: [{ $eq: ['$rating', 'negative'] }, 1, 0] }
                }
            }
        },
        {
            $project: {
                _id: 1,
                total: 1,
                positive: 1,
                negative: 1,
                positiveRate: {
                    $cond: [
                        { $gt: ['$total', 0] },
                        { $divide: ['$positive', '$total'] },
                        0
                    ]
                }
            }
        },
        { $sort: { total: -1 } }
    ];

    return this.aggregate(pipeline);
};

feedbackSchema.statics.getByPromptVersion = async function(options = {}) {
    const { startDate, endDate, promptName } = options;

    const match = {};
    if (startDate || endDate) {
        match.createdAt = {};
        if (startDate) match.createdAt.$gte = new Date(startDate);
        if (endDate) match.createdAt.$lte = new Date(endDate);
    }
    if (promptName) match.promptName = promptName;

    const pipeline = [
        { $match: match },
        {
            $group: {
                _id: {
                    promptName: '$promptName',
                    version: '$promptVersion'
                },
                total: { $sum: 1 },
                positive: {
                    $sum: { $cond: [{ $eq: ['$rating', 'positive'] }, 1, 0] }
                },
                negative: {
                    $sum: { $cond: [{ $eq: ['$rating', 'negative'] }, 1, 0] }
                }
            }
        },
        {
            $project: {
                _id: 1,
                total: 1,
                positive: 1,
                negative: 1,
                positiveRate: {
                    $cond: [
                        { $gt: ['$total', 0] },
                        { $divide: ['$positive', '$total'] },
                        0
                    ]
                }
            }
        },
        { $sort: { total: -1 } }
    ];

    return this.aggregate(pipeline);
};

feedbackSchema.statics.getLowPerformers = async function(threshold = 0.7, minSamples = 10) {
    const pipeline = [
        {
            $group: {
                _id: {
                    promptName: '$promptName',
                    version: '$promptVersion'
                },
                total: { $sum: 1 },
                positive: {
                    $sum: { $cond: [{ $eq: ['$rating', 'positive'] }, 1, 0] }
                }
            }
        },
        {
            $match: {
                total: { $gte: minSamples }
            }
        },
        {
            $project: {
                _id: 1,
                total: 1,
                positive: 1,
                positiveRate: { $divide: ['$positive', '$total'] }
            }
        },
        {
            $match: {
                positiveRate: { $lt: threshold }
            }
        },
        { $sort: { positiveRate: 1 } }
    ];

    return this.aggregate(pipeline);
};

feedbackSchema.statics.getABComparison = async function(promptName) {
    const pipeline = [
        { $match: { promptName } },
        {
            $group: {
                _id: '$promptVersion',
                total: { $sum: 1 },
                positive: {
                    $sum: { $cond: [{ $eq: ['$rating', 'positive'] }, 1, 0] }
                },
                negative: {
                    $sum: { $cond: [{ $eq: ['$rating', 'negative'] }, 1, 0] }
                }
            }
        },
        {
            $project: {
                version: '$_id',
                total: 1,
                positive: 1,
                negative: 1,
                positiveRate: {
                    $cond: [
                        { $gt: ['$total', 0] },
                        { $divide: ['$positive', '$total'] },
                        0
                    ]
                }
            }
        },
        { $sort: { positiveRate: -1 } }
    ];

    const results = await this.aggregate(pipeline);

    if (results.length < 2) {
        return { versions: results, comparison: null };
    }

    // Calculate improvement of best over baseline (first version)
    const control = results.find(r => r.version === 'control') || results[results.length - 1];
    const best = results[0];

    const improvement = control.positiveRate > 0
        ? ((best.positiveRate - control.positiveRate) / control.positiveRate) * 100
        : 0;

    return {
        promptName,
        control: control,
        variants: results.filter(r => r.version !== control.version),
        improvement: Math.round(improvement * 100) / 100,
        winner: best.version,
        sampleSize: results.reduce((sum, r) => sum + r.total, 0)
    };
};

module.exports = mongoose.model('Feedback', feedbackSchema);
