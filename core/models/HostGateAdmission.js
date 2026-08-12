'use strict';

const mongoose = require('mongoose');

const HostGateAdmissionSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  key: { type: String, required: true, index: true },
  host: { type: String, required: true, index: true },
  model: { type: String, required: true, index: true },
  slot: { type: Number, required: true },
  ownerId: { type: String, required: true, index: true },
  acquiredAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true }
}, {
  collection: 'host_gate_admissions',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
});

HostGateAdmissionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
HostGateAdmissionSchema.index({ key: 1, slot: 1 }, { unique: true });
HostGateAdmissionSchema.index({ ownerId: 1, key: 1 });

module.exports = mongoose.models.HostGateAdmission || mongoose.model('HostGateAdmission', HostGateAdmissionSchema);
