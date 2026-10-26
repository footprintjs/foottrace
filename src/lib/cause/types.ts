import type { GapCode } from '../evidence/codes.js';
export type { GapCode } from '../evidence/codes.js';

/** Names and evidence references only. No state values, messages, credentials or business payloads. */
export type NodeId = string;
export type AttentionKind =
  | 'error'
  | 'unknown-effect'
  | 'gave-up'
  | 'timeout'
  | 'retried'
  | 'quality-drop'
  | 'not-collected'
  | 'outlier'
  | (string & {});
export type AttentionReason =
  | 'ERROR_RECORDED'
  | 'UNKNOWN_EFFECT_RECORDED'
  | 'RETRY_STOP_RECORDED'
  | 'TIMEOUT_RECORDED'
  | 'RETRY_RECORDED'
  | 'QUALITY_DROP_RECORDED'
  | 'EVIDENCE_NOT_COLLECTED'
  | 'OUTLIER_RECORDED'
  | 'BUSINESS_RULE_MATCHED';
export interface Attention {
  readonly kind: AttentionKind;
  readonly reason: AttentionReason;
  readonly evidence: readonly string[];
}
export type Confidence = 'complete' | 'incomplete';
export interface Gap {
  readonly code: GapCode;
  readonly nodeId?: NodeId;
  readonly evidence: readonly string[];
}
export interface GraphEdge {
  readonly nodeId: NodeId;
  readonly kind: 'data' | 'control';
  readonly attribution: 'per-write' | 'stage' | 'recorded-control' | 'recorded-read';
  readonly evidence: readonly string[];
}
export interface Adjacency {
  readonly edges: readonly GraphEdge[];
  readonly complete: boolean;
}
export interface GraphContext {
  readonly signal: AbortSignal;
}
export type MaybePromise<T> = T | Promise<T>;
/** A host owns storage, authentication and service resolution. A node may represent a key-qualified write. */
export interface CauseGraph {
  parents(id: NodeId, context: GraphContext): MaybePromise<Adjacency>;
  children(id: NodeId, context: GraphContext): MaybePromise<Adjacency>;
  attention(id: NodeId, context: GraphContext): MaybePromise<readonly Attention[]>;
  gaps(id: NodeId, context: GraphContext): MaybePromise<readonly Gap[]>;
  /** Optional, bounded discovery seeds; attentionList can instead receive explicit nodeIds. */
  roots?(context: GraphContext): MaybePromise<readonly NodeId[]>;
}
export interface TraversedEdge extends Omit<GraphEdge, 'nodeId'> {
  readonly from: NodeId;
  readonly to: NodeId;
}
export interface MarkedNode {
  readonly nodeId: NodeId;
  readonly attention: readonly Attention[];
}
export interface ImpactResult {
  readonly nodes: readonly NodeId[];
  readonly edges: readonly TraversedEdge[];
  readonly confidence: Confidence;
  readonly gaps: readonly Gap[];
}
export interface CauseResult {
  readonly nodeId: NodeId;
  readonly attention: readonly Attention[];
  /** Present only for one supported candidate and complete backward coverage. Not provider-internal proof. */
  readonly rootCause?: NodeId;
  /** Selected node → candidate, following recorded dependency edges. */
  readonly path: readonly NodeId[];
  readonly alternatives: readonly NodeId[];
  readonly impact: ImpactResult;
  readonly confidence: Confidence;
  readonly gaps: readonly Gap[];
}
export interface AttentionListResult {
  readonly nodes: readonly MarkedNode[];
  readonly confidence: Confidence;
  readonly gaps: readonly Gap[];
}
/** Optional per-direction work allowances; the enclosing query still owns the deadline and total ceiling. */
export interface TraversalLimits {
  readonly maxNodes?: number;
  readonly maxDepth?: number;
  readonly maxEdges?: number;
  readonly maxCalls?: number;
}
export interface WalkLimits extends TraversalLimits {
  readonly timeoutMs?: number;
}
/** A strategy selects a tied best tier of already recorded marked nodes; it cannot introduce identities. */
export type RootStrategy = (
  candidates: readonly MarkedNode[],
  context: GraphContext,
) => MaybePromise<readonly NodeId[]>;
/** Reorder all already discovered impact references; never inject or drop evidence. */
export type ImpactStrategy = (nodes: readonly NodeId[], context: GraphContext) => MaybePromise<readonly NodeId[]>;
export interface ExplainOptions extends WalkLimits {
  /** Caps backward traversal and root ranking, without adding to the enclosing query budget. */
  readonly backward?: TraversalLimits;
  /** Caps forward traversal and impact ranking; shared cached reads do not consume another call. */
  readonly impact?: TraversalLimits;
  readonly signal?: AbortSignal;
  readonly rankRoots?: RootStrategy;
  readonly rankImpact?: ImpactStrategy;
}
export interface AttentionListOptions extends WalkLimits {
  readonly signal?: AbortSignal;
  readonly nodeIds?: readonly NodeId[];
}
