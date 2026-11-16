import type { GapCode } from '../../evidence/codes.js';
import type { LogAddress } from '../../memory/eventPosition.js';

export type RecordOutputLimitation =
  | 'explicit-output'
  | 'privacy-active'
  | 'budget-exhausted'
  | 'output-mutated'
  | 'commit-time-read';
export type RecordInputLimitation =
  | 'privacy-active'
  | 'budget-exhausted'
  | 'parent-log-advanced'
  | 'resume-seed'
  | 'commit-time-read'
  | 'selector-reads-unavailable';
export type RecordFanoutLimitation =
  | 'privacy-active'
  | 'budget-exhausted'
  | 'branches-truncated'
  | 'missing-child-record'
  | 'explicit-output'
  | 'failed-slot';

/** Prefix membership records possible use, never semantic derivation. Reads are literal root names. */
export interface RecordHandoffWrite {
  readonly path: string;
  readonly reads: readonly string[];
}
export interface RecordOutputHandoff {
  readonly version: 1;
  readonly attribution: 'observed-read-prefix';
  readonly parent: { readonly address: LogAddress; readonly runtimeStageId: string; readonly commitIdx: number };
  readonly child: { readonly address: LogAddress; readonly beforeCommitIdx: number };
  readonly writes: readonly RecordHandoffWrite[];
  readonly status: 'captured' | 'partial';
  readonly limitations: readonly RecordOutputLimitation[];
}
export interface RecordInputHandoff {
  readonly version: 1;
  readonly attribution: 'observed-read-prefix';
  readonly parent: { readonly address: LogAddress; readonly beforeCommitIdx: number };
  readonly child: { readonly address: LogAddress; readonly runtimeStageId: string; readonly commitIdx: number };
  readonly writes: readonly RecordHandoffWrite[];
  readonly status: 'captured' | 'partial';
  readonly limitations: readonly RecordInputLimitation[];
}
export interface RecordFanoutCollection {
  readonly version: 1;
  readonly attribution: 'observed-scope-collection';
  readonly parent: {
    readonly address: LogAddress;
    readonly runtimeStageId: string;
    readonly commitIdx: number;
    readonly path: string;
  };
  readonly totalItems: number;
  readonly branchCount: number;
  readonly slots: readonly {
    readonly index: number;
    readonly child: { readonly address: LogAddress; readonly beforeCommitIdx: number };
    readonly observation: 'scope-snapshot' | 'explicit-output' | 'failed-slot';
  }[];
  readonly status: 'captured' | 'partial';
  readonly limitations: readonly RecordFanoutLimitation[];
}
export interface RecordSubflowMount {
  readonly runtimeStageId: string;
  readonly child: LogAddress;
  readonly inputHandoff?: RecordInputHandoff;
  readonly outputHandoff?: RecordOutputHandoff;
}
/** Captured is a host's finite supplied-scope inventory assertion, not a whole-run certificate. */
export interface RecordSubflows {
  readonly version: 1;
  readonly status: 'captured' | 'partial';
  readonly mounts: readonly RecordSubflowMount[];
  readonly collections: readonly RecordFanoutCollection[];
}
export interface PreparedRecordSubflows {
  readonly record?: RecordSubflows;
  readonly gaps: readonly GapCode[];
}
