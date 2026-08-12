const mongoose = require('mongoose');

const PrinterVisionStatusSchema = new mongoose.Schema({
  printerId: { type: String, required: true, unique: true, index: true },
  printerName: { type: String, required: true },
  monitorState: { type: String, enum: ['ACTIVE', 'OFFLINE'], required: true },
  controlMode: { type: String, enum: ['ALERT ONLY'], required: true },
  status: { type: String, enum: ['SAFE', 'WATCH', 'ALERT'], required: true },
  confidence: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'], required: true },
  observations: { type: String, required: true, maxlength: 2000 },
  firstAnalysisAt: { type: Date, required: true },
  lastAnalysisAt: { type: Date, required: true, index: true },
  intervalSeconds: { type: Number, required: true, min: 15, max: 3600 },
  model: { type: String, required: true, maxlength: 200 },
  imageBase64: { type: String, required: true, maxlength: 2 * 1024 * 1024 }
}, { timestamps: true });

module.exports = mongoose.model('PrinterVisionStatus', PrinterVisionStatusSchema);
