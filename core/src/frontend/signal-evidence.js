/**
 * @file Browser entry for the Signal Evidence Contract.
 * Built by esbuild -> public/dist/signal-evidence.js so that pages consume
 * the exact same implementation as the Core routes (shared/signalEvidence.js).
 */
import contract from '../../../shared/signalEvidence.js';

export const {
  SIGNAL_EVIDENCE_SCHEMA,
  SIGNAL_STATES,
  SIGNAL_KINDS,
  SIGNAL_LABELS,
  SIGNAL_TONES,
  FRESHNESS_STATES,
  COMPARISON_STATES,
  PLACEHOLDER,
  buildSignal,
  countSignal,
  ratioSignal,
  averageSignal,
  differenceSignal,
  rankingSignal,
  freshnessOf,
  validateSignal,
  serializeSignal,
  parseSignal,
  formatSignal,
  describeSample,
  isValueBearing,
} = contract;
