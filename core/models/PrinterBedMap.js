const mongoose = require('mongoose');

const PrinterBedMapSchema = new mongoose.Schema({
  printerId: { type: String, required: true, index: true },
  printerName: { type: String, required: true },
  mode: { type: String, enum: ['MANUAL'], default: 'MANUAL' },
  note: { type: String, default: '', maxlength: 500 },
  points: [{
    id: { type: String, required: true }, label: { type: String, required: true },
    x: { type: Number, required: true }, y: { type: Number, required: true }, z: { type: Number, required: true }
  }]
}, { timestamps: true });

module.exports = mongoose.model('PrinterBedMap', PrinterBedMapSchema);
