import type { GapCode } from '../evidence/codes.js';

/** Value-free occurrence evidence. None of these types is a replay source or a proven state effect. */
declare const metadataBrand: unique symbol;
export interface TraceMetadata {
  readonly kind: 'trace-metadata';
  readonly [metadataBrand]: true;
}
export interface TraceMetadataScope {
  readonly sourceId: string;
  readonly runId: string;
  readonly invocationId: string | null;
  readonly invocationPath?: readonly string[];
}
export interface TraceMetadataPosition {
  readonly commitIndex: number;
  readonly traceIndex: number;
}
export interface TraceMetadataReadSet {
  readonly keys: readonly string[];
  readonly before: TraceMetadataPosition;
  readonly kind: 'per-write' | 'stage';
}
export interface TraceMetadataEntry {
  readonly path: string;
  readonly verb?: 'set' | 'merge' | 'append' | 'delete';
  readonly reads?: TraceMetadataReadSet;
}
export interface TraceMetadataCommit {
  readonly stage: string;
  readonly stageId: string;
  readonly runtimeStageId: string;
  readonly phase?: 'exit' | 'repeat';
  readonly trace: readonly TraceMetadataEntry[];
}
export interface TraceMetadataInput {
  readonly scope: TraceMetadataScope;
  readonly commits: readonly TraceMetadataCommit[];
  readonly addressBasis: 'source-local' | 'projection-local';
  readonly originalCommitIndices?: readonly number[];
  readonly readsAvailable?: boolean;
  readonly startKeys?: readonly string[];
}
export interface TraceMetadataQuery {
  readonly scope: TraceMetadataScope;
  readonly key: string;
  readonly before: TraceMetadataPosition;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxEdges?: number;
  readonly maxWork?: number;
}
/** Every position belongs to result.scope. Mapped commit index does NOT map the local trace index. */
export interface TraceMetadataAddress extends TraceMetadataPosition {
  readonly basis: 'source-local' | 'projection-local';
  readonly originalCommitIndex?: number;
}
export interface TraceMetadataOccurrence {
  readonly address: TraceMetadataAddress;
  readonly stage: string;
  readonly stageId: string;
  readonly runtimeStageId: string;
  readonly phase?: 'exit' | 'repeat';
  readonly path: string;
  readonly verb?: 'set' | 'merge' | 'append' | 'delete';
  readonly reads: 'unknown' | 'captured-empty' | 'captured';
}
export interface TraceMetadataEdge {
  readonly kind: 'candidate-read';
  readonly from: TraceMetadataAddress;
  readonly to: TraceMetadataAddress;
  readonly key: string;
  readonly before: TraceMetadataPosition;
  readonly coverage: 'per-write' | 'stage';
}
export type TraceMetadataGapCode =
  | 'state-effect-unknown'
  | 'overlapping-operation'
  | 'origin-unknown'
  | 'reads-unknown'
  | 'stage-read-conservative'
  | 'ancestry-unknown'
  | 'original-address-unknown'
  | 'walk-incomplete';
export interface TraceMetadataGap {
  readonly code: TraceMetadataGapCode;
  readonly at?: TraceMetadataAddress;
  readonly key?: string;
  /** Fixed existing walker gap code only for walk-incomplete; not user text. */
  readonly reason?: GapCode;
}
export interface TraceMetadataResult {
  readonly kind: 'metadata';
  readonly scope: TraceMetadataScope;
  readonly key: string;
  readonly before: TraceMetadataPosition;
  readonly stateEffect: 'unknown';
  readonly complete: false;
  readonly latestExact?: TraceMetadataOccurrence;
  readonly selection: readonly TraceMetadataOccurrence[];
  readonly startKeyObserved: boolean;
  readonly nodes: readonly TraceMetadataOccurrence[];
  readonly edges: readonly TraceMetadataEdge[];
  readonly gaps: readonly TraceMetadataGap[];
}
export type TraceMetadataErrorCode =
  | 'invalid-data'
  | 'scope-mismatch'
  | 'invalid-handle'
  | 'work-limit'
  | 'node-limit'
  | 'edge-limit';
