import type { LogAddress } from './eventPosition.js';
import type { RegisteredCode } from './honesty.js';
import type { CommitBundle } from './types.js';

/** The host supplies the tree and log of one root recording, together. */
export interface UnchangedWriteRecording {
  readonly commitLog: readonly CommitBundle[];
  readonly executionTree?: unknown;
  readonly runId: string;
  readonly logAddress: LogAddress;
  readonly capture?: unknown;
  readonly captureWitness?: unknown;
}

export interface UnchangedWrite {
  /** Array position of the stage's matched commit. */
  readonly commitIdx: number;
  readonly runtimeStageId: string;
  readonly stageId: string;
  readonly readKeys: readonly string[];
}

export type UnchangedWriteGapReason =
  | 'ambiguous-key'
  | 'child-namespace'
  | 'repeated-stage'
  | 'scope-mismatch'
  | 'redacted'
  | 'tracking-unverified'
  | 'write-bag-missing'
  | 'tracking-disabled'
  | 'malformed'
  | 'commit-gap'
  | 'window-incomplete'
  | 'undefined-write';

export interface UnchangedWriteGap {
  readonly code: RegisteredCode<
    'not-collected' | 'scope-mismatch' | 'redacted' | 'invalid-data' | 'incomplete-record' | 'concurrent-write'
  >;
  readonly reason: UnchangedWriteGapReason;
  readonly commitIdx?: number;
}

export interface UnchangedWriteResult {
  readonly writes: readonly UnchangedWrite[];
  readonly gaps: readonly UnchangedWriteGap[];
}
