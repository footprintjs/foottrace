/** One vocabulary; true marks a domain evidence reason, false a trace/admission gap only. */
export const GAP_CODES = Object.freeze({
  'not-collected': true,
  'untracked-input': false,
  redacted: true,
  conservative: false,
  'scope-boundary': false,
  'invalid-data': true,
  unavailable: true,
  timeout: true,
  cancelled: false,
  cycle: false,
  'node-limit': false,
  'depth-limit': false,
  'edge-limit': false,
  'call-limit': false,
  truncated: false,
  'strategy-failed': false,
  'not-checked': true,
  'no-match': true,
  ambiguous: true,
  stale: true,
  incompatible: true,
  unsupported: true,
  'not-permitted': true,
} as const);

export type GapCode = keyof typeof GAP_CODES;
/** Producer-asserted evidence reasons, excluding traversal and admission bounds. */
export type RequirementReason = { [Code in GapCode]: (typeof GAP_CODES)[Code] extends true ? Code : never }[GapCode];
export const isGapCode = (value: unknown): value is GapCode =>
  typeof value === 'string' && Object.hasOwn(GAP_CODES, value);
export const isRequirementReason = (value: unknown): value is RequirementReason => isGapCode(value) && GAP_CODES[value];
