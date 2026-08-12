const mongoose = require('mongoose');

const BenchmarkConfigSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  value: mongoose.Schema.Types.Mixed,
}, { collection: 'benchmarkconfigs', timestamps: true });

module.exports = mongoose.model('BenchmarkConfig', BenchmarkConfigSchema);
