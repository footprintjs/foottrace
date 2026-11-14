import type { LogAddress } from '../memory/eventPosition.js';
import type { RecordSink } from '../memory/sink.js';
import type { RegisteredCode } from '../memory/honesty.js';

/** Host-bound lookup identity, not producer authentication or authorization from file contents. */
export interface ObservationSubject {
  readonly nativeAddress: LogAddress;
  readonly runId: string;
  readonly runtimeStageId: string;
  readonly attemptId?: string;
  readonly operationRef: string;
}
export interface ObservationInput {
  readonly event: string;
  readonly observedAt?: { readonly clock: string; readonly elapsedMs: number };
  readonly facts?: Readonly<Record<string, string | number | boolean | null>>;
}
export interface ObservationRow extends ObservationInput {
  readonly sequence: number;
  readonly evidenceRef: string;
}
export interface ObservationLimits {
  readonly maxRows?: number;
  readonly maxBytes?: number;
  readonly maxRowBytes?: number;
}
export type ObservationOmission = RegisteredCode<'invalid-data' | 'row-limit' | 'byte-limit'>;
export type ObservationGapCode = RegisteredCode<
  | 'not-collected'
  | 'unsupported-version'
  | 'invalid-data'
  | 'scope-mismatch'
  | 'incomplete-record'
  | 'missing-note'
  | 'duplicate-sequence'
  | 'count-mismatch'
  | 'omitted'
  | 'row-limit'
  | 'byte-limit'
  | 'unread-entry'
>;
export interface ObservationGap {
  readonly code: ObservationGapCode;
  readonly sequence?: number;
}
export interface ObservationEvidence {
  readonly status: 'collected' | 'partial' | 'not-collected';
  readonly authenticity: 'unverified';
  readonly subjectBinding: 'matched' | 'unmatched';
  readonly rows: readonly ObservationRow[];
  readonly gaps: readonly ObservationGap[];
}
export interface ObservationWriter {
  /** Accepted for EventLog dispatch only; never a promise of durable storage or external delivery. */
  note(
    input: unknown,
  ):
    | { readonly status: 'noted'; readonly sequence: number }
    | { readonly status: 'omitted'; readonly reason: ObservationOmission | 'closed' };
  /** Once only. A later callback cannot change the sealed observation cut. */
  close(): void;
}
export interface ObservationRecordOptions {
  readonly sink: RecordSink;
  readonly address: LogAddress;
  readonly subject: ObservationSubject;
  readonly limits?: ObservationLimits;
}
export interface ObservationReadRequest {
  readonly address: LogAddress;
  readonly subject: ObservationSubject;
  readonly limits?: ObservationLimits;
}
export type ObservationErrorCode = 'invalid-options' | 'invalid-data' | 'byte-limit';
/** Fixed refusal text; never includes payloads, callback errors, private names or provider messages. */
export class ObservationError extends Error {
  constructor(readonly code: ObservationErrorCode) {
    super('Observation record refused: ' + code);
    this.name = 'ObservationError';
  }
}
