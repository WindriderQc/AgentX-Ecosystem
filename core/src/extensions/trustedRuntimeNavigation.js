'use strict';

// The contract lives in shared/ so Benchmark and RAG validate launchers with
// the exact same rules when they consume Core's `/api/config` navigation.
module.exports = require('../../../shared/trustedRuntimeNavigation');
