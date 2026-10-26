import type { ControlDependency } from '../memory/backtrack.js';
import type { LogAddress } from '../memory/eventPosition.js';
import type { CommitBundle } from '../memory/types.js';
import type { PreparedReadSources, RecordReadSources } from './recordSources.js';
import type { Adjacency, Attention, CauseGraph, Gap, GraphContext, NodeId } from './types.js';

/** Explicit complete maps record absence too; an omitted map means it was not collected. */
export interface RecordScope {
  readonly address: LogAddress;
  readonly commitLog: readonly unknown[];
  readonly initialState?: Record<string, unknown>;
  readonly readSources?: RecordReadSources;
  readonly reads?: Readonly<Record<string, readonly string[]>>;
  readonly controlDeps?: Readonly<Record<string, { readonly deciderId: string }>>;
  readonly attention?: Readonly<Record<string, readonly Attention[]>>;
  readonly complete?: boolean;
}
export interface RecordNode {
  readonly runtimeStageId: string;
  readonly commitIdx?: number;
  readonly key?: string;
}
export interface RecordGraphOptions {
  readonly maxCommits?: number;
  readonly maxFields?: number;
  readonly maxEdges?: number;
  readonly maxScopes?: number;
  readonly loadTimeoutMs?: number;
}
export interface RecordCauseGraph extends CauseGraph {
  nodeId(address: LogAddress, node: RecordNode): NodeId;
  /** Rejects with fixed message/code on discovery failure; never reports an unavailable scope as empty. */
  openScope(address: LogAddress, context: GraphContext): Promise<readonly NodeId[]>;
}
export interface RecordLoaderResult {
  readonly scope: RecordScope;
  readonly gaps?: readonly Gap['code'][];
}
export interface RecordIdentity extends RecordNode {
  readonly address: LogAddress;
  readonly read?: true;
}
export interface PreparedRecordScope {
  address: LogAddress;
  log: CommitBundle[];
  reads?: Map<string, string[]>;
  control?: Map<string, ControlDependency>;
  marks?: Map<string, readonly Attention[]>;
  complete: boolean;
  readSources?: PreparedReadSources;
  sourceCoveredExecutions?: ReadonlySet<string>;
}
export interface RecordLoadFailure {
  failure: Gap['code'];
}
export type LoadedRecordScope = PreparedRecordScope | RecordLoadFailure;
export interface ResolvedRecordNode {
  scope: PreparedRecordScope;
  identity: RecordIdentity;
  commitIndex: number;
}
export interface RecordInspection {
  adjacency: Adjacency;
  gaps: readonly Gap[];
}
export type RecordScopeHost = (
  address: LogAddress,
  context: GraphContext,
) => RecordLoaderResult | Promise<RecordLoaderResult>;
export interface RecordScopeLoader {
  loadScope(address: LogAddress, context: GraphContext): Promise<LoadedRecordScope>;
  extraGapCodes(scope: PreparedRecordScope): readonly Gap['code'][] | undefined;
}
export type AddRecordGap = (code: Gap['code']) => void;
