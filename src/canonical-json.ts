/** Strict bounded canonical JSON; separate from record replay and optional crypto. */
export { canonicalizeJson } from './lib/canonical-json/canonical.js';
export { CanonicalJsonError } from './lib/canonical-json/types.js';
export type { CanonicalJsonErrorCode, CanonicalJsonOptions, JsonValue } from './lib/canonical-json/types.js';
export { CANONICAL_JSON_DEFAULTS, CANONICAL_JSON_CEILINGS } from './lib/canonical-json/limits.js';
