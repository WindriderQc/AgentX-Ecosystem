'use strict';

const express = require('express');
const { platformEventIngress } = require('../src/services/platformEventIngress');

const router = express.Router();

// Generic, server-to-server platform event ingress. This route feeds the same
// in-process bus exposed to Nestor by /api/consumers/nestor/v1/events/stream.
router.post('/', platformEventIngress);

module.exports = router;
