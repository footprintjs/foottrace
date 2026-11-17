import type { OpVerb } from '../deltaEncoding.js';
import type { CommitValuesMode, WriteProvenanceMode } from '../types.js';

/**
 * The two dials that shape a frame's bytes: the log's value encoding and the per-row read prefix.
 * Held by reference and swapped whole (`useEncoding`), never edited — the engine hands the run's
 * frozen policy itself. The nested-read mode is captured by `useEncoding` so a retained alias
 * cannot change the selected name encoding. Absent: `'full'` values and no read prefix.
 */
export interface RecordEncoding {
  readonly commitValues: CommitValuesMode;
  readonly writeProvenance: WriteProvenanceMode;
  /**
   * Canonical, addressed read prefixes from `readTracked` / `readWithSource`.
   * Default false keeps historical user-level dotted `noteRead` keys. Silent
   * `read` calls stay silent; this dial does not inspect objects or collect reads.
   */
  readonly nestedReadTracking?: boolean;
}

/**
 * What a stage can stage (law 7) — the transaction buffer's op verbs (`deltaEncoding.ts · OpVerb`), one
 * union. `append` is not one: it is how the log encodes a grown array (`'delta'`).
 */
export type WriteVerb = OpVerb;

/**
 * The bytes of a redaction verdict for one write (law 7): which of it the commit log and the redacted
 * mirror must not show. The engine decides it (`redaction.ts · decideWrite`); the frame only writes it.
 */
export interface WriteScrub {
  /** The whole value: `LOG_PLACEHOLDER` at the write's path. */
  readonly whole?: boolean;
  /** Dot-paths INSIDE the value, relative to it: `LOG_PLACEHOLDER` at each one that holds a value. */
  readonly fields?: readonly string[];
}
