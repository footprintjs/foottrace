/** Record-path decoding and safe nested writes. Values keep their existing merge law. */
export { normaliseStateKey, pathSegments } from './lib/memory/paths.js';
export { isDeniedSegment, nativeGet, nativeHas } from './lib/memory/pathOps.js';
export { setNestedValue, updateNestedValue } from './lib/memory/utils.js';
