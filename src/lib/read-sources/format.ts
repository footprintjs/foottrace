import type { ReadSourceLimits } from './types.js';

/** Immutable wire-v1 admission ceilings, independent of writer tuning. Changes need a new format. */
export const READ_SOURCE_V1_CEILINGS: ReadSourceLimits = Object.freeze({
  maxOccurrences: 65536,
  maxPerExecution: 16384,
  maxBytes: 16 * 1024 * 1024,
  maxOrigins: 65536,
  maxStaging: 16384,
});
