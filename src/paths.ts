/** Record-path decoding and safe nested writes. Values keep their existing merge law. */
export { DELIM as STATE_PATH_SEPARATOR, normaliseStateKey, pathSegments } from './lib/record-paths/codec.js';
export { isDeniedSegment, nativeGet, nativeHas } from './lib/memory/pathOps.js';
export { setNestedValue, updateNestedValue } from './lib/memory/utils.js';
