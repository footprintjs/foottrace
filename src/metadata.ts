/** Bounded path-occurrence and captured-read metadata; never a replay source. */
export type {
  TraceMetadata,
  TraceMetadataScope,
  TraceMetadataPosition,
  TraceMetadataReadSet,
  TraceMetadataEntry,
  TraceMetadataCommit,
  TraceMetadataInput,
  TraceMetadataQuery,
  TraceMetadataAddress,
  TraceMetadataOccurrence,
  TraceMetadataEdge,
  TraceMetadataGapCode,
  TraceMetadataGap,
  TraceMetadataResult,
  TraceMetadataErrorCode,
} from './lib/metadata/types.js';
export { TraceMetadataError } from './lib/metadata/errors.js';
export { readTraceMetadata } from './lib/metadata/admission.js';
export { traceMetadata } from './lib/metadata/query.js';
