const mongoose = require('mongoose');

const RouterTaskConfigSchema = new mongoose.Schema({
  taskType: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },
  model: {
    type: String,
    required: true,
    trim: true
  },
  host: {
    type: String,
    required: true,
    trim: true
  }
}, {
  timestamps: true,
  collection: 'routertaskconfigs'
});

module.exports = mongoose.model('RouterTaskConfig', RouterTaskConfigSchema);
