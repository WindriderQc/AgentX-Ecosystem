const mongoose = require('mongoose');

const BenchmarkTemplateSchema = new mongoose.Schema({
    name: { type: String, required: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 2000 },
    config: {
        host: { type: String },
        models: { type: [String], default: [] },
        levels: { type: [Number], default: [] },
        judge_config: { type: Object, default: {} },
        execution_config: { type: Object, default: {} },
        execution_mode: { type: String, enum: ['latency', 'throughput'], default: 'latency' },
        depth_config: { type: Object, default: null }
    },
    tags: { type: [String], default: [] },
    source_batch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'BenchmarkBatch', default: null },
    run_count: { type: Number, default: 0 }
}, { collection: 'benchmarktemplates', timestamps: true });

BenchmarkTemplateSchema.index({ name: 1 });

module.exports = mongoose.model('BenchmarkTemplate', BenchmarkTemplateSchema);
