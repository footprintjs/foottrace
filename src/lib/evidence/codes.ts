/** One canonical vocabulary for recorded trace limits and unresolved evidence requirements. */
export const GAP_CODES = Object.freeze([
  'not-collected',
  'untracked-input',
  'redacted',
  'conservative',
  'scope-boundary',
  'invalid-data',
  'unavailable',
  'timeout',
  'cancelled',
  'cycle',
  'node-limit',
  'depth-limit',
  'edge-limit',
  'call-limit',
  'truncated',
  'strategy-failed',
  'not-checked',
  'no-match',
  'ambiguous',
  'stale',
  'incompatible',
  'unsupported',
  'not-permitted',
] as const);

export type GapCode = (typeof GAP_CODES)[number];
const codes: ReadonlySet<string> = new Set(GAP_CODES);
export const isGapCode = (value: unknown): value is GapCode => typeof value === 'string' && codes.has(value);
