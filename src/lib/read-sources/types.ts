import type { LogAddress } from '../memory/eventPosition.js';

/** Version 1 records root-key selections, never values or semantic derivation. */
export const READ_SOURCE_GAPS = [
  'composite-unsupported',
  'redacted',
  'untracked-write',
  'undefined-presence-unknown',
  'budget-exhausted',
  'capture-failed',
  'scope-retired',
] as const;
export type ReadSourceGap = (typeof READ_SOURCE_GAPS)[number];
export type ReadSource =
  | { readonly kind: 'base'; readonly base: number }
  | { readonly kind: 'committed'; readonly commitIdx: number }
  | { readonly kind: 'staged'; readonly frame: number; readonly generation: number }
  | { readonly kind: 'unavailable'; readonly reason: ReadSourceGap };
export interface ReadSourceOwner {
  readonly runtimeStageId: string;
  readonly attemptId?: string;
}
export type ReadSourceDisposition = 'active' | 'released' | 'discarded';
export interface ReadSourceOccurrence extends ReadSourceOwner {
  readonly ordinal: number;
  readonly attemptStatus: 'known' | 'unavailable';
  readonly frame?: number;
  readonly key: string;
  readonly stateAddress: readonly string[];
  readonly source: ReadSource;
  readonly disposition: ReadSourceDisposition;
}
export interface ReadSourceLimits {
  readonly maxOccurrences: number;
  readonly maxPerExecution: number;
  readonly maxBytes: number;
  readonly maxOrigins: number;
  readonly maxStaging: number;
}
export interface ReadSourceSnapshot {
  readonly version: 1;
  readonly address: LogAddress;
  readonly segment: number;
  readonly status: 'captured' | 'partial' | 'failed' | 'retired';
  readonly occurrences: readonly ReadSourceOccurrence[];
  readonly gaps: readonly { readonly reason: ReadSourceGap; readonly count: number; readonly exact: boolean }[];
  readonly limits: ReadSourceLimits;
}
