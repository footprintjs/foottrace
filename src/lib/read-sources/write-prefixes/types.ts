import type { ReadSourceOwner } from '../types.js';

/** A native completed observation frontier, never expression-level derivation. */
export interface WriteReadPrefix extends ReadSourceOwner {
  readonly commitIdx: number;
  readonly rowIdx: number;
  readonly frame: number;
  readonly through: number;
  readonly count: number;
  readonly status: 'observed' | 'unavailable';
  readonly reason?: 'unsupported-write' | 'owner-unavailable' | 'redacted';
}
export interface WriteReadFrame extends ReadSourceOwner {
  readonly frame: number;
  readonly count: number;
  /** Actual native trace rows committed by this incarnation, including unsupported outputs. */
  readonly writes: number;
}
export interface WriteReadPrefixes {
  readonly version: 1;
  readonly status: 'captured' | 'partial';
  readonly frames: readonly WriteReadFrame[];
  readonly writes: readonly WriteReadPrefix[];
  /** Saturating omitted observations, not an exact count after saturation. */
  readonly omitted: number;
}
