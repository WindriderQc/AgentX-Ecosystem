'use strict';

// Only repeated, fresh probe evidence may select a runtime context. Legacy
// migration stamps are deliberately not current recommendation authority.
const RECOMMENDATION_EVIDENCE_VERSION = 'context-probe-degradation-v4';

module.exports = { RECOMMENDATION_EVIDENCE_VERSION };
