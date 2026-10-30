import type { TraceMetadataErrorCode } from './types.js';

/** Fixed refusal: no stored names, values, URLs or exception text are repeated. */
export class TraceMetadataError extends Error {
  constructor(readonly code: TraceMetadataErrorCode = 'invalid-data') {
    super('TRACE_METADATA_UNAVAILABLE');
    this.name = 'TraceMetadataError';
  }
}
