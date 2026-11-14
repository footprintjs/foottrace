import type { JsonValue } from '../canonical-json/types.js';

export const VALUE_TABLE_FORMAT = 'foottrace.values.v1';
export const VALUE_RECORD_FORMAT = 'foottrace.value-record.v1';
export const VALUE_OMISSION_REASONS = Object.freeze([
  'entry-limit',
  'byte-limit',
  'attempt-limit',
  'concurrency-limit',
  'digest-budget',
  'value-limit',
  'invalid-value',
  'invalid-label',
  'redaction-failed',
  'crypto-unavailable',
  'digest-failed',
  'digest-timeout',
  'digest-collision',
] as const);
export type ValueOmissionReason = (typeof VALUE_OMISSION_REASONS)[number];
export interface ValueReference {
  readonly ref: string;
}
export interface ValueTableEntry {
  readonly id: string;
  readonly label: string;
  readonly value: JsonValue;
}
export interface ValueTableSnapshot {
  readonly format: typeof VALUE_TABLE_FORMAT;
  readonly entries: readonly ValueTableEntry[];
  readonly bytes: number;
  readonly attempts: number;
  readonly pending: number;
  readonly omissions: Readonly<Record<ValueOmissionReason, number>>;
  /** A saturated count is a lower bound, never an exact count beyond MAX_SAFE_INTEGER. */
  readonly atLeast: boolean;
}
export interface ValueRecord<T = unknown> {
  readonly format: typeof VALUE_RECORD_FORMAT;
  readonly record: T;
  readonly valueTable: ValueTableSnapshot;
}
export interface ValueTableLimits {
  readonly maxEntries: number;
  /** Sum of retained canonical VALUE bytes, not the whole envelope or labels. */
  readonly maxBytes: number;
  readonly maxValueBytes: number;
  readonly maxAttempts: number;
  readonly maxDigestBytes: number;
  readonly maxInFlight: number;
  readonly digestTimeoutMs: number;
}
export interface ValueTableOptions {
  /** The SAME serving/redaction law used for inline values. Called before admission or hashing. */
  readonly redact: (value: unknown) => unknown;
  readonly limits?: Partial<ValueTableLimits>;
}
export type ValueWriteResult =
  | { readonly status: 'stored'; readonly reference: ValueReference; readonly reused: boolean }
  | { readonly status: 'omitted'; readonly reason: ValueOmissionReason };
export interface ValueTableWriter {
  intern(label: string, value: unknown): Promise<ValueWriteResult>;
  snapshot(): ValueTableSnapshot;
  /** Only completed writes are included; pending counts disclose an unfinished export. Payload stays caller-owned. */
  record<T>(record: T): ValueRecord<T>;
}
export interface ValueTableReader {
  readonly snapshot: ValueTableSnapshot;
  /** Resolve an explicitly typed reference position. Stored literal {ref:...} data is never recursively decoded. */
  resolve(reference: unknown): JsonValue;
}
export interface OpenValueRecord {
  readonly record: unknown;
  readonly values?: ValueTableReader;
}
export type ValueTableErrorCode =
  | 'invalid-options'
  | 'invalid-table'
  | 'invalid-record'
  | 'invalid-reference'
  | 'unsupported-format'
  | 'table-limit'
  | 'digest-mismatch'
  | 'dangling-reference'
  | 'crypto-unavailable'
  | 'digest-failed'
  | 'digest-timeout';
const errorCodes: readonly string[] = [
  'invalid-options',
  'invalid-table',
  'invalid-record',
  'invalid-reference',
  'unsupported-format',
  'table-limit',
  'digest-mismatch',
  'dangling-reference',
  'crypto-unavailable',
  'digest-failed',
  'digest-timeout',
];
/** Named refusal with fixed text; no label, payload, path or caught exception text. */
export class ValueTableError extends Error {
  readonly code: ValueTableErrorCode;
  constructor(code: ValueTableErrorCode) {
    const safe = errorCodes.includes(code) ? code : 'invalid-table';
    super('Value table refused: ' + safe);
    this.code = safe;
    this.name = 'ValueTableError';
  }
}
export function valueFailure(error: unknown): ValueTableError {
  let code: ValueTableErrorCode = 'invalid-table';
  try {
    const own =
      error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    if (own && 'value' in own && typeof own.value === 'string' && errorCodes.includes(own.value))
      code = own.value as ValueTableErrorCode;
  } catch {
    /* Never invoke a thrown object's accessor or expose a second thrown value. */
  }
  return new ValueTableError(code);
}
